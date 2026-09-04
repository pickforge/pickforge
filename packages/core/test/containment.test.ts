import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONTAINMENT_TOKEN_ENV,
  buildContainedCommand,
  containmentEnv,
  createContainmentScope,
  destroyContainmentScope,
  ensureContainmentScope,
  isPidAlive,
  listContainedProcesses,
  listProcessGroupMembers,
  processCarriesToken,
  readOwnCgroupPath,
  scopeCgroupProblem,
  type ContainmentScope,
} from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// The repo's test runtime; workers are TypeScript run directly.
const BUN = /[\\/]bun$/.test(process.execPath) ? process.execPath : "bun";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-containment-"));
const strays = new Set<number>();

// Whether this host delegates a cgroup to us. Cgroup-only tests skip
// explicitly (visible in the run summary) rather than passing silently, and
// the mechanism the runner selected is printed so CI logs record it.
const probe = createContainmentScope({ id: "desk-probe" });
const cgroupAvailable = probe.mechanism === "cgroup";
await destroyContainmentScope(probe, { termTimeoutMs: 100, killTimeoutMs: 100 });
console.log(
  `[containment] mechanism available on this host: ${probe.mechanism}` +
    (cgroupAvailable ? ` (${path.dirname(probe.cgroupDir as string)})` : ""),
);
const itWithCgroup = it.skipIf(!cgroupAvailable);

/**
 * The escape this module exists to stop: a script that `setsid`s a grandchild
 * into its own session and process group, then exits. The grandchild is not
 * reachable by any signal aimed at the original process group.
 */
function writeEscapingScript(name: string, pidFile: string): string {
  const script = path.join(root, name);
  fs.writeFileSync(
    script,
    [
      "#!/bin/sh",
      `setsid /bin/sh -c 'echo $$ > "${pidFile}"; exec /bin/sleep 300' &`,
      "sleep 300",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return script;
}

function spawnInScope(
  scope: ContainmentScope,
  command: string,
  args: string[] = [],
): number {
  const target =
    scope.mechanism === "cgroup"
      ? buildContainedCommand(process.execPath, scope, command, args)
      : { command, args };
  const child = spawn(target.command, target.args, {
    env: { ...process.env, ...containmentEnv(scope) },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const pid = child.pid;
  if (pid === undefined) throw new Error("spawn produced no pid");
  strays.add(pid);
  return pid;
}

/** Start a command under the containment supervisor whatever the mechanism. */
function spawnSupervised(
  scope: ContainmentScope,
  command: string,
  args: string[] = [],
): number {
  const target = buildContainedCommand(process.execPath, scope, command, args);
  const child = spawn(target.command, target.args, {
    env: { ...process.env, ...containmentEnv(scope) },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const pid = child.pid;
  if (pid === undefined) throw new Error("spawn produced no pid");
  strays.add(pid);
  return pid;
}

interface Finished {
  code: number | null;
  stderr: string;
}

function finish(child: ChildProcess): Promise<Finished> {
  return new Promise((resolve) => {
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("close", (code) => resolve({ code, stderr }));
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

function readPidFile(pidFile: string): number | undefined {
  try {
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Current members of a scope cgroup. An *empty* scope can be pruned by a
 * concurrent `createContainmentScope` (another test file in another worker)
 * and is re-created by the supervisor when it joins, so a momentarily missing
 * directory reads as "no members yet" rather than an error.
 */
function cgroupMembers(scope: ContainmentScope): number[] {
  try {
    return fs
      .readFileSync(path.join(scope.cgroupDir as string, "cgroup.procs"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Block until a pid is a zombie or gone, without yielding to the event loop. */
function waitSyncUntilExited(pid: number, realRead: typeof fs.readFileSync): void {
  const deadline = Date.now() + 2_000;
  const cell = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    let stat: string;
    try {
      stat = realRead.call(fs, `/proc/${pid}/stat`, "utf8") as string;
    } catch {
      return;
    }
    const state = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[0];
    if (state === "Z") return;
    Atomics.wait(cell, 0, 0, 5);
  }
  throw new Error(`pid ${pid} did not exit in time`);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const pid of strays) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  strays.clear();
});

describe("containment scope creation", () => {
  it("always produces a usable scope, even without a delegated cgroup", async () => {
    const scope = createContainmentScope({ id: "desk-test01" });
    expect(scope.token).toMatch(/^[0-9a-f]{64}$/);
    expect(["cgroup", "marker"]).toContain(scope.mechanism);
    if (scope.mechanism === "cgroup") {
      expect(scope.cgroupDir).toMatch(/^\/sys\/fs\/cgroup\//);
      expect(fs.existsSync(scope.cgroupDir as string)).toBe(true);
      expect(scopeCgroupProblem(scope.cgroupDir as string)).toBeUndefined();
    }
    await destroyContainmentScope(scope);
  });

  it("forces the marker mechanism when asked", () => {
    const scope = createContainmentScope({ id: "desk-test02", useCgroup: false });
    expect(scope.mechanism).toBe("marker");
    expect(scope.cgroupDir).toBeUndefined();
  });

  it("reads its own cgroup path as an absolute path or nothing at all", () => {
    const own = readOwnCgroupPath();
    if (own !== undefined) expect(own.startsWith("/")).toBe(true);
  });

  it("gives every scope a distinct token", () => {
    const a = createContainmentScope({ id: "desk-test03", useCgroup: false });
    const b = createContainmentScope({ id: "desk-test03", useCgroup: false });
    expect(a.token).not.toBe(b.token);
  });
});

describe("containment cleanup of daemonising descendants", () => {
  it("kills a setsid escapee that left the process group (marker)", async () => {
    const scope = createContainmentScope({ id: "desk-esc01", useCgroup: false });
    const pidFile = path.join(root, "escapee-marker.pid");
    const leader = spawnInScope(scope, writeEscapingScript("escape-marker.sh", pidFile));

    expect(await waitFor(() => readPidFile(pidFile) !== undefined)).toBe(true);
    const escapee = readPidFile(pidFile) as number;
    strays.add(escapee);
    // The escapee really is outside the launched process group: this is the
    // hole a group kill alone leaves open.
    expect(await waitFor(() => isPidAlive(escapee))).toBe(true);
    expect(listProcessGroupMembers(leader)).not.toContain(escapee);

    const result = await destroyContainmentScope(scope);
    expect(result.confirmed).toBe(true);
    expect(result.survivors).toEqual([]);
    expect(result.signaled).toContain(escapee);
    expect(isPidAlive(escapee)).toBe(false);
    expect(isPidAlive(leader)).toBe(false);
    expect(listContainedProcesses(scope.token)).toEqual([]);
  }, 30_000);

  itWithCgroup("kills a setsid escapee through the cgroup", async () => {
    const scope = createContainmentScope({ id: "desk-esc02" });
    expect(scope.mechanism).toBe("cgroup");
    const pidFile = path.join(root, "escapee-cgroup.pid");
    const leader = spawnInScope(scope, writeEscapingScript("escape-cgroup.sh", pidFile));
    expect(await waitFor(() => readPidFile(pidFile) !== undefined)).toBe(true);
    const escapee = readPidFile(pidFile) as number;
    strays.add(escapee);

    // Membership, not pid arithmetic, is what proves ownership.
    const members = cgroupMembers(scope);
    expect(members).toContain(escapee);
    expect(members).toContain(leader);

    const result = await destroyContainmentScope(scope);
    expect(result.confirmed).toBe(true);
    expect(isPidAlive(escapee)).toBe(false);
    expect(fs.existsSync(scope.cgroupDir as string)).toBe(false);
  }, 30_000);

  it("escalates to SIGKILL for a contained process that ignores SIGTERM", async () => {
    const scope = createContainmentScope({ id: "desk-esc05", useCgroup: false });
    // SIG_IGN survives exec, so the sleep itself ignores SIGTERM.
    const pid = spawnInScope(scope, "/bin/sh", ["-c", 'trap "" TERM; exec /bin/sleep 300']);
    expect(await waitFor(() => listContainedProcesses(scope.token).length > 0)).toBe(
      true,
    );

    const started = Date.now();
    const result = await destroyContainmentScope(scope, {
      termTimeoutMs: 300,
      killTimeoutMs: 2_000,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(result.confirmed).toBe(true);
    expect(result.signaled).toContain(pid);
    expect(result.survivors).toEqual([]);
    expect(isPidAlive(pid)).toBe(false);
  }, 20_000);

  it("confirms cleanup of a scope that never started anything", async () => {
    const scope = createContainmentScope({ id: "desk-esc03", useCgroup: false });
    const result = await destroyContainmentScope(scope);
    expect(result).toMatchObject({
      mechanism: "marker",
      confirmed: true,
      signaled: [],
      survivors: [],
      refused: [],
    });
  });

  it("is idempotent: a second cleanup still confirms", async () => {
    const scope = createContainmentScope({ id: "desk-esc04", useCgroup: false });
    spawnInScope(scope, "/bin/sleep", ["300"]);
    expect(await waitFor(() => listContainedProcesses(scope.token).length > 0)).toBe(
      true,
    );
    expect((await destroyContainmentScope(scope)).confirmed).toBe(true);
    const second = await destroyContainmentScope(scope);
    expect(second.confirmed).toBe(true);
    expect(second.signaled).toEqual([]);
  }, 20_000);
});

describe("containment refuses to signal anything it does not own", () => {
  it("leaves an unrelated process of the same user alone", async () => {
    const scope = createContainmentScope({ id: "desk-safe01", useCgroup: false });
    const bystander = spawn("/bin/sleep", ["300"], {
      detached: true,
      stdio: "ignore",
    });
    bystander.unref();
    const bystanderPid = bystander.pid as number;
    strays.add(bystanderPid);
    spawnInScope(scope, "/bin/sleep", ["300"]);
    expect(await waitFor(() => listContainedProcesses(scope.token).length > 0)).toBe(
      true,
    );

    const result = await destroyContainmentScope(scope);
    expect(result.confirmed).toBe(true);
    expect(result.signaled).not.toContain(bystanderPid);
    expect(isPidAlive(bystanderPid)).toBe(true);
  }, 20_000);

  it("does not see a process carrying a different scope's token", async () => {
    const mine = createContainmentScope({ id: "desk-safe02", useCgroup: false });
    const other = createContainmentScope({ id: "desk-safe03", useCgroup: false });
    const pid = spawnInScope(other, "/bin/sleep", ["300"]);
    expect(await waitFor(() => listContainedProcesses(other.token).length > 0)).toBe(
      true,
    );

    expect(listContainedProcesses(mine.token)).not.toContain(pid);
    const result = await destroyContainmentScope(mine);
    expect(result.signaled).toEqual([]);
    expect(isPidAlive(pid)).toBe(true);
    await destroyContainmentScope(other);
  }, 20_000);

  it("never signals the process performing the cleanup or its ancestors (marker)", async () => {
    const scope = createContainmentScope({ id: "desk-safe04", useCgroup: false });
    const report = path.join(root, "self-exclusion-marker.json");
    const worker = path.join(here, "workers", "containment-self-worker.ts");
    // The worker itself carries the token, so a sweep that did not exclude the
    // caller's own process chain would kill it before it could report.
    const child = spawn(BUN, [worker, JSON.stringify(scope), report], {
      env: { ...process.env, ...containmentEnv(scope) },
      stdio: ["ignore", "ignore", "pipe"],
    });
    strays.add(child.pid as number);
    const { code, stderr } = await finish(child);

    expect(code, stderr).toBe(0);
    const written = JSON.parse(fs.readFileSync(report, "utf8"));
    expect(written.survived).toBe(true);
    expect(written.result.confirmed).toBe(true);
  }, 30_000);

  itWithCgroup(
    "survives destroying its own scope from inside the cgroup, and still empties it",
    async () => {
      const scope = createContainmentScope({ id: "desk-inside01" });
      expect(scope.mechanism).toBe("cgroup");
      const victim = spawnInScope(scope, "/bin/sleep", ["300"]);
      expect(await waitFor(() => cgroupMembers(scope).includes(victim))).toBe(true);

      // The worker is started *through the supervisor*, so it and its
      // supervisor are cgroup members exactly like `session destroy` typed into
      // a `desktop exec xterm` would be. A cgroup.kill that did not move the
      // caller's chain out first would kill the worker before it could report.
      const report = path.join(root, "self-exclusion-cgroup.json");
      const worker = path.join(here, "workers", "containment-self-worker.ts");
      const built = buildContainedCommand(process.execPath, scope, BUN, [
        worker,
        JSON.stringify(scope),
        report,
      ]);
      const child = spawn(built.command, built.args, {
        env: { ...process.env, ...containmentEnv(scope) },
        stdio: ["ignore", "ignore", "pipe"],
      });
      strays.add(child.pid as number);
      const { code, stderr } = await finish(child);

      expect(code, stderr).toBe(0);
      const written = JSON.parse(fs.readFileSync(report, "utf8"));
      expect(written.survived).toBe(true);
      expect(written.result).toMatchObject({
        mechanism: "cgroup",
        confirmed: true,
        survivors: [],
        refused: [],
      });
      expect(written.result.signaled).not.toContain(written.pid);
      expect(written.result.signaled).not.toContain(child.pid);
      expect(isPidAlive(victim)).toBe(false);
      expect(fs.existsSync(scope.cgroupDir as string)).toBe(false);
      expect(listContainedProcesses(scope.token)).toEqual([]);
    },
    30_000,
  );

  it("never writes cgroup.kill to the cgroup the lab itself runs in", async () => {
    const own = readOwnCgroupPath();
    const ownDir =
      own === undefined ? undefined : path.resolve(path.join("/sys/fs/cgroup", own));
    if (ownDir === undefined || path.basename(ownDir).startsWith("pickforge-")) {
      // No readable cgroup, or the tests themselves run inside a scope: the
      // static check below is what protects that case, and it is covered by
      // the tampered-path tests.
      expect(scopeCgroupProblem("/sys/fs/cgroup/user.slice")).toBeDefined();
      return;
    }
    // A tampered record naming the delegated parent (where this process, its
    // shell and unrelated user processes live) must be refused outright.
    const result = await destroyContainmentScope(
      { token: "6".repeat(64), mechanism: "cgroup", cgroupDir: ownDir },
      { termTimeoutMs: 200, killTimeoutMs: 200 },
    );
    expect(result.confirmed).toBe(false);
    expect(result.reason).toMatch(/refusing cgroup cleanup/);
    expect(result.signaled).toEqual([]);
  });
});

describe("containment identity safety", () => {
  it("reports no token for a pid that has exited", async () => {
    const scope = createContainmentScope({ id: "desk-id01", useCgroup: false });
    const pid = spawnInScope(scope, "/bin/sleep", ["300"]);
    expect(await waitFor(() => processCarriesToken(pid, scope.token))).toBe(true);
    process.kill(pid, "SIGKILL");
    expect(await waitFor(() => !isPidAlive(pid))).toBe(true);

    // A dead pid carries nothing, so it can never be selected for a signal:
    // this is what stops a recycled pid being killed on a stale record.
    expect(processCarriesToken(pid, scope.token)).toBe(false);
    const result = await destroyContainmentScope(scope);
    expect(result.signaled).not.toContain(pid);
    expect(result.confirmed).toBe(true);
  }, 20_000);

  it("treats a target that exited between the scan and the re-read as gone, not refused", async () => {
    const scope = createContainmentScope({ id: "desk-id03", useCgroup: false });
    const pid = spawnInScope(scope, "/bin/sleep", ["300"]);
    expect(await waitFor(() => processCarriesToken(pid, scope.token))).toBe(true);

    // The scan (first environ read) lists the pid; it then dies before the
    // pre-signal re-read (second environ read) sees it.
    const environ = `/proc/${pid}/environ`;
    const realRead = fs.readFileSync;
    let environReads = 0;
    vi.spyOn(fs, "readFileSync").mockImplementation(((file, ...rest) => {
      if (file === environ) {
        environReads += 1;
        if (environReads === 2) {
          process.kill(pid, "SIGKILL");
          waitSyncUntilExited(pid, realRead);
        }
      }
      return realRead.call(fs, file, ...rest);
    }) as typeof fs.readFileSync);

    const result = await destroyContainmentScope(scope, {
      termTimeoutMs: 1_000,
      killTimeoutMs: 1_000,
    });
    expect(environReads).toBeGreaterThanOrEqual(2);
    expect(result.refused).toEqual([]);
    expect(result.signaled).not.toContain(pid);
    expect(result.survivors).toEqual([]);
    expect(result.confirmed).toBe(true);
    expect(result.reason).toBeUndefined();
  }, 20_000);

  it("refuses a live pid whose token vanished between the scan and the re-read (pid reuse)", async () => {
    const scope = createContainmentScope({ id: "desk-id04", useCgroup: false });
    const pid = spawnInScope(scope, "/bin/sleep", ["300"]);
    expect(await waitFor(() => processCarriesToken(pid, scope.token))).toBe(true);

    // After the scan, the pid's environment is that of an unrelated process:
    // the number was recycled. It is alive, so it must be refused, not killed.
    const environ = `/proc/${pid}/environ`;
    const realRead = fs.readFileSync;
    let environReads = 0;
    vi.spyOn(fs, "readFileSync").mockImplementation(((file, ...rest) => {
      if (file === environ) {
        environReads += 1;
        if (environReads >= 2) return "PATH=/usr/bin\0HOME=/nowhere\0";
      }
      return realRead.call(fs, file, ...rest);
    }) as typeof fs.readFileSync);

    const result = await destroyContainmentScope(scope, {
      termTimeoutMs: 500,
      killTimeoutMs: 500,
    });
    expect(result.refused).toEqual([pid]);
    expect(result.signaled).not.toContain(pid);
    expect(result.confirmed).toBe(false);
    expect(result.reason).toMatch(/refused to signal 1 live PID/);
    expect(isPidAlive(pid)).toBe(true);
  }, 20_000);

  it("does not match a process whose token is only a prefix", async () => {
    const scope = createContainmentScope({ id: "desk-id02", useCgroup: false });
    const child = spawn("/bin/sleep", ["300"], {
      env: {
        ...process.env,
        [CONTAINMENT_TOKEN_ENV]: `${scope.token}extra`,
      },
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    const pid = child.pid as number;
    strays.add(pid);
    expect(await waitFor(() => isPidAlive(pid))).toBe(true);

    expect(processCarriesToken(pid, scope.token)).toBe(false);
    const result = await destroyContainmentScope(scope);
    expect(result.signaled).not.toContain(pid);
    expect(isPidAlive(pid)).toBe(true);
  }, 20_000);
});

describe("containment cleanup failure reporting", () => {
  it("refuses to kill through a path that is not a Pickforge scope cgroup", async () => {
    const fakeCgroup = fs.mkdtempSync(path.join(root, "pickforge-fake-"));
    fs.writeFileSync(path.join(fakeCgroup, "cgroup.procs"), "");
    fs.writeFileSync(path.join(fakeCgroup, "cgroup.kill"), "");
    const scope: ContainmentScope = {
      token: "0".repeat(64),
      mechanism: "cgroup",
      cgroupDir: fakeCgroup,
    };
    const result = await destroyContainmentScope(scope, {
      termTimeoutMs: 200,
      killTimeoutMs: 200,
    });
    expect(result.confirmed).toBe(false);
    expect(result.reason).toMatch(/refusing cgroup cleanup/);
    // Nothing was written to the impostor.
    expect(fs.readFileSync(path.join(fakeCgroup, "cgroup.kill"), "utf8")).toBe("");
  });

  it("refuses a scope path that escapes the cgroup filesystem or lacks the prefix", () => {
    expect(scopeCgroupProblem("/sys/fs/cgroup/user.slice/pickforge-desk-1")).toBeUndefined();
    expect(scopeCgroupProblem("/sys/fs/cgroup/user.slice")).toMatch(/pickforge-\*/);
    expect(scopeCgroupProblem("/sys/fs/cgroup")).toBeDefined();
    expect(scopeCgroupProblem("/sys/fs/cgroup/x/../pickforge-desk-1")).toBeDefined();
    expect(scopeCgroupProblem("/tmp/pickforge-desk-1")).toBeDefined();
    expect(scopeCgroupProblem("relative/pickforge-desk-1")).toBeDefined();
  });

  it("treats an already-removed cgroup as clean when no member survives", async () => {
    const scope: ContainmentScope = {
      token: "1".repeat(64),
      mechanism: "cgroup",
      cgroupDir: "/sys/fs/cgroup/pickforge-gone-cgroup",
    };
    const result = await destroyContainmentScope(scope, {
      termTimeoutMs: 200,
      killTimeoutMs: 200,
    });
    expect(result.confirmed).toBe(true);
  });

  it("reports a cgroup scope with no recorded path as unconfirmed", async () => {
    const result = await destroyContainmentScope(
      { token: "2".repeat(64), mechanism: "cgroup" },
      { termTimeoutMs: 200, killTimeoutMs: 200 },
    );
    expect(result.confirmed).toBe(false);
    expect(result.reason).toContain("missing");
  });
});

describe("buildContainedCommand", () => {
  it("passes an argv array with the cgroup, binary and args, never a shell string", () => {
    const scope: ContainmentScope = {
      token: "3".repeat(64),
      mechanism: "cgroup",
      cgroupDir: "/sys/fs/cgroup/user.slice/pickforge-desk-1",
    };
    const built = buildContainedCommand(process.execPath, scope, "/usr/bin/app", [
      "--flag",
      "a b; rm -rf /",
    ]);
    expect(built.command).toBe(process.execPath);
    expect(built.args.slice(-4)).toEqual([
      "/sys/fs/cgroup/user.slice/pickforge-desk-1",
      "/usr/bin/app",
      "--flag",
      "a b; rm -rf /",
    ]);
    expect(built.args).toContain("--input-type=module");
  });

  it("passes '-' instead of a path for the marker mechanism", () => {
    const built = buildContainedCommand(
      process.execPath,
      { token: "4".repeat(64), mechanism: "marker" },
      "/usr/bin/app",
      [],
    );
    expect(built.args.slice(-2)).toEqual(["-", "/usr/bin/app"]);
  });

  it("rejects an empty node path or command", () => {
    const scope: ContainmentScope = { token: "5".repeat(64), mechanism: "marker" };
    expect(() => buildContainedCommand("", scope, "app", [])).toThrow(
      /Node.js executable/,
    );
    expect(() => buildContainedCommand(process.execPath, scope, "", [])).toThrow(
      /command to run/,
    );
  });

  it("rejects a tampered cgroup path before anything is spawned", () => {
    const tampered: ContainmentScope = {
      token: "7".repeat(64),
      mechanism: "cgroup",
      cgroupDir: "/sys/fs/cgroup/user.slice/user-1000.slice",
    };
    expect(() => buildContainedCommand(process.execPath, tampered, "app", [])).toThrow(
      /not a Pickforge cgroup/,
    );
    expect(() => ensureContainmentScope(tampered)).toThrow(/not a Pickforge cgroup/);
  });
});

describe("containment supervisor", () => {
  it("forwards SIGTERM to the app and exits with it instead of swallowing the signal", async () => {
    const scope = createContainmentScope({ id: "desk-sup01", useCgroup: false });
    const supervisor = spawnSupervised(scope, "/bin/sleep", ["300"]);
    expect(
      await waitFor(() => listProcessGroupMembers(supervisor).length >= 2),
    ).toBe(true);
    const app = listProcessGroupMembers(supervisor).find((pid) => pid !== supervisor);
    expect(app).toBeDefined();
    strays.add(app as number);

    process.kill(supervisor, "SIGTERM");
    expect(await waitFor(() => !isPidAlive(app as number), 2_000)).toBe(true);
    expect(await waitFor(() => !isPidAlive(supervisor), 2_000)).toBe(true);
  }, 10_000);

  it("lets a marker cleanup finish within the SIGTERM budget rather than waiting it out", async () => {
    const scope = createContainmentScope({ id: "desk-sup02", useCgroup: false });
    const supervisor = spawnSupervised(scope, "/bin/sleep", ["300"]);
    expect(
      await waitFor(() => listProcessGroupMembers(supervisor).length >= 2),
    ).toBe(true);

    const started = Date.now();
    const result = await destroyContainmentScope(scope, {
      termTimeoutMs: 3_000,
      killTimeoutMs: 2_000,
    });
    expect(result.confirmed).toBe(true);
    expect(result.survivors).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2_000);
  }, 10_000);

  it("refuses to run the app when a cgroup.procs write is not reflected in membership (false join)", async () => {
    // A regular directory with a writable `cgroup.procs` accepts the write
    // exactly like a cgroup would; only the kernel's own view can tell them
    // apart. The static path check is bypassed here on purpose so the
    // supervisor's post-join verification is what is under test.
    const impostor = fs.mkdtempSync(path.join(root, "pickforge-impostor-"));
    fs.writeFileSync(path.join(impostor, "cgroup.procs"), "");
    const placeholder = "/sys/fs/cgroup/pickforge-placeholder";
    const started = path.join(root, "false-join-started.txt");
    const built = buildContainedCommand(
      process.execPath,
      { token: "8".repeat(64), mechanism: "cgroup", cgroupDir: placeholder },
      "/bin/sh",
      ["-c", `echo started > "${started}"`],
    );
    const args = built.args.map((arg) => (arg === placeholder ? impostor : arg));

    const child = spawn(built.command, args, { stdio: ["ignore", "ignore", "pipe"] });
    const { code, stderr } = await finish(child);
    expect(code).toBe(126);
    expect(stderr).toMatch(/could not join containment cgroup/);
    expect(stderr).toMatch(/membership was not reflected/);
    expect(fs.readFileSync(path.join(impostor, "cgroup.procs"), "utf8").trim()).toBe(
      String(child.pid),
    );
    expect(fs.existsSync(started)).toBe(false);
  }, 10_000);

  it("refuses to run the app when the scope cgroup is unavailable", async () => {
    if (process.getuid?.() === 0) return; // root could create it for real
    const missing = `/sys/fs/cgroup/pickforge-unavailable-${process.pid}`;
    const started = path.join(root, "unavailable-started.txt");
    const built = buildContainedCommand(
      process.execPath,
      { token: "9".repeat(64), mechanism: "cgroup", cgroupDir: missing },
      "/bin/sh",
      ["-c", `echo started > "${started}"`],
    );
    const child = spawn(built.command, built.args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const { code, stderr } = await finish(child);
    expect(code).toBe(126);
    expect(stderr).toMatch(/could not join containment cgroup/);
    expect(fs.existsSync(started)).toBe(false);
    expect(fs.existsSync(missing)).toBe(false);
  }, 10_000);

  it("refuses a cgroup path outside the cgroup filesystem even when handed one directly", async () => {
    const outside = fs.mkdtempSync(path.join(root, "pickforge-outside-"));
    const placeholder = "/sys/fs/cgroup/pickforge-placeholder";
    const built = buildContainedCommand(
      process.execPath,
      { token: "a".repeat(64), mechanism: "cgroup", cgroupDir: placeholder },
      "/bin/true",
      [],
    );
    const args = built.args.map((arg) => (arg === placeholder ? outside : arg));
    const { code, stderr } = await finish(
      spawn(built.command, args, { stdio: ["ignore", "ignore", "pipe"] }),
    );
    expect(code).toBe(126);
    expect(stderr).toMatch(/membership was not reflected/);
  }, 10_000);

  it("is not steered by NODE_OPTIONS: the app still starts when the caller's env would hijack node", () => {
    // Control: the injection really does take over a plain node process.
    const die = path.join(root, "die.cjs");
    fs.writeFileSync(die, "process.exit(99);\n");
    const hijacked = spawnSync(process.execPath, ["-e", "0"], {
      env: { ...process.env, NODE_OPTIONS: `--require ${die}` },
    });
    expect(hijacked.status).toBe(99);
    // The desktop environment builder is what strips it (see the desktop-linux
    // tests); the supervisor itself must simply run whatever it is given.
    const scope = createContainmentScope({ id: "desk-sup03", useCgroup: false });
    const built = buildContainedCommand(process.execPath, scope, "/bin/true", []);
    const clean = spawnSync(built.command, built.args, {
      env: { ...process.env, ...containmentEnv(scope) },
    });
    expect(clean.status).toBe(0);
  }, 10_000);
});

describe("stale scope cgroups", () => {
  itWithCgroup("prunes empty leftovers but never a scope that still has members", async () => {
    const live = createContainmentScope({ id: "desk-gc-live" });
    expect(live.mechanism).toBe("cgroup");
    const parent = path.dirname(live.cgroupDir as string);
    spawnInScope(live, "/bin/sleep", ["300"]);
    expect(await waitFor(() => cgroupMembers(live).length > 0)).toBe(true);

    // A lab process killed with SIGKILL leaves its (vacated) cgroup behind.
    const orphan = path.join(parent, "pickforge-desk-gc-orphan");
    fs.mkdirSync(orphan);

    const next = createContainmentScope({ id: "desk-gc-next" });
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(live.cgroupDir as string)).toBe(true);

    await destroyContainmentScope(next);
    await destroyContainmentScope(live);
  }, 20_000);
});

describe("scope re-creation", () => {
  itWithCgroup("re-creates an empty scope cgroup that was pruned under it", async () => {
    const scope = createContainmentScope({ id: "desk-recreate" });
    expect(scope.mechanism).toBe("cgroup");
    fs.rmdirSync(scope.cgroupDir as string);
    expect(fs.existsSync(scope.cgroupDir as string)).toBe(false);

    const ensured = ensureContainmentScope(scope);
    expect(ensured.mechanism).toBe("cgroup");
    expect(ensured.token).toBe(scope.token);
    expect(fs.existsSync(ensured.cgroupDir as string)).toBe(true);
    await destroyContainmentScope(ensured);
  });

  it("leaves a marker scope untouched", () => {
    const scope = createContainmentScope({ id: "desk-recreate-marker", useCgroup: false });
    expect(ensureContainmentScope(scope)).toEqual(scope);
  });
});
