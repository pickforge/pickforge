import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
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
// The marker sweep signals every process on the host that carries the token,
// so a fixed token would let a concurrent run of this file kill this run's
// members (#253).
const TOKEN = randomBytes(32).toString("hex");

interface FakeCgroup {
  members: number[];
  killed: boolean;
  freezeSupported: boolean;
  frozen: boolean;
  freezes: string[];
  freezeEventError?: boolean;
  beforeFreeze?: () => void;
  beforeSignal?: () => void;
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
  /** Filesystem magic `statfs` reports for the scope directory. */
  statfsType: number;
  /**
   * Which kernel access removes the directory first, simulating a concurrent
   * session create pruning this (empty) scope during destroy.
   */
  pruneAt?:
    | "statfs"
    | "cgroup.procs"
    | "cgroup.procs (verify)"
    | "cgroup.freeze"
    | "cgroup.events"
    | "cgroup.procs (frozen verify)";
  /** Error code the pruned directory's files fail with. */
  pruneCode: string;
  /** How long the pruned directory stays visible after being pruned. */
  lingerMs: number;
  removedAt?: number;
  procsReads: number;
  /** Set to make every inspection of the scope directory fail with it. */
  accessError?: NodeJS.ErrnoException;
}

const CGROUP2_SUPER_MAGIC = 0x63677270;
const TMPFS_MAGIC = 0x01021994;

function pruned(fake: FakeCgroup, target: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${fake.pruneCode}: ${target}`), {
    code: fake.pruneCode,
  });
}

function prune(fake: FakeCgroup): void {
  fake.removed = true;
  fake.removedAt = Date.now();
}

function visible(fake: FakeCgroup): boolean {
  if (!fake.removed) return true;
  return Date.now() < (fake.removedAt ?? 0) + fake.lingerMs;
}

function lstatScope(fake: FakeCgroup): fs.Stats | undefined {
  if (fake.accessError !== undefined) throw fake.accessError;
  return visible(fake) ? ({} as fs.Stats) : undefined;
}

const strays = new Set<number>();

function newFake(overrides: Partial<FakeCgroup> = {}): FakeCgroup {
  return {
    members: [],
    killed: false,
    freezeSupported: true,
    frozen: false,
    freezes: [],
    migrated: [],
    removed: false,
    ownPath: "/",
    pathOf: new Map(),
    unreadable: new Set(),
    migratedPath: "/",
    statfsType: CGROUP2_SUPER_MAGIC,
    pruneCode: "ENOENT",
    lingerMs: 0,
    procsReads: 0,
    ...overrides,
  };
}

function readFakeProcs(fake: FakeCgroup): string {
  fake.procsReads += 1;
  if (fake.pruneAt === "cgroup.procs") prune(fake);
  if (fake.pruneAt === "cgroup.procs (verify)" && fake.procsReads === 2) prune(fake);
  if (fake.pruneAt === "cgroup.procs (frozen verify)" && fake.procsReads === 3) prune(fake);
  if (fake.removed) throw pruned(fake, path.join(SCOPE_DIR, "cgroup.procs"));
  fake.members = fake.members.filter((pid) => isPidAlive(pid));
  return `${fake.members.join("\n")}\n`;
}

function writeFakeFreeze(fake: FakeCgroup, data: string): void {
  if (fake.pruneAt === "cgroup.freeze") prune(fake);
  const file = path.join(SCOPE_DIR, "cgroup.freeze");
  if (fake.removed || !fake.freezeSupported) throw pruned(fake, file);
  if (String(data) === "1") fake.beforeFreeze?.();
  fake.freezes.push(String(data));
  fake.frozen = String(data) === "1";
}

function installFakeCgroup(fake: FakeCgroup): void {
  const realRead = fs.readFileSync;
  const realExists = fs.existsSync;
  const realWrite = fs.writeFileSync;
  const realKill = process.kill;
  vi.spyOn(process, "kill").mockImplementation(((pid, signal) => {
    if (signal === "SIGKILL" && fake.members.includes(pid)) fake.beforeSignal?.();
    return realKill(pid, signal);
  }) as typeof process.kill);

  // Like the real one, `existsSync` folds an inspection error into `false`.
  vi.spyOn(fs, "existsSync").mockImplementation(((target: fs.PathLike) =>
    target === SCOPE_DIR
      ? fake.accessError === undefined && visible(fake)
      : realExists(target)) as typeof fs.existsSync);

  vi.spyOn(fs, "lstatSync").mockImplementation(((target: fs.PathLike) => {
    if (target !== SCOPE_DIR) throw new Error(`unexpected lstat ${String(target)}`);
    return lstatScope(fake);
  }) as typeof fs.lstatSync);

  vi.spyOn(fs, "statfsSync").mockImplementation(((target: fs.PathLike) => {
    if (target !== SCOPE_DIR) throw new Error(`unexpected statfs ${String(target)}`);
    if (fake.accessError !== undefined) throw fake.accessError;
    if (fake.pruneAt === "statfs") prune(fake);
    if (fake.removed) throw pruned(fake, SCOPE_DIR);
    return { type: fake.statfsType } as ReturnType<typeof fs.statfsSync>;
  }) as typeof fs.statfsSync);

  vi.spyOn(fs, "readFileSync").mockImplementation(((file, ...rest) => {
    if (file === path.join(SCOPE_DIR, "cgroup.procs")) {
      return readFakeProcs(fake);
    }
    if (file === path.join(SCOPE_DIR, "cgroup.events")) {
      if (fake.pruneAt === "cgroup.events") prune(fake);
      if (fake.removed || fake.freezeEventError) throw pruned(fake, String(file));
      return `populated ${Number(fake.members.length > 0)}\nfrozen ${Number(fake.frozen)}\n`;
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
      fake.beforeSignal?.();
      if (fake.removed) throw pruned(fake, String(file));
      fake.killed = true;
      for (const pid of fake.members) realKill(pid, "SIGKILL");
      fake.members = [];
      return;
    }
    if (file === path.join(SCOPE_DIR, "cgroup.freeze")) {
      writeFakeFreeze(fake, data as string);
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
    if (fake.members.some((pid) => isPidAlive(pid))) {
      throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
    }
    fake.removed = true;
  }) as typeof fs.rmdirSync);
}

function scope(): ContainmentScope {
  return {
    id: SCOPE_ID,
    token: TOKEN,
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
  it.each([true, false])("kills proven members (freeze supported: %s)", async (freezeSupported) => {
    const member = spawnMember(scope());
    const fake = newFake({ members: [member], freezeSupported });
    installFakeCgroup(fake);

    const result = await destroy();

    expect(fake.killed).toBe(false);
    expect(fake.removed).toBe(true);
    expect(result.confirmed).toBe(true);
    expect(fake.freezes).toEqual(freezeSupported ? ["1", "0"] : []);
    expect(result.signaled).toContain(member);
    expect(isPidAlive(member)).toBe(false);
  }, 20_000);

  it("skips a proven zombie and signals the remaining cgroup members", async () => {
    const zombie = spawnMember(scope());
    const remaining = spawnMember(scope());
    const fake = newFake({ members: [zombie, remaining] });
    installFakeCgroup(fake);
    const read = vi.mocked(fs.readFileSync).getMockImplementation() as typeof fs.readFileSync;
    let proofRead = false;
    let exited = false;
    vi.mocked(fs.readFileSync).mockImplementation(((file, ...args) => {
      const content = read(file, ...args);
      if (file === `/proc/${zombie}/stat` && exited) {
        return String(content).replace(/\) \S+ /, ") Z ");
      }
      if (file === `/proc/${zombie}/environ` && fake.procsReads === 3) proofRead = true;
      if (file === `/proc/${zombie}/stat` && proofRead) {
        // Return the final live proof, then retain only its zombie in /proc.
        exited = true;
        fake.members = fake.members.filter((pid) => pid !== zombie);
      }
      return content;
    }) as typeof fs.readFileSync);

    const result = await destroy();

    expect(exited).toBe(true);
    expect(result.confirmed).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(fake.removed).toBe(true);
    expect(result.signaled).not.toContain(zombie);
    expect(vi.mocked(process.kill).mock.calls).toContainEqual([remaining, "SIGKILL"]);
    expect(isPidAlive(zombie)).toBe(true);
    expect(isPidAlive(remaining)).toBe(false);
  }, 20_000);

  it.each([true, false])(
    "does not kill a foreign member joining after proof (freeze supported: %s)",
    async (freezeSupported) => {
      const member = spawnMember(scope());
      const stranger = spawnMember({ ...scope(), token: randomBytes(32).toString("hex") });
      const fake = newFake({ members: [member], freezeSupported });
      fake.beforeSignal = () => {
        fake.beforeSignal = undefined;
        fake.members.push(stranger);
      };
      installFakeCgroup(fake);

      const result = await destroy();

      expect(fake.killed).toBe(false);
      expect(isPidAlive(stranger)).toBe(true);
      expect(isPidAlive(member)).toBe(false);
      expect(result.confirmed).toBe(false);
      expect(result.reason).toMatch(/still has members after verified signals/);
      expect(result.signaled).toContain(member);
      expect(result.signaled).not.toContain(stranger);
      expect(fake.frozen).toBe(false);
      expect(fake.removed).toBe(false);
    },
    20_000,
  );

  it("refuses a PID recycled after frozen ownership proof", async () => {
    const member = spawnMember(scope());
    const fake = newFake({ members: [member] });
    installFakeCgroup(fake);
    const read = vi.mocked(fs.readFileSync).getMockImplementation() as typeof fs.readFileSync;
    let proofRead = false;
    let recycled = false;
    vi.mocked(fs.readFileSync).mockImplementation(((file, ...args) => {
      const content = read(file, ...args);
      if (file === `/proc/${member}/environ`) {
        if (recycled) return "PICKFORGE_CONTAINMENT_TOKEN=another-session\0";
        if (fake.procsReads === 3) proofRead = true;
      }
      if (file === `/proc/${member}/stat` && proofRead) {
        if (!recycled) {
          // Return the last old identity read, then replace that identity.
          recycled = true;
        } else {
          const stat = String(content);
          const close = stat.lastIndexOf(")");
          const fields = stat.slice(close + 1).trim().split(/\s+/);
          fields[22 - 3] = String(Number(fields[22 - 3]) + 1);
          return `${stat.slice(0, close + 1)} ${fields.join(" ")}`;
        }
      }
      return content;
    }) as typeof fs.readFileSync);

    const result = await destroy();

    expect(recycled).toBe(true);
    expect(result.confirmed).toBe(false);
    expect(result.reason).toMatch(/refusing to signal recycled cgroup member pid/);
    expect(result.signaled).not.toContain(member);
    expect(isPidAlive(member)).toBe(true);
    expect(fake.freezes).toEqual(["1", "0"]);
  }, 20_000);

  it("rechecks members after freezing and thaws on a foreign-member refusal", async () => {
    const stranger = spawnMember(undefined);
    const fake = newFake();
    fake.beforeFreeze = () => fake.members.push(stranger);
    installFakeCgroup(fake);

    const result = await destroy();

    expect(fake.killed).toBe(false);
    expect(result.confirmed).toBe(false);
    expect(result.reason).toMatch(/do not carry this session's containment token/);
    expect(result.signaled).not.toContain(stranger);
    expect(isPidAlive(stranger)).toBe(true);
    expect(fake.freezes).toEqual(["1", "0"]);
  }, 20_000);

  it("signals proven members during a pending freeze and still runs the marker sweep", async () => {
    const member = spawnMember(scope());
    const escaped = spawnMember(scope());
    const fake = newFake({ members: [member], freezeEventError: true });
    installFakeCgroup(fake);

    const result = await destroy();

    expect(result.confirmed).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.signaled).toEqual(expect.arrayContaining([member, escaped]));
    expect(vi.mocked(process.kill).mock.calls).toContainEqual([member, "SIGKILL"]);
    expect(isPidAlive(member)).toBe(false);
    expect(isPidAlive(escaped)).toBe(false);
    expect(fake.freezes).toEqual(["1", "0"]);
    expect(fake.removed).toBe(true);
  }, 20_000);

  it("always runs the marker sweep after cgroup signals", async () => {
    const member = spawnMember(scope());
    const escaped = spawnMember(scope());
    const fake = newFake({ members: [member] });
    installFakeCgroup(fake);

    const result = await destroy();

    expect(result.confirmed).toBe(true);
    expect(result.signaled).toEqual(expect.arrayContaining([member, escaped]));
    expect(isPidAlive(escaped)).toBe(false);
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

    expect(fake.killed).toBe(false);
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
    expect(fake.killed).toBe(false);
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

  it.each([
    "statfs", "cgroup.procs", "cgroup.procs (verify)",
    "cgroup.freeze", "cgroup.events", "cgroup.procs (frozen verify)",
  ] as const)(
    "confirms a scope that a concurrent create pruned during destroy, at %s, without killing or signalling",
    async (pruneAt) => {
      // The scope exists when destroy starts and vanishes before the next
      // kernel access: a sibling session's create-time prune removed the
      // still-empty cgroup. Nothing is left to kill, so cleanup is confirmed
      // by the marker sweep alone.
      const fake = newFake({ members: [], pruneAt });
      installFakeCgroup(fake);

      const result = await destroy();

      expect(fake.removed).toBe(true);
      expect(fake.killed).toBe(false);
      expect(result.confirmed).toBe(true);
      expect(result.reason).toBeUndefined();
      expect(result.signaled).toEqual([]);
    },
    20_000,
  );

  it("waits out a pruned directory that is still visible while its rmdir completes", async () => {
    // Observed on a real kernel: `cgroup.procs` already fails with ENODEV
    // while the directory entry lingers for under a millisecond.
    const fake = newFake({
      members: [],
      pruneAt: "cgroup.procs",
      pruneCode: "ENODEV",
      lingerMs: 40,
    });
    installFakeCgroup(fake);

    const result = await destroy();

    expect(fake.killed).toBe(false);
    expect(result.confirmed).toBe(true);
    expect(result.signaled).toEqual([]);
  }, 20_000);

  it("keeps refusing a path that exists but is not on a cgroup v2 filesystem", async () => {
    const fake = newFake({ members: [], statfsType: TMPFS_MAGIC });
    installFakeCgroup(fake);

    const result = await destroy();

    expect(fake.killed).toBe(false);
    expect(result.confirmed).toBe(false);
    expect(result.reason).toMatch(/is not on a cgroup v2 filesystem/);
  }, 20_000);

  it("keeps refusing a foreign-filesystem path even when it disappears afterwards", async () => {
    // A positive answer that the path was never a cgroup is final: a later
    // removal of that directory proves nothing about members.
    const fake = newFake({ members: [], statfsType: TMPFS_MAGIC });
    installFakeCgroup(fake);
    const spied = vi.mocked(fs.statfsSync);
    const answer = spied.getMockImplementation() as typeof fs.statfsSync;
    spied.mockImplementation(((target: fs.PathLike) => {
      const stats = answer(target);
      prune(fake);
      return stats;
    }) as typeof fs.statfsSync);

    const result = await destroy();

    expect(fake.removed).toBe(true);
    expect(result.confirmed).toBe(false);
    expect(result.reason).toMatch(/is not on a cgroup v2 filesystem/);
  }, 20_000);

  it.each(["before destroy begins", "after the first existence probe"] as const)(
    "keeps refusing a populated scope that is inaccessible rather than gone, %s",
    async (when) => {
      // The parent lost search permission: statfs and lstat fail with EACCES
      // and `existsSync` reports false, but the cgroup and its stranger are
      // still there. Not provably gone, so refused rather than confirmed.
      const stranger = spawnMember(undefined);
      const accessError = Object.assign(new Error("EACCES: permission denied"), {
        code: "EACCES",
      });
      const fake = newFake({
        members: [stranger],
        ...(when === "before destroy begins" ? { accessError } : {}),
      });
      installFakeCgroup(fake);
      if (when === "after the first existence probe") {
        const lstat = vi.mocked(fs.lstatSync);
        const answer = lstat.getMockImplementation() as typeof fs.lstatSync;
        lstat.mockImplementation(((target: fs.PathLike) => {
          const stats = answer(target);
          fake.accessError = accessError;
          return stats;
        }) as typeof fs.lstatSync);
      }

      const result = await destroy();

      expect(fake.killed).toBe(false);
      expect(result.confirmed).toBe(false);
      expect(result.reason).toMatch(/is not on a cgroup v2 filesystem/);
      expect(isPidAlive(stranger)).toBe(true);
    },
    20_000,
  );

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
