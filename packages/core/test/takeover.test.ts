import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentPermitUnavailableError,
  AgentPermitDrainTimeoutError,
  stopSessionAgentInput,
  HumanControlActiveError,
  HumanLeaseDrainTimeoutError,
  HumanLeaseHeldError,
  StaleHumanLeaseError,
  acquireAgentPermit,
  acquireHumanLease,
  checkHumanLeaseBusy,
  clearStaleHumanLease,
  getTakeoverStatus,
  isHumanLeaseStale,
  readHumanLease,
  releaseAgentPermit,
  releaseHumanLease,
  renewHumanLease,
  withAgentPermit,
  createSession,
  destroySessionRecord,
  updateSession,
  sessionDataDir,
  type EnvLike,
  type HumanLease,
} from "../src/index.js";

import { DirHandle } from "../src/dir-handle.js";

const DEAD_PID = 999_999;

let tmpRoot: string;
let env: EnvLike;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-takeover-test-"));
  env = { ...process.env, PICKFORGE_HOME: path.join(tmpRoot, "home") };
  const sessions = path.join(env.PICKFORGE_HOME!, "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  for (const id of ["desk-0000a5", "desk-0000a6", "desk-0000b1", "desk-0000b2", "desk-0000b3", "desk-0000b4", "desk-0000a1", "desk-0000a2", "desk-0000a3", "desk-0000a4", "desk-0000a7", "desk-0000c1", "desk-000c1b", "desk-0000c2", "desk-0000d1", "desk-a70a1c", "desk-c1ea00"]) {
    fs.writeFileSync(path.join(sessions, `${id}.json`), JSON.stringify({
      id, type: "desktop", status: "running", createdAt: new Date().toISOString(), projectDir: tmpRoot,
    }));
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function writeRawLease(sessionId: string, lease: HumanLease): Promise<string> {
  const dir = path.join(env.PICKFORGE_HOME as string, "sessions", sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const raw = `${JSON.stringify(lease)}\n`;
  fs.writeFileSync(path.join(dir, "human.lease.json"), raw);
  return raw;
}

describe("acquireHumanLease", () => {
  it("acquires a fresh lease and persists it atomically", async () => {
    const lease = await acquireHumanLease("desk-0000a1", env);
    expect(lease.sessionId).toBe("desk-0000a1");
    expect(lease.ownerPid).toBe(process.pid);
    expect(lease.ttlMs).toBe(30_000);
    expect(lease.heartbeatMs).toBe(5_000);
    const onDisk = await readHumanLease("desk-0000a1", env);
    expect(onDisk).toEqual(lease);
  });

  it("never exposes a lease while its temporary file is still empty", async () => {
    let ready!: () => void;
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => { ready = resolve; });
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const openFile = DirHandle.prototype.openFile;
    let intercepted = false;
    vi.spyOn(DirHandle.prototype, "openFile").mockImplementation(async function(this: DirHandle, name, flags, mode) {
      const file = await openFile.call(this, name, flags, mode);
      if (!intercepted && name.startsWith("..human-lease-")) {
        intercepted = true;
        const write = file.writeFile.bind(file);
        vi.spyOn(file, "writeFile").mockImplementation(async (...args) => {
          ready();
          await gate;
          return write(...args);
        });
      }
      return file;
    });
    const first = acquireHumanLease("desk-a70a1c", env).catch((error: unknown) => error);
    try {
      await paused;
      expect(await readHumanLease("desk-a70a1c", env)).toBeUndefined();
      const winner = await acquireHumanLease("desk-a70a1c", env);
      resume();
      expect(await first).toBeInstanceOf(HumanLeaseHeldError);
      expect(await readHumanLease("desk-a70a1c", env)).toEqual(winner);
      expect(fs.readdirSync(sessionDataDir("desk-a70a1c", env)).sort()).toEqual(["human.lease.json", "permits"]);
    } finally { resume(); await first; }
  });

  it.each(["write", "link"])("cleans up lease staging files after a %s failure", async (stage) => {
    if (stage === "write") {
      // FileHandle writes are used by atomic publication.
      const openFile = DirHandle.prototype.openFile;
      vi.spyOn(DirHandle.prototype, "openFile").mockImplementation(async function(this: DirHandle, name, flags, mode) {
        const file = await openFile.call(this, name, flags, mode);
        if (name.startsWith("..human-lease-")) vi.spyOn(file, "writeFile").mockRejectedValue(new Error("lease write failed"));
        return file;
      });
    } else {
      const link = DirHandle.prototype.linkChild;
      vi.spyOn(DirHandle.prototype, "linkChild").mockImplementation(async function(this: DirHandle, from, to) {
        if (to === "human.lease.json") throw new Error("lease link failed");
        return link.call(this, from, to);
      });
    }
    await expect(acquireHumanLease("desk-c1ea00", env)).rejects.toThrow(`lease ${stage} failed`);
    expect(fs.readdirSync(sessionDataDir("desk-c1ea00", env))).toEqual(["permits"]);
  });

  it("returns the published lease even when staging cleanup fails", async () => {
    const unlink = DirHandle.prototype.unlinkChild;
    vi.spyOn(DirHandle.prototype, "unlinkChild").mockImplementation(async function(this: DirHandle, name) {
      if (name.startsWith(".human-lease-")) throw new Error("staging unlink failed");
      return unlink.call(this, name);
    });
    const lease = await acquireHumanLease("desk-c1ea00", env);
    expect(await readHumanLease(lease.sessionId, env)).toEqual(lease);
    await expect(acquireHumanLease(lease.sessionId, env)).rejects.toThrow(HumanLeaseHeldError);
    expect(await releaseHumanLease(lease.sessionId, lease.leaseId, env)).toBe(true);
    expect(await readHumanLease(lease.sessionId, env)).toBeUndefined();
  });

  it.each(["starting", "error", "stopped"] as const)("does not create coordination for a %s session", async (status) => {
    const record = await createSession({ type: "desktop", projectDir: tmpRoot, status }, env);
    await expect(acquireHumanLease(record.id, env)).rejects.toThrow("not running");
    expect(fs.existsSync(sessionDataDir(record.id, env))).toBe(false);
  });

  it("rolls back a lease published across the teardown status change", async () => {
    await expect(acquireHumanLease("desk-0000a1", env, {
      _afterCreate: async () => { await stopSessionAgentInput("desk-0000a1", env); },
    })).rejects.toThrow("not running");
    expect(await readHumanLease("desk-0000a1", env)).toBeUndefined();
  });

  it("refuses a second acquisition while the lease is live", async () => {
    const first = await acquireHumanLease("desk-0000a2", env);
    await expect(acquireHumanLease("desk-0000a2", env)).rejects.toThrow(HumanLeaseHeldError);
    // The live lease is untouched by the failed attempt.
    expect((await readHumanLease("desk-0000a2", env))?.leaseId).toBe(first.leaseId);
  });

  it("reports a dead-owner lease as stale and recoverable", async () => {
    const stale: HumanLease = {
      leaseId: "dead-lease",
      sessionId: "desk-0000a3",
      ownerPid: DEAD_PID,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ttlMs: 30_000,
      heartbeatMs: 5_000,
    };
    const raw = await writeRawLease("desk-0000a3", stale);
    expect(isHumanLeaseStale(stale)).toBe(true);

    let caught: StaleHumanLeaseError | undefined;
    try {
      await acquireHumanLease("desk-0000a3", env);
    } catch (error) {
      caught = error as StaleHumanLeaseError;
    }
    expect(caught).toBeInstanceOf(StaleHumanLeaseError);
    expect(caught?.lease?.leaseId).toBe("dead-lease");

    expect(await clearStaleHumanLease("desk-0000a3", raw, env)).toBe(true);
    const fresh = await acquireHumanLease("desk-0000a3", env);
    expect(fresh.leaseId).not.toBe("dead-lease");
  });

  it("reports a TTL-expired lease as stale even with a live owner", async () => {
    const expired: HumanLease = {
      leaseId: "expired-lease",
      sessionId: "desk-0000a4",
      ownerPid: process.pid,
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      ttlMs: 30_000,
      heartbeatMs: 5_000,
    };
    await writeRawLease("desk-0000a4", expired);
    await expect(acquireHumanLease("desk-0000a4", env)).rejects.toThrow(StaleHumanLeaseError);
  });

  it("drains pre-existing agent permits before returning", async () => {
    const permit = await acquireAgentPermit("desk-0000a5", env);
    const acquiring = acquireHumanLease("desk-0000a5", env, { drainTimeoutMs: 2_000 });
    // Give the drain loop a moment to observe the permit as pending, then
    // release it — acquisition must complete once it drains.
    await new Promise((resolve) => setTimeout(resolve, 60));
    await releaseAgentPermit(permit);
    await expect(acquiring).resolves.toMatchObject({ sessionId: "desk-0000a5" });
  });

  it("times out and releases its own lease when permits do not drain", async () => {
    const permit = await acquireAgentPermit("desk-0000a6", env);
    await expect(
      acquireHumanLease("desk-0000a6", env, { drainTimeoutMs: 80 }),
    ).rejects.toThrow(HumanLeaseDrainTimeoutError);
    // The lease created for the failed attempt must not linger.
    expect(await readHumanLease("desk-0000a6", env)).toBeUndefined();
    await releaseAgentPermit(permit);
  });

  it("stores leases and permits beside a legacy session record", async () => {
    const fakeHome = path.join(tmpRoot, "legacy-home");
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
    const id = "desk-a1b2c3";
    const legacySessions = path.join(fakeHome, ".picklab", "sessions");
    fs.mkdirSync(legacySessions, { recursive: true });
    fs.writeFileSync(path.join(legacySessions, `${id}.json`), JSON.stringify({
      id, type: "desktop", status: "running", createdAt: new Date().toISOString(), projectDir: tmpRoot,
    }));

    const lease = await acquireHumanLease(id, {});
    const permit = await acquireAgentPermit(id, {});
    const sidecarDir = path.join(legacySessions, id);

    expect(permit.path).toBe(
      path.join(sidecarDir, "permits", `${permit.permitId}.json`),
    );
    expect(fs.existsSync(path.join(sidecarDir, "human.lease.json"))).toBe(true);
    expect(lease.sessionId).toBe(id);
    expect(fs.existsSync(path.join(fakeHome, ".pickforge", "lab"))).toBe(false);

    await releaseAgentPermit(permit);
    await releaseHumanLease(id, lease.leaseId, {});
  });

  it("sweeps a permit owned by a dead process instead of blocking the drain", async () => {
    const dir = path.join(env.PICKFORGE_HOME as string, "sessions", "desk-0000a7", "permits");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "dead-permit.json"),
      JSON.stringify({
        permitId: "dead-permit",
        sessionId: "desk-0000a7",
        ownerPid: DEAD_PID,
        createdAt: new Date().toISOString(),
      }),
    );
    const lease = await acquireHumanLease("desk-0000a7", env, { drainTimeoutMs: 500 });
    expect(lease.sessionId).toBe("desk-0000a7");
    expect(fs.existsSync(path.join(dir, "dead-permit.json"))).toBe(false);
  });
});

describe("withAgentPermit", () => {
  it("runs the action and cleans up its permit when no lease is held", async () => {
    const result = await withAgentPermit("desk-0000b1", env, async () => "ran");
    expect(result).toBe("ran");
    const permitsDir = path.join(env.PICKFORGE_HOME as string, "sessions", "desk-0000b1", "permits");
    expect(fs.existsSync(permitsDir) ? fs.readdirSync(permitsDir) : []).toEqual([]);
  });

  it.each(["starting", "stopped", "error"] as const)("refuses a %s session without creating coordination", async (status) => {
    const session = await createSession({ type: "desktop", projectDir: tmpRoot, status }, env);
    const action = vi.fn();
    await expect(withAgentPermit(session.id, env, action)).rejects.toThrow(AgentPermitUnavailableError);
    expect(action).not.toHaveBeenCalled();
    expect(fs.existsSync(sessionDataDir(session.id, env))).toBe(false);
  });

  it("refuses a missing registry record without creating storage", async () => {
    const isolated = { PICKFORGE_HOME: path.join(tmpRoot, "missing-home") };
    await expect(acquireAgentPermit("desk-abcdef", isolated)).rejects.toThrow(AgentPermitUnavailableError);
    expect(fs.existsSync(isolated.PICKFORGE_HOME)).toBe(false);
  });

  it("refuses input if teardown occurs during permit publication", async () => {
    const session = await createSession({ type: "desktop", projectDir: tmpRoot, status: "running" }, env);
    const write = fs.promises.writeFile;
    vi.spyOn(fs.promises, "writeFile").mockImplementation(async (...args) => {
      await write(...args);
      if (String(args[0]).startsWith("/proc/self/fd/") && String(args[0]).endsWith(".json")) {
        await destroySessionRecord(session.id, env);
      }
    });
    const action = vi.fn();
    await expect(withAgentPermit(session.id, env, action)).rejects.toThrow(AgentPermitUnavailableError);
    expect(action).not.toHaveBeenCalled();
    expect(fs.readdirSync(path.join(sessionDataDir(session.id, env), "permits"))).toEqual([]);
  });

  it("types a failed lease recheck as unavailable and releases its permit", async () => {
    const open = fs.promises.open;
    vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      if (String(args[0]).endsWith("human.lease.json")) throw new Error("lease read failed");
      return open(...args);
    });
    const action = vi.fn();
    await expect(withAgentPermit("desk-0000b1", env, action)).rejects.toThrow(AgentPermitUnavailableError);
    expect(action).not.toHaveBeenCalled();
    expect(fs.readdirSync(path.join(sessionDataDir("desk-0000b1", env), "permits"))).toEqual([]);
  });

  it("rechecks the registry immediately before the action", async () => {
    const session = await createSession({ type: "desktop", projectDir: tmpRoot, status: "running" }, env);
    const open = fs.promises.open;
    vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      if (String(args[0]).endsWith("human.lease.json")) await updateSession(session.id, { status: "stopped" }, env);
      return open(...args);
    });
    const action = vi.fn();
    await expect(withAgentPermit(session.id, env, action)).rejects.toThrow(AgentPermitUnavailableError);
    expect(action).not.toHaveBeenCalled();
  });

  it("does not type action or release failures as permit refusals", async () => {
    const failure = new Error("action failed");
    await expect(withAgentPermit("desk-0000b1", env, async () => { throw failure; })).rejects.toBe(failure);
    const unlink = fs.promises.unlink;
    vi.spyOn(fs.promises, "unlink").mockImplementation(async (file) => {
      if (String(file).endsWith(".json")) throw new Error("permit release failed");
      return unlink(file);
    });
    const action = vi.fn(async () => "sent");
    const error = await withAgentPermit("desk-0000b1", env, action).catch((error: unknown) => error);
    expect(action).toHaveBeenCalledOnce();
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AgentPermitUnavailableError);
  });

  it("fails closed and never runs the action while human control is active", async () => {
    await acquireHumanLease("desk-0000b2", env);
    let ran = false;
    await expect(
      withAgentPermit("desk-0000b2", env, async () => {
        ran = true;
      }),
    ).rejects.toThrow(HumanControlActiveError);
    expect(ran).toBe(false);
    const permitsDir = path.join(env.PICKFORGE_HOME as string, "sessions", "desk-0000b2", "permits");
    expect(fs.existsSync(permitsDir) ? fs.readdirSync(permitsDir) : []).toEqual([]);
  });

  it("invalidates an in-flight permit the instant a lease appears mid-flight", async () => {
    // Simulates the race window `withAgentPermit`'s recheck closes: an agent
    // permit already exists (step 1 of the 4-step protocol) when a human
    // lease is published concurrently (elsewhere), before this permit's
    // holder gets to its recheck (step 2). Written directly rather than via
    // `acquireHumanLease`, whose drain would otherwise wait on this same
    // permit — the recheck ordering being asserted here is independent of
    // that drain mechanics.
    const permit = await acquireAgentPermit("desk-0000b3", env);
    expect(await checkHumanLeaseBusy("desk-0000b3", env)).toBeUndefined();
    const lease: HumanLease = {
      leaseId: "concurrent-lease",
      sessionId: "desk-0000b3",
      ownerPid: process.pid,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      ttlMs: 30_000,
      heartbeatMs: 5_000,
    };
    await writeRawLease("desk-0000b3", lease);
    expect(await checkHumanLeaseBusy("desk-0000b3", env)).toMatchObject({
      leaseId: "concurrent-lease",
    });
    await releaseAgentPermit(permit);
  });

  it("does not fail closed against a stale lease", async () => {
    const stale: HumanLease = {
      leaseId: "dead-lease-b4",
      sessionId: "desk-0000b4",
      ownerPid: DEAD_PID,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ttlMs: 30_000,
      heartbeatMs: 5_000,
    };
    await writeRawLease("desk-0000b4", stale);
    const result = await withAgentPermit("desk-0000b4", env, async () => "ran");
    expect(result).toBe("ran");
  });
});

describe("renewHumanLease / releaseHumanLease", () => {
  it("extends expiresAt only for the owning leaseId", async () => {
    const lease = await acquireHumanLease("desk-0000c1", env);
    const renewed = await renewHumanLease("desk-0000c1", lease.leaseId, env, {
      vncPid: 12345,
      vncPort: 5901,
    });
    expect(renewed).toBeDefined();
    expect(Date.parse(renewed!.expiresAt)).toBeGreaterThanOrEqual(
      Date.parse(lease.expiresAt),
    );
    expect(renewed?.vncPid).toBe(12345);
    expect(renewed?.vncPort).toBe(5901);

    expect(await renewHumanLease("desk-0000c1", "not-the-owner", env)).toBeUndefined();
  });

  it("refuses to resurrect a lease that has already gone stale by TTL, even for its own owner (P0-B)", async () => {
    const lease = await acquireHumanLease("desk-000c1b", env);
    // The owner is this very process (alive), but the TTL has elapsed
    // without a timely renewal — the agent must be able to observe the
    // lease as free the instant that happens, so a straggling renewal must
    // never bring it back to life out from under a recovery in flight.
    const now = new Date(Date.parse(lease.expiresAt) + 1);
    expect(isHumanLeaseStale(lease, now)).toBe(true);

    expect(
      await renewHumanLease("desk-000c1b", lease.leaseId, env, {}, now),
    ).toBeUndefined();
    // Untouched: no expiresAt extension, no partial write.
    expect(await readHumanLease("desk-000c1b", env)).toEqual(lease);
  });

  it("only releases the lease it owns", async () => {
    const lease = await acquireHumanLease("desk-0000c2", env);
    expect(await releaseHumanLease("desk-0000c2", "not-the-owner", env)).toBe(false);
    expect(await readHumanLease("desk-0000c2", env)).toBeDefined();
    expect(await releaseHumanLease("desk-0000c2", lease.leaseId, env)).toBe(true);
    expect(await readHumanLease("desk-0000c2", env)).toBeUndefined();
  });
});

describe("getTakeoverStatus", () => {
  it("reports agent-active, human-active, and stale", async () => {
    expect(await getTakeoverStatus("desk-0000d1", env)).toEqual({
      sessionId: "desk-0000d1",
      active: false,
    });

    const lease = await acquireHumanLease("desk-0000d1", env);
    const active = await getTakeoverStatus("desk-0000d1", env);
    expect(active.active).toBe(true);
    expect(active.lease?.leaseId).toBe(lease.leaseId);

    await releaseHumanLease("desk-0000d1", lease.leaseId, env);
    const stale: HumanLease = {
      leaseId: "dead-lease-d1",
      sessionId: "desk-0000d1",
      ownerPid: DEAD_PID,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ttlMs: 30_000,
      heartbeatMs: 5_000,
    };
    await writeRawLease("desk-0000d1", stale);
    const staleStatus = await getTakeoverStatus("desk-0000d1", env);
    expect(staleStatus).toMatchObject({ active: false, stale: true });
  });
});

// Real separate-process race: spawns two genuine OS processes (via `bun`, the
// repo's test runtime) so the link claim protocol is proven under real
// concurrency, not just in-process Promise.all with a single shared PID.
const BUN = /[\\/]bun$/.test(process.execPath) ? process.execPath : "bun";
const acquireWorker = fileURLToPath(
  new URL("./workers/takeover-acquire-worker.ts", import.meta.url),
);

interface ProcResult {
  code: number | null;
  stdout: string;
}

function run(args: string[]): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(BUN, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout }));
  });
}

interface ClaimOutcome {
  won: boolean;
  error?: string;
  staleRaw?: string;
  claimStart: number;
  claimEnd: number;
  releaseAt?: number;
}

async function waitForFiles(dir: string, names: string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!names.every((name) => fs.existsSync(path.join(dir, name)))) {
    if (Date.now() > deadline) throw new Error(`workers never became ready: ${names.join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("real separate-process concurrency", () => {
  it(
    "two concurrent claims yield exactly one winner",
    async () => {
      // Both workers start claiming only after both are ready, and the winner
      // holds the lease until both have attempted, so spawn skew cannot turn
      // the race into two sequential claims (#278).
      const home = path.join(tmpRoot, "race-home");
      const barrier = path.join(tmpRoot, "race-barrier");
      fs.mkdirSync(barrier);
      fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
      fs.writeFileSync(path.join(home, "sessions", "desk-aceace.json"), JSON.stringify({
        id: "desk-aceace", type: "desktop", status: "running", createdAt: new Date().toISOString(), projectDir: tmpRoot,
      }));
      const names = ["a", "b"];
      const running = names.map((name) =>
        run([acquireWorker, home, "desk-aceace", barrier, name, String(names.length)]),
      );
      await waitForFiles(barrier, names.map((name) => `ready-${name}`), 8_000);
      fs.writeFileSync(path.join(barrier, "go"), "");
      const results = await Promise.all(running);
      expect(results.map((r) => r.code)).toEqual([0, 0]);
      const outcomes = results.map((r) => JSON.parse(r.stdout.trim()) as ClaimOutcome);
      const winners = outcomes.filter((o) => o.won === true);
      const losers = outcomes.filter((o) => o.won === false);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      const [winner] = winners as [ClaimOutcome];
      const [loser] = losers as [ClaimOutcome];
      // A StaleHumanLeaseError here may be the partly written lease window
      // in #298; the raw lease content it saw is in the message.
      expect(
        loser.error,
        `loser error ${loser.error}; stale lease raw: ${JSON.stringify(loser.staleRaw)}`,
      ).toBe("HumanLeaseHeldError");
      // The claims really contended: the loser's whole attempt fell inside the
      // window in which the winner held the lease.
      expect(winner.releaseAt).toBeDefined();
      expect(loser.claimEnd).toBeLessThanOrEqual(winner.releaseAt as number);
    },
    20_000,
  );
});

describe("teardown permit draining", () => {
  it("leaves live permits and a retry record on timeout, then drains on retry", async () => {
    const permit = await acquireAgentPermit("desk-0000b1", env);
    const failure = await stopSessionAgentInput(permit.sessionId, env, 0).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AgentPermitDrainTimeoutError);
    expect((failure as AgentPermitDrainTimeoutError).pendingPermitIds).toEqual([permit.permitId]);
    expect(fs.existsSync(permit.path)).toBe(true);
    await expect(acquireAgentPermit(permit.sessionId, env)).rejects.toThrow(AgentPermitUnavailableError);
    await releaseAgentPermit(permit);
    await expect(stopSessionAgentInput(permit.sessionId, env, 0)).resolves.toBeUndefined();
  });

  it("drains old permits even when a concurrent destroy removed the registry record", async () => {
    const permit = await acquireAgentPermit("desk-0000b1", env);
    await destroySessionRecord(permit.sessionId, env);
    await expect(stopSessionAgentInput(permit.sessionId, env, 0)).rejects.toThrow(AgentPermitDrainTimeoutError);
    await releaseAgentPermit(permit);
    await expect(stopSessionAgentInput(permit.sessionId, env, 0)).resolves.toBeUndefined();
  });

  it("sweeps permits whose owner died before stopping", async () => {
    const permit = await acquireAgentPermit("desk-0000b1", env);
    fs.writeFileSync(permit.path, JSON.stringify({ ...permit, ownerPid: DEAD_PID }));
    await expect(stopSessionAgentInput(permit.sessionId, env, 0)).resolves.toBeUndefined();
    expect(fs.existsSync(permit.path)).toBe(false);
    await releaseAgentPermit(permit);
  });
});
