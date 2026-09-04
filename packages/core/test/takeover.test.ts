import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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
});

afterEach(() => {
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
    const lease = await acquireHumanLease("desk-a1", env);
    expect(lease.sessionId).toBe("desk-a1");
    expect(lease.ownerPid).toBe(process.pid);
    expect(lease.ttlMs).toBe(30_000);
    expect(lease.heartbeatMs).toBe(5_000);
    const onDisk = await readHumanLease("desk-a1", env);
    expect(onDisk).toEqual(lease);
  });

  it("refuses a second acquisition while the lease is live", async () => {
    const first = await acquireHumanLease("desk-a2", env);
    await expect(acquireHumanLease("desk-a2", env)).rejects.toThrow(HumanLeaseHeldError);
    // The live lease is untouched by the failed attempt.
    expect((await readHumanLease("desk-a2", env))?.leaseId).toBe(first.leaseId);
  });

  it("reports a dead-owner lease as stale and recoverable", async () => {
    const stale: HumanLease = {
      leaseId: "dead-lease",
      sessionId: "desk-a3",
      ownerPid: DEAD_PID,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ttlMs: 30_000,
      heartbeatMs: 5_000,
    };
    const raw = await writeRawLease("desk-a3", stale);
    expect(isHumanLeaseStale(stale)).toBe(true);

    let caught: StaleHumanLeaseError | undefined;
    try {
      await acquireHumanLease("desk-a3", env);
    } catch (error) {
      caught = error as StaleHumanLeaseError;
    }
    expect(caught).toBeInstanceOf(StaleHumanLeaseError);
    expect(caught?.lease?.leaseId).toBe("dead-lease");

    expect(await clearStaleHumanLease("desk-a3", raw, env)).toBe(true);
    const fresh = await acquireHumanLease("desk-a3", env);
    expect(fresh.leaseId).not.toBe("dead-lease");
  });

  it("reports a TTL-expired lease as stale even with a live owner", async () => {
    const expired: HumanLease = {
      leaseId: "expired-lease",
      sessionId: "desk-a4",
      ownerPid: process.pid,
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      ttlMs: 30_000,
      heartbeatMs: 5_000,
    };
    await writeRawLease("desk-a4", expired);
    await expect(acquireHumanLease("desk-a4", env)).rejects.toThrow(StaleHumanLeaseError);
  });

  it("drains pre-existing agent permits before returning", async () => {
    const permit = await acquireAgentPermit("desk-a5", env);
    const acquiring = acquireHumanLease("desk-a5", env, { drainTimeoutMs: 2_000 });
    // Give the drain loop a moment to observe the permit as pending, then
    // release it — acquisition must complete once it drains.
    await new Promise((resolve) => setTimeout(resolve, 60));
    await releaseAgentPermit(permit);
    await expect(acquiring).resolves.toMatchObject({ sessionId: "desk-a5" });
  });

  it("times out and releases its own lease when permits do not drain", async () => {
    const permit = await acquireAgentPermit("desk-a6", env);
    await expect(
      acquireHumanLease("desk-a6", env, { drainTimeoutMs: 80 }),
    ).rejects.toThrow(HumanLeaseDrainTimeoutError);
    // The lease created for the failed attempt must not linger.
    expect(await readHumanLease("desk-a6", env)).toBeUndefined();
    await releaseAgentPermit(permit);
  });

  it("stores leases and permits beside a legacy session record", async () => {
    const fakeHome = path.join(tmpRoot, "legacy-home");
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
    const id = "desk-a1b2c3";
    const legacySessions = path.join(fakeHome, ".picklab", "sessions");
    fs.mkdirSync(legacySessions, { recursive: true });
    fs.writeFileSync(path.join(legacySessions, `${id}.json`), "{}\n");

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
    const dir = path.join(env.PICKFORGE_HOME as string, "sessions", "desk-a7", "permits");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "dead-permit.json"),
      JSON.stringify({
        permitId: "dead-permit",
        sessionId: "desk-a7",
        ownerPid: DEAD_PID,
        createdAt: new Date().toISOString(),
      }),
    );
    const lease = await acquireHumanLease("desk-a7", env, { drainTimeoutMs: 500 });
    expect(lease.sessionId).toBe("desk-a7");
    expect(fs.existsSync(path.join(dir, "dead-permit.json"))).toBe(false);
  });
});

describe("withAgentPermit", () => {
  it("runs the action and cleans up its permit when no lease is held", async () => {
    const result = await withAgentPermit("desk-b1", env, async () => "ran");
    expect(result).toBe("ran");
    const permitsDir = path.join(env.PICKFORGE_HOME as string, "sessions", "desk-b1", "permits");
    expect(fs.existsSync(permitsDir) ? fs.readdirSync(permitsDir) : []).toEqual([]);
  });

  it("fails closed and never runs the action while human control is active", async () => {
    await acquireHumanLease("desk-b2", env);
    let ran = false;
    await expect(
      withAgentPermit("desk-b2", env, async () => {
        ran = true;
      }),
    ).rejects.toThrow(HumanControlActiveError);
    expect(ran).toBe(false);
    const permitsDir = path.join(env.PICKFORGE_HOME as string, "sessions", "desk-b2", "permits");
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
    const permit = await acquireAgentPermit("desk-b3", env);
    expect(await checkHumanLeaseBusy("desk-b3", env)).toBeUndefined();
    const lease: HumanLease = {
      leaseId: "concurrent-lease",
      sessionId: "desk-b3",
      ownerPid: process.pid,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      ttlMs: 30_000,
      heartbeatMs: 5_000,
    };
    await writeRawLease("desk-b3", lease);
    expect(await checkHumanLeaseBusy("desk-b3", env)).toMatchObject({
      leaseId: "concurrent-lease",
    });
    await releaseAgentPermit(permit);
  });

  it("does not fail closed against a stale lease", async () => {
    const stale: HumanLease = {
      leaseId: "dead-lease-b4",
      sessionId: "desk-b4",
      ownerPid: DEAD_PID,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ttlMs: 30_000,
      heartbeatMs: 5_000,
    };
    await writeRawLease("desk-b4", stale);
    const result = await withAgentPermit("desk-b4", env, async () => "ran");
    expect(result).toBe("ran");
  });
});

describe("renewHumanLease / releaseHumanLease", () => {
  it("extends expiresAt only for the owning leaseId", async () => {
    const lease = await acquireHumanLease("desk-c1", env);
    const renewed = await renewHumanLease("desk-c1", lease.leaseId, env, {
      vncPid: 12345,
      vncPort: 5901,
    });
    expect(renewed).toBeDefined();
    expect(Date.parse(renewed!.expiresAt)).toBeGreaterThanOrEqual(
      Date.parse(lease.expiresAt),
    );
    expect(renewed?.vncPid).toBe(12345);
    expect(renewed?.vncPort).toBe(5901);

    expect(await renewHumanLease("desk-c1", "not-the-owner", env)).toBeUndefined();
  });

  it("refuses to resurrect a lease that has already gone stale by TTL, even for its own owner (P0-B)", async () => {
    const lease = await acquireHumanLease("desk-c1b", env);
    // The owner is this very process (alive), but the TTL has elapsed
    // without a timely renewal — the agent must be able to observe the
    // lease as free the instant that happens, so a straggling renewal must
    // never bring it back to life out from under a recovery in flight.
    const now = new Date(Date.parse(lease.expiresAt) + 1);
    expect(isHumanLeaseStale(lease, now)).toBe(true);

    expect(
      await renewHumanLease("desk-c1b", lease.leaseId, env, {}, now),
    ).toBeUndefined();
    // Untouched: no expiresAt extension, no partial write.
    expect(await readHumanLease("desk-c1b", env)).toEqual(lease);
  });

  it("only releases the lease it owns", async () => {
    const lease = await acquireHumanLease("desk-c2", env);
    expect(await releaseHumanLease("desk-c2", "not-the-owner", env)).toBe(false);
    expect(await readHumanLease("desk-c2", env)).toBeDefined();
    expect(await releaseHumanLease("desk-c2", lease.leaseId, env)).toBe(true);
    expect(await readHumanLease("desk-c2", env)).toBeUndefined();
  });
});

describe("getTakeoverStatus", () => {
  it("reports agent-active, human-active, and stale", async () => {
    expect(await getTakeoverStatus("desk-d1", env)).toEqual({
      sessionId: "desk-d1",
      active: false,
    });

    const lease = await acquireHumanLease("desk-d1", env);
    const active = await getTakeoverStatus("desk-d1", env);
    expect(active.active).toBe(true);
    expect(active.lease?.leaseId).toBe(lease.leaseId);

    await releaseHumanLease("desk-d1", lease.leaseId, env);
    const stale: HumanLease = {
      leaseId: "dead-lease-d1",
      sessionId: "desk-d1",
      ownerPid: DEAD_PID,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ttlMs: 30_000,
      heartbeatMs: 5_000,
    };
    await writeRawLease("desk-d1", stale);
    const staleStatus = await getTakeoverStatus("desk-d1", env);
    expect(staleStatus).toMatchObject({ active: false, stale: true });
  });
});

// Real separate-process race: spawns two genuine OS processes (via `bun`, the
// repo's test runtime) so the `wx` claim protocol is proven under real
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

describe("real separate-process concurrency", () => {
  it(
    "two concurrent claims yield exactly one winner",
    async () => {
      const home = path.join(tmpRoot, "race-home");
      const results = await Promise.all([
        run([acquireWorker, home, "desk-race", "150"]),
        run([acquireWorker, home, "desk-race", "150"]),
      ]);
      const outcomes = results.map((r) => JSON.parse(r.stdout.trim()) as { won: boolean });
      const winners = outcomes.filter((o) => o.won === true);
      const losers = outcomes.filter((o) => o.won === false);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
    },
    10_000,
  );
});
