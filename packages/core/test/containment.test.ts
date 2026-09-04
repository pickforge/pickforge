import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
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
  type ContainmentScope,
} from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// The repo's test runtime; workers are TypeScript run directly.
const BUN = /[\\/]bun$/.test(process.execPath) ? process.execPath : "bun";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-containment-"));
const strays = new Set<number>();

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

afterEach(() => {
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

  it("kills a setsid escapee through the cgroup when one is available", async () => {
    const scope = createContainmentScope({ id: "desk-esc02" });
    if (scope.mechanism !== "cgroup") {
      await destroyContainmentScope(scope);
      return; // no delegated cgroup on this host; the marker test covers it
    }
    const pidFile = path.join(root, "escapee-cgroup.pid");
    const leader = spawnInScope(scope, writeEscapingScript("escape-cgroup.sh", pidFile));
    expect(await waitFor(() => readPidFile(pidFile) !== undefined)).toBe(true);
    const escapee = readPidFile(pidFile) as number;
    strays.add(escapee);

    // Membership, not pid arithmetic, is what proves ownership.
    const members = fs
      .readFileSync(path.join(scope.cgroupDir as string, "cgroup.procs"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map(Number);
    expect(members).toContain(escapee);
    expect(members).toContain(leader);

    const result = await destroyContainmentScope(scope);
    expect(result.confirmed).toBe(true);
    expect(isPidAlive(escapee)).toBe(false);
    expect(fs.existsSync(scope.cgroupDir as string)).toBe(false);
  }, 30_000);

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

  it("never signals the process performing the cleanup or its ancestors", async () => {
    const scope = createContainmentScope({ id: "desk-safe04", useCgroup: false });
    const marker = path.join(root, "self-exclusion.txt");
    const worker = path.join(here, "workers", "containment-self-worker.ts");
    // The worker itself carries the token, so a sweep that did not exclude the
    // caller's own process chain would kill it before it could report.
    const child = spawn(BUN, [worker, scope.token, marker], {
      env: { ...process.env, ...containmentEnv(scope) },
      stdio: "ignore",
    });
    strays.add(child.pid as number);
    const exitCode = await new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
    });

    expect(exitCode).toBe(0);
    expect(fs.readFileSync(marker, "utf8")).toBe("survived");
  }, 30_000);
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
  it("refuses to claim success when the cgroup cannot be killed", async () => {
    const fakeCgroup = fs.mkdtempSync(path.join(root, "fake-cgroup-"));
    // Read-only, so writing cgroup.kill fails the way an undelegated or
    // vanished cgroup would.
    fs.chmodSync(fakeCgroup, 0o500);
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
    expect(result.reason).toContain("cgroup.kill");
  });

  it("treats an already-removed cgroup as clean when no member survives", async () => {
    const scope: ContainmentScope = {
      token: "1".repeat(64),
      mechanism: "cgroup",
      cgroupDir: path.join(root, "gone-cgroup"),
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
});

describe("stale scope cgroups", () => {
  it("prunes empty leftovers but never a scope that still has members", async () => {
    const live = createContainmentScope({ id: "desk-gc-live" });
    if (live.mechanism !== "cgroup") {
      await destroyContainmentScope(live);
      return; // no delegated cgroup on this host
    }
    const parent = path.dirname(live.cgroupDir as string);
    spawnInScope(live, "/bin/sleep", ["300"]);
    expect(
      await waitFor(
        () =>
          fs
            .readFileSync(path.join(live.cgroupDir as string, "cgroup.procs"), "utf8")
            .trim() !== "",
      ),
    ).toBe(true);

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
  it("re-creates an empty scope cgroup that was pruned under it", async () => {
    const scope = createContainmentScope({ id: "desk-recreate" });
    if (scope.mechanism !== "cgroup") {
      await destroyContainmentScope(scope);
      return; // no delegated cgroup on this host
    }
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
