import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentPermitUnavailableError,
  DirHandle,
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
  type EnvLike,
  type HumanLease,
} from "../src/index.js";

const DEAD_PID = 999_999;

let tmpRoot: string;
let env: EnvLike;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-takeover-test-"));
  env = { ...process.env, PICKFORGE_HOME: path.join(tmpRoot, "home") };
  const sessions = path.join(env.PICKFORGE_HOME as string, "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  // Coordination writes now require a live registry record.
  for (const id of ["desk-06a28cdb", "desk-08c87df1", "desk-09ea5ef3", "desk-0d065af2", "desk-0ef40916", "desk-11d6d2af", "desk-1eecaf4d", "desk-21829c99", "desk-34247649", "desk-34247649b2c3", "desk-7a9f5b8d", "desk-7ad2088a", "desk-8cb30b00", "desk-91bceeee", "desk-9213f980", "desk-930edda2", "desk-93d7ed9b", "desk-c4823b42", "desk-c492fdc4", "desk-cd747efb", "desk-d787225d", "desk-e259da98", "desk-e25c3d12", "desk-f2ad1c67", "desk-f2ad1c67b"]) {
    fs.writeFileSync(path.join(sessions, `${id}.json`), JSON.stringify({ id, type: "desktop", status: "running", projectDir: tmpRoot, createdAt: new Date().toISOString() }));
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
    const lease = await acquireHumanLease("desk-34247649", env);
    expect(lease.sessionId).toBe("desk-34247649");
    expect(lease.ownerPid).toBe(process.pid);
    expect(lease.ttlMs).toBe(30_000);
    expect(lease.heartbeatMs).toBe(5_000);
    const onDisk = await readHumanLease("desk-34247649", env);
    expect(onDisk).toEqual(lease);
  });

  it("publishes complete linked bytes before a peer can read the lease", async () => {
    const link = DirHandle.prototype.linkChild;
    let published = false;
    vi.spyOn(DirHandle.prototype, "linkChild").mockImplementation(async function(this: DirHandle, from, to) {
      if (to !== "human.lease.json") return link.call(this, from, to);
      const raw = fs.readFileSync(this.resolve(from), "utf8");
      expect(JSON.parse(raw)).toMatchObject({ sessionId: "desk-08c87df1", ownerPid: process.pid });
      await link.call(this, from, to);
      published = true;
      expect(fs.statSync(this.resolve(to)).nlink).toBe(2);
      expect(fs.readFileSync(this.resolve(to), "utf8")).toBe(raw);
      expect(await readHumanLease("desk-08c87df1", env)).toEqual(JSON.parse(raw));
    });
    const lease = await acquireHumanLease("desk-08c87df1", env);
    expect(published).toBe(true);
    await expect(acquireHumanLease(lease.sessionId, env)).rejects.toThrow(HumanLeaseHeldError);
    const dir = path.join(env.PICKFORGE_HOME as string, "sessions", lease.sessionId);
    expect(fs.readdirSync(dir).sort()).toEqual(["human.lease.json", "permits"]);
    expect(fs.statSync(path.join(dir, "human.lease.json")).nlink).toBe(1);
    expect(await readHumanLease(lease.sessionId, env)).toEqual(lease);
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
    await expect(acquireHumanLease("desk-e25c3d12", env)).rejects.toThrow(`lease ${stage} failed`);
    expect(fs.readdirSync(path.join(env.PICKFORGE_HOME as string, "sessions", "desk-e25c3d12"))).toEqual(["permits"]);
  });

  it("propagates staging EEXIST unchanged instead of reporting lease contention", async () => {
    const failure = Object.assign(new Error("staging file already exists"), { code: "EEXIST" });
    const write = DirHandle.prototype.writeFileAtomic;
    vi.spyOn(DirHandle.prototype, "writeFileAtomic").mockImplementation(async function(this: DirHandle, name, content) {
      if (name.startsWith(".human-lease-")) throw failure;
      return write.call(this, name, content);
    });
    await expect(acquireHumanLease("desk-0d065af2", env)).rejects.toBe(failure);
    expect(await readHumanLease("desk-0d065af2", env)).toBeUndefined();
  });

  it("returns the published lease even when staging cleanup fails", async () => {
    const unlink = DirHandle.prototype.unlinkChild;
    vi.spyOn(DirHandle.prototype, "unlinkChild").mockImplementation(async function(this: DirHandle, name) {
      if (name.startsWith(".human-lease-")) throw new Error("staging unlink failed");
      return unlink.call(this, name);
    });
    const lease = await acquireHumanLease("desk-e25c3d12", env);
    expect(await readHumanLease(lease.sessionId, env)).toEqual(lease);
    await expect(acquireHumanLease(lease.sessionId, env)).rejects.toThrow(HumanLeaseHeldError);
    expect(await releaseHumanLease(lease.sessionId, lease.leaseId, env)).toBe(true);
    expect(await readHumanLease(lease.sessionId, env)).toBeUndefined();
  });

  it("refuses a second acquisition while the lease is live", async () => {
    const first = await acquireHumanLease("desk-e259da98", env);
    await expect(acquireHumanLease("desk-e259da98", env)).rejects.toThrow(HumanLeaseHeldError);
    // The live lease is untouched by the failed attempt.
    expect((await readHumanLease("desk-e259da98", env))?.leaseId).toBe(first.leaseId);
  });

  it("reports a dead-owner lease as stale and recoverable", async () => {
    const stale: HumanLease = {
      leaseId: "dead-lease",
      sessionId: "desk-c4823b42",
      ownerPid: DEAD_PID,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ttlMs: 30_000,
      heartbeatMs: 5_000,
    };
    const raw = await writeRawLease("desk-c4823b42", stale);
    expect(isHumanLeaseStale(stale)).toBe(true);

    let caught: StaleHumanLeaseError | undefined;
    try {
      await acquireHumanLease("desk-c4823b42", env);
    } catch (error) {
      caught = error as StaleHumanLeaseError;
    }
    expect(caught).toBeInstanceOf(StaleHumanLeaseError);
    expect(caught?.lease?.leaseId).toBe("dead-lease");

    expect(await clearStaleHumanLease("desk-c4823b42", raw, env)).toBe(true);
    const fresh = await acquireHumanLease("desk-c4823b42", env);
    expect(fresh.leaseId).not.toBe("dead-lease");
  });

  it("reports a TTL-expired lease as stale even with a live owner", async () => {
    const expired: HumanLease = {
      leaseId: "expired-lease",
      sessionId: "desk-cd747efb",
      ownerPid: process.pid,
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      ttlMs: 30_000,
      heartbeatMs: 5_000,
    };
    await writeRawLease("desk-cd747efb", expired);
    await expect(acquireHumanLease("desk-cd747efb", env)).rejects.toThrow(StaleHumanLeaseError);
  });

  it("drains pre-existing agent permits before returning", async () => {
    const permit = await acquireAgentPermit("desk-09ea5ef3", env);
    const acquiring = acquireHumanLease("desk-09ea5ef3", env, { drainTimeoutMs: 2_000 });
    // Give the drain loop a moment to observe the permit as pending, then
    // release it — acquisition must complete once it drains.
    await new Promise((resolve) => setTimeout(resolve, 60));
    await releaseAgentPermit(permit);
    await expect(acquiring).resolves.toMatchObject({ sessionId: "desk-09ea5ef3" });
  });

  it("times out and releases its own lease when permits do not drain", async () => {
    const permit = await acquireAgentPermit("desk-1eecaf4d", env);
    await expect(
      acquireHumanLease("desk-1eecaf4d", env, { drainTimeoutMs: 80 }),
    ).rejects.toThrow(HumanLeaseDrainTimeoutError);
    // The lease created for the failed attempt must not linger.
    expect(await readHumanLease("desk-1eecaf4d", env)).toBeUndefined();
    await releaseAgentPermit(permit);
  });

  it("stores leases and permits beside a legacy session record", async () => {
    const fakeHome = path.join(tmpRoot, "legacy-home");
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
    const id = "desk-34247649b2c3";
    const legacySessions = path.join(fakeHome, ".picklab", "sessions");
    fs.mkdirSync(legacySessions, { recursive: true });
    fs.writeFileSync(path.join(legacySessions, `${id}.json`), JSON.stringify({ id, status: "running" }));

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
    const dir = path.join(env.PICKFORGE_HOME as string, "sessions", "desk-93d7ed9b", "permits");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "dead-permit.json"),
      JSON.stringify({
        permitId: "dead-permit",
        sessionId: "desk-93d7ed9b",
        ownerPid: DEAD_PID,
        createdAt: new Date().toISOString(),
      }),
    );
    const lease = await acquireHumanLease("desk-93d7ed9b", env, { drainTimeoutMs: 500 });
    expect(lease.sessionId).toBe("desk-93d7ed9b");
    expect(fs.existsSync(path.join(dir, "dead-permit.json"))).toBe(false);
  });
});

describe("withAgentPermit", () => {
  it("runs the action and cleans up its permit when no lease is held", async () => {
    const result = await withAgentPermit("desk-21829c99", env, async () => "ran");
    expect(result).toBe("ran");
    const permitsDir = path.join(env.PICKFORGE_HOME as string, "sessions", "desk-21829c99", "permits");
    expect(fs.existsSync(permitsDir) ? fs.readdirSync(permitsDir) : []).toEqual([]);
  });

  it("types storage failures during acquisition without running the action", async () => {
    const failure = new Error("permit storage failed");
    const write = DirHandle.prototype.writeFileAtomic;
    vi.spyOn(DirHandle.prototype, "writeFileAtomic").mockImplementation(async function (this: DirHandle, name, content) {
      if (name.startsWith(".agent-permit-")) throw failure;
      return write.call(this, name, content);
    });
    const action = vi.fn(async () => "sent");
    const error = await withAgentPermit("desk-0ef40916", env, action).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AgentPermitUnavailableError);
    expect(error).toMatchObject({ code: "agent_permit_unavailable", cause: failure });
    expect(action).not.toHaveBeenCalled();
  });

  it.each([false, true])("types recheck failures and releases the permit, cleanup failure=%s", async (cleanupFails) => {
    const failure = new Error("lease read failed");
    const open = fs.promises.open;
    vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      if (String(args[0]).endsWith("human.lease.json")) throw failure;
      return open(...args);
    });
    const unlink = fs.promises.unlink;
    const release = vi.spyOn(fs.promises, "unlink").mockImplementation(async (file) => {
      if (cleanupFails && String(file).endsWith(".json")) throw new Error("permit release failed");
      return unlink(file);
    });
    const action = vi.fn(async () => "sent");
    const error = await withAgentPermit("desk-d787225d", env, action).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AgentPermitUnavailableError);
    expect(error).toMatchObject({ cause: failure });
    expect(action).not.toHaveBeenCalled();
    expect(release.mock.calls.filter(([file]) => String(file).endsWith(".json"))).toHaveLength(1);
    const dir = path.join(env.PICKFORGE_HOME as string, "sessions", "desk-d787225d", "permits");
    expect(fs.readdirSync(dir)).toHaveLength(cleanupFails ? 1 : 0);
  });

  it("keeps human refusal when releasing its permit also fails", async () => {
    await acquireHumanLease("desk-06a28cdb", env);
    vi.spyOn(fs.promises, "unlink").mockRejectedValue(new Error("permit release failed"));
    const action = vi.fn(async () => "sent");
    await expect(withAgentPermit("desk-06a28cdb", env, action)).rejects.toThrow(HumanControlActiveError);
    expect(action).not.toHaveBeenCalled();
  });

  it("propagates an action error unchanged and releases its permit", async () => {
    const failure = new Error("action failed");
    await expect(withAgentPermit("desk-7ad2088a", env, async () => { throw failure; })).rejects.toBe(failure);
    const dir = path.join(env.PICKFORGE_HOME as string, "sessions", "desk-7ad2088a", "permits");
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("propagates release failures after the action unchanged", async () => {
    const failure = new Error("permit release failed");
    const unlink = fs.promises.unlink;
    vi.spyOn(fs.promises, "unlink").mockImplementation(async (file) => {
      if (String(file).endsWith(".json")) throw failure;
      return unlink(file);
    });
    const action = vi.fn(async () => "sent");
    await expect(withAgentPermit("desk-930edda2", env, action)).rejects.toBe(failure);
    expect(action).toHaveBeenCalledOnce();
  });

  it("fails closed and never runs the action while human control is active", async () => {
    await acquireHumanLease("desk-8cb30b00", env);
    let ran = false;
    await expect(
      withAgentPermit("desk-8cb30b00", env, async () => {
        ran = true;
      }),
    ).rejects.toThrow(HumanControlActiveError);
    expect(ran).toBe(false);
    const permitsDir = path.join(env.PICKFORGE_HOME as string, "sessions", "desk-8cb30b00", "permits");
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
    const permit = await acquireAgentPermit("desk-7a9f5b8d", env);
    expect(await checkHumanLeaseBusy("desk-7a9f5b8d", env)).toBeUndefined();
    const lease: HumanLease = {
      leaseId: "concurrent-lease",
      sessionId: "desk-7a9f5b8d",
      ownerPid: process.pid,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      ttlMs: 30_000,
      heartbeatMs: 5_000,
    };
    await writeRawLease("desk-7a9f5b8d", lease);
    expect(await checkHumanLeaseBusy("desk-7a9f5b8d", env)).toMatchObject({
      leaseId: "concurrent-lease",
    });
    await releaseAgentPermit(permit);
  });

  it("does not fail closed against a stale lease", async () => {
    const stale: HumanLease = {
      leaseId: "dead-lease-b4",
      sessionId: "desk-c492fdc4",
      ownerPid: DEAD_PID,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ttlMs: 30_000,
      heartbeatMs: 5_000,
    };
    await writeRawLease("desk-c492fdc4", stale);
    const result = await withAgentPermit("desk-c492fdc4", env, async () => "ran");
    expect(result).toBe("ran");
  });
});

describe("renewHumanLease / releaseHumanLease", () => {
  it("extends expiresAt only for the owning leaseId", async () => {
    const lease = await acquireHumanLease("desk-f2ad1c67", env);
    const renewed = await renewHumanLease("desk-f2ad1c67", lease.leaseId, env, {
      vncPid: 12345,
      vncPort: 5901,
    });
    expect(renewed).toBeDefined();
    expect(Date.parse(renewed!.expiresAt)).toBeGreaterThanOrEqual(
      Date.parse(lease.expiresAt),
    );
    expect(renewed?.vncPid).toBe(12345);
    expect(renewed?.vncPort).toBe(5901);

    expect(await renewHumanLease("desk-f2ad1c67", "not-the-owner", env)).toBeUndefined();
  });

  it("refuses to resurrect a lease that has already gone stale by TTL, even for its own owner (P0-B)", async () => {
    const lease = await acquireHumanLease("desk-f2ad1c67b", env);
    // The owner is this very process (alive), but the TTL has elapsed
    // without a timely renewal — the agent must be able to observe the
    // lease as free the instant that happens, so a straggling renewal must
    // never bring it back to life out from under a recovery in flight.
    const now = new Date(Date.parse(lease.expiresAt) + 1);
    expect(isHumanLeaseStale(lease, now)).toBe(true);

    expect(
      await renewHumanLease("desk-f2ad1c67b", lease.leaseId, env, {}, now),
    ).toBeUndefined();
    // Untouched: no expiresAt extension, no partial write.
    expect(await readHumanLease("desk-f2ad1c67b", env)).toEqual(lease);
  });

  it("only releases the lease it owns", async () => {
    const lease = await acquireHumanLease("desk-9213f980", env);
    expect(await releaseHumanLease("desk-9213f980", "not-the-owner", env)).toBe(false);
    expect(await readHumanLease("desk-9213f980", env)).toBeDefined();
    expect(await releaseHumanLease("desk-9213f980", lease.leaseId, env)).toBe(true);
    expect(await readHumanLease("desk-9213f980", env)).toBeUndefined();
  });
});

describe("getTakeoverStatus", () => {
  it("reports agent-active, human-active, and stale", async () => {
    expect(await getTakeoverStatus("desk-11d6d2af", env)).toEqual({
      sessionId: "desk-11d6d2af",
      active: false,
    });

    const lease = await acquireHumanLease("desk-11d6d2af", env);
    const active = await getTakeoverStatus("desk-11d6d2af", env);
    expect(active.active).toBe(true);
    expect(active.lease?.leaseId).toBe(lease.leaseId);

    await releaseHumanLease("desk-11d6d2af", lease.leaseId, env);
    const stale: HumanLease = {
      leaseId: "dead-lease-d1",
      sessionId: "desk-11d6d2af",
      ownerPid: DEAD_PID,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ttlMs: 30_000,
      heartbeatMs: 5_000,
    };
    await writeRawLease("desk-11d6d2af", stale);
    const staleStatus = await getTakeoverStatus("desk-11d6d2af", env);
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
      fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
      fs.writeFileSync(path.join(home, "sessions", "desk-91bceeee.json"), JSON.stringify({ id: "desk-91bceeee", status: "running" }));
      const barrier = path.join(tmpRoot, "race-barrier");
      fs.mkdirSync(barrier);
      const names = ["a", "b"];
      const running = names.map((name) =>
        run([acquireWorker, home, "desk-91bceeee", barrier, name, String(names.length)]),
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
