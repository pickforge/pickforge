import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  containmentEnv,
  destroyContainmentScope,
  isPidAlive,
  listProcessGroupMembers,
  type ContainmentScope,
} from "../src/index.js";

/**
 * The cgroup guards on a host that delegates no cgroup.
 *
 * `containment.test.ts` exercises these paths against *real* scope cgroups and
 * is the ground truth, but it skips wherever delegation is unavailable — which
 * is every CI runner and every container without delegation. Here the kernel
 * interface is simulated instead: `statfs`, `cgroup.procs`, `cgroup.kill`,
 * `rmdir` and `/proc/<pid>/cgroup` are backed by an in-memory cgroup, while the
 * processes, their `/proc/<pid>/environ` and every signal remain real. That
 * keeps the decisions under test — who may be killed, who must be moved out
 * first, and what makes cleanup refuse — running everywhere.
 */

const CGROUP_ROOT = "/sys/fs/cgroup";
const SCOPE_ID = "desk-sim01";
const SCOPE_DIR = path.join(CGROUP_ROOT, `pickforge-${SCOPE_ID}`);
const PARENT_PROCS = path.join(CGROUP_ROOT, "cgroup.procs");

interface FakeCgroup {
  members: number[];
  killed: boolean;
  migrated: number[];
  removed: boolean;
  /** Relative cgroup path reported for `/proc/self/cgroup`. */
  ownPath: string;
  /** Relative cgroup path reported for other pids. */
  pathOf: Map<number, string>;
  /** Pids whose `/proc/<pid>/environ` fails with EACCES. */
  unreadable: Set<number>;
  /** Set to make a write to the parent `cgroup.procs` fail. */
  migrateError?: NodeJS.ErrnoException;
  /** Where a migrated pid claims to be afterwards. */
  migratedPath: string;
}

const strays = new Set<number>();

function newFake(overrides: Partial<FakeCgroup> = {}): FakeCgroup {
  return {
    members: [],
    killed: false,
    migrated: [],
    removed: false,
    ownPath: "/",
    pathOf: new Map(),
    unreadable: new Set(),
    migratedPath: "/",
    ...overrides,
  };
}

function installFakeCgroup(fake: FakeCgroup): void {
  const realRead = fs.readFileSync;
  const realExists = fs.existsSync;
  const realWrite = fs.writeFileSync;

  vi.spyOn(fs, "existsSync").mockImplementation(((target: fs.PathLike) =>
    target === SCOPE_DIR ? !fake.removed : realExists(target)) as typeof fs.existsSync);

  vi.spyOn(fs, "statfsSync").mockImplementation(((target: fs.PathLike) => {
    if (target !== SCOPE_DIR) throw new Error(`unexpected statfs ${String(target)}`);
    // CGROUP2_SUPER_MAGIC
    return { type: 0x63677270 } as ReturnType<typeof fs.statfsSync>;
  }) as typeof fs.statfsSync);

  vi.spyOn(fs, "readFileSync").mockImplementation(((file, ...rest) => {
    if (file === path.join(SCOPE_DIR, "cgroup.procs")) {
      return `${fake.members.join("\n")}\n`;
    }
    if (file === "/proc/self/cgroup") return `0::${fake.ownPath}\n`;
    const proc = /^\/proc\/(\d+)\/(cgroup|environ)$/.exec(String(file));
    if (proc !== null) {
      const pid = Number(proc[1]);
      if (proc[2] === "cgroup") {
        const own = fake.pathOf.get(pid);
        if (own !== undefined) return `0::${own}\n`;
      } else if (fake.unreadable.has(pid)) {
        throw Object.assign(new Error("EACCES: permission denied"), {
          code: "EACCES",
        });
      }
    }
    return realRead.call(fs, file, ...rest);
  }) as typeof fs.readFileSync);

  vi.spyOn(fs, "writeFileSync").mockImplementation(((file, data, ...rest) => {
    if (file === path.join(SCOPE_DIR, "cgroup.kill")) {
      fake.killed = true;
      fake.members = [];
      return;
    }
    if (file === PARENT_PROCS) {
      if (fake.migrateError !== undefined) throw fake.migrateError;
      const pid = Number(data);
      fake.migrated.push(pid);
      fake.members = fake.members.filter((member) => member !== pid);
      fake.pathOf.set(pid, fake.migratedPath);
      if (pid === process.pid) fake.ownPath = fake.migratedPath;
      return;
    }
    realWrite.call(fs, file, data as string, ...rest);
  }) as typeof fs.writeFileSync);

  vi.spyOn(fs, "rmdirSync").mockImplementation(((target: fs.PathLike) => {
    if (target !== SCOPE_DIR) throw new Error(`unexpected rmdir ${String(target)}`);
    fake.removed = true;
  }) as typeof fs.rmdirSync);
}

function scope(): ContainmentScope {
  return {
    id: SCOPE_ID,
    token: "b".repeat(64),
    mechanism: "cgroup",
    cgroupDir: SCOPE_DIR,
  };
}

/** A real token carrier that forks a child of its own. */
function spawnShellWithChild(): number {
  // `; true` keeps the shell from exec'ing the sleep in place, so
  // there really are two processes.
  const child = spawn("/bin/sh", ["-c", "/bin/sleep 300; true"], {
    env: { PATH: "/usr/bin:/bin", ...containmentEnv(scope()) },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const pid = child.pid;
  if (pid === undefined) throw new Error("spawn produced no pid");
  strays.add(pid);
  return pid;
}

/** A real process, optionally carrying the scope token. */
function spawnMember(target: ContainmentScope | undefined): number {
  const child = spawn("/bin/sleep", ["300"], {
    env:
      target === undefined
        ? { PATH: "/usr/bin:/bin" }
        : { PATH: "/usr/bin:/bin", ...containmentEnv(target) },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const pid = child.pid;
  if (pid === undefined) throw new Error("spawn produced no pid");
  strays.add(pid);
  return pid;
}

function destroy(): ReturnType<typeof destroyContainmentScope> {
  return destroyContainmentScope(scope(), {
    termTimeoutMs: 500,
    killTimeoutMs: 500,
  });
}

async function waitFor(predicate: () => boolean): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const pid of strays) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  strays.clear();
});

describe("cgroup cleanup guards (simulated cgroup)", () => {
  it("kills the scope when every member carries this session's token", async () => {
    const member = spawnMember(scope());
    const fake = newFake({ members: [member] });
    installFakeCgroup(fake);

    const result = await destroy();

    expect(fake.killed).toBe(true);
    expect(fake.removed).toBe(true);
    expect(result.confirmed).toBe(true);
    // The simulated kill signals nothing, so the marker sweep is what actually
    // ends the member: cleanup is confirmed by both mechanisms, as designed.
    expect(result.signaled).toContain(member);
    expect(isPidAlive(member)).toBe(false);
  }, 20_000);

  it("accepts a member whose in-scope parent carries the token", async () => {
    // A real parent/child pair: the shell carries the token, the `sleep` it
    // forked is the member whose own environ cannot be read (what a setuid
    // exec looks like). Ownership comes from the parent, inside the same scope.
    const parent = spawnShellWithChild();
    expect(
      await waitFor(() => listProcessGroupMembers(parent).length >= 2),
    ).toBe(true);
    const child = listProcessGroupMembers(parent).find((pid) => pid !== parent);
    expect(child).toBeDefined();
    strays.add(child as number);
    const fake = newFake({ members: [parent, child as number] });
    fake.unreadable.add(child as number);
    installFakeCgroup(fake);

    const result = await destroy();

    expect(fake.killed).toBe(true);
    expect(result.reason).toBeUndefined();
  }, 20_000);

  it("refuses to kill a scope holding a process without this session's token", async () => {
    const stranger = spawnMember(undefined);
    const fake = newFake({ members: [stranger] });
    installFakeCgroup(fake);

    const result = await destroy();

    expect(fake.killed).toBe(false);
    expect(fake.removed).toBe(false);
    expect(result.confirmed).toBe(false);
    expect(result.reason).toMatch(/do not carry this session's containment token/);
    expect(isPidAlive(stranger)).toBe(true);
  }, 20_000);

  it("refuses when a member's ownership never becomes readable", async () => {
    const opaque = spawnMember(undefined);
    const fake = newFake({ members: [opaque] });
    fake.unreadable.add(opaque);
    installFakeCgroup(fake);

    const result = await destroy();

    expect(fake.killed).toBe(false);
    expect(result.confirmed).toBe(false);
    expect(result.reason).toMatch(/could not verify that process\(es\)/);
    expect(isPidAlive(opaque)).toBe(true);
  }, 20_000);

  it("moves its own chain out before killing, and confirms the move", async () => {
    const member = spawnMember(scope());
    const fake = newFake({
      members: [process.pid, member],
      ownPath: `/pickforge-${SCOPE_ID}`,
    });
    fake.pathOf.set(process.pid, `/pickforge-${SCOPE_ID}`);
    installFakeCgroup(fake);

    const result = await destroy();

    expect(fake.migrated).toContain(process.pid);
    expect(fake.killed).toBe(true);
    expect(result.confirmed).toBe(true);
    expect(result.signaled).not.toContain(process.pid);
    expect(isPidAlive(process.pid)).toBe(true);
  }, 20_000);

  it("refuses rather than killing itself when the move out fails", async () => {
    const fake = newFake({
      members: [process.pid],
      ownPath: `/pickforge-${SCOPE_ID}`,
      migrateError: Object.assign(new Error("EPERM: operation not permitted"), {
        code: "EPERM",
      }),
    });
    fake.pathOf.set(process.pid, `/pickforge-${SCOPE_ID}`);
    installFakeCgroup(fake);

    const result = await destroy();

    expect(fake.killed).toBe(false);
    expect(result.confirmed).toBe(false);
    expect(result.reason).toMatch(/could not be moved out/);
    expect(result.reason).toMatch(/Run the command from a shell outside/);
  }, 20_000);

  it("refuses when a moved-out pid does not land in the parent cgroup", async () => {
    const fake = newFake({
      members: [process.pid],
      ownPath: `/pickforge-${SCOPE_ID}`,
      migratedPath: "/somewhere.else",
    });
    fake.pathOf.set(process.pid, `/pickforge-${SCOPE_ID}`);
    installFakeCgroup(fake);

    const result = await destroy();

    expect(fake.killed).toBe(false);
    expect(result.confirmed).toBe(false);
    expect(result.reason).toMatch(/after being moved out/);
  }, 20_000);

  it("refuses a scope whose member list cannot be read", async () => {
    const fake = newFake({ members: [] });
    installFakeCgroup(fake);
    const spied = vi.mocked(fs.readFileSync);
    const passthrough = spied.getMockImplementation();
    spied.mockImplementation(((file, ...rest) => {
      if (file === path.join(SCOPE_DIR, "cgroup.procs")) {
        throw Object.assign(new Error("ENODEV"), { code: "ENODEV" });
      }
      return (passthrough as typeof fs.readFileSync)(file, ...rest);
    }) as typeof fs.readFileSync);

    const result = await destroy();

    expect(fake.killed).toBe(false);
    expect(result.confirmed).toBe(false);
    expect(result.reason).toMatch(/could not read .*cgroup\.procs/);
  }, 20_000);
});
