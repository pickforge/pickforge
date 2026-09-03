import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `startVnc` requires a verified `/proc`-backed process identity for the
// spawned x11vnc daemon, which does not exist on Darwin. These tests prove
// the takeover orchestration (lease acquisition, VNC mode switching,
// evidence, recovery) end-to-end against *real* spawned fake-x11vnc
// processes and real port listening, with only the two `/proc`-dependent
// identity functions replaced by a deterministic, pid-keyed stand-in — the
// same technique `destroy.test.ts` uses. Real x11vnc/Xvfb hardware
// validation is deferred (see AGENTS.md / release notes).
// `readHumanLeaseRaw` is wrapped (not replaced) so individual tests can
// inject an interleaving action between recovery's two staleness checks via
// `mockImplementationOnce`, while every other call still runs the real
// implementation.
vi.mock("@pickforge/lab-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pickforge/lab-core")>();
  return {
    ...actual,
    readProcessIdentity: vi.fn((pid: number) => ({ pid, startTicks: pid })),
    processIdentityMatches: vi.fn(
      ({ pid, startTicks }: { pid: number; startTicks: number }) => startTicks === pid,
    ),
    readHumanLeaseRaw: vi.fn(actual.readHumanLeaseRaw),
  };
});

import {
  HumanLeaseHeldError,
  createSession,
  getSession,
  isPidAlive,
  readActions,
  readHumanLease,
  readHumanLeaseRaw,
  resolveActivePointer,
  resolveRunStorage,
  stopPid,
  type EnvLike,
} from "@pickforge/lab-core";
import {
  endHumanTakeover,
  recoverStaleHumanLease,
  renewHumanTakeover,
  startHumanTakeover,
} from "../src/takeover.js";
import { startVnc } from "../src/vnc.js";

let root: string;
let binDir: string;
let env: EnvLike;
let argvLogPath: string;
// Monotonic across the whole file (never reset per test) so a test that fails
// before releasing its port never collides with the next test's port.
let syntheticPort = 15_900;

function nextPort(): number {
  syntheticPort += 1;
  return syntheticPort;
}

async function installFakeVnc(): Promise<void> {
  const script = path.join(binDir, "x11vnc");
  const source = [
    "const net = require('node:net');",
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "fs.appendFileSync(process.env.ARGV_LOG, JSON.stringify(args) + '\\n');",
    "const port = Number(args[args.indexOf('-rfbport') + 1]);",
    "const server = net.createServer((socket) => socket.end());",
    "server.listen(port, '127.0.0.1');",
    "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
  ].join("\n");
  await fs.promises.writeFile(script, `#!${process.execPath}\n${source}`, "utf8");
  await fs.promises.chmod(script, 0o755);
}

async function readArgvLog(): Promise<string[][]> {
  const raw = await fs.promises.readFile(argvLogPath, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as string[]);
}

async function createDesktop(desktop: Record<string, unknown> = {}): Promise<string> {
  const record = await createSession(
    {
      type: "desktop",
      projectDir: root,
      status: "running",
      desktop: { display: ":42", ...desktop },
    },
    env,
  );
  return record.id;
}

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pickforge-lab-takeover-dl-"));
  binDir = path.join(root, "bin");
  await fs.promises.mkdir(binDir, { recursive: true });
  argvLogPath = path.join(root, "argv.log");
  env = {
    ...process.env,
    PICKFORGE_HOME: path.join(root, "home"),
    PATH: binDir,
    ARGV_LOG: argvLogPath,
  };
  await installFakeVnc();
});

afterEach(async () => {
  vi.clearAllMocks();
  // Force-kill any fake x11vnc process a failed assertion left running, so a
  // failure in one test never blocks a later test's port.
  const sessionsDir = path.join(env.PICKFORGE_HOME as string, "sessions");
  const entries = await fs.promises.readdir(sessionsDir).catch(() => [] as string[]);
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const id = entry.slice(0, -".json".length);
    const record = await getSession(id, env).catch(() => undefined);
    const pid = record?.desktop?.vncPid;
    if (pid !== undefined && isPidAlive(pid)) {
      await stopPid(pid, { timeoutMs: 500 }).catch(() => {});
    }
  }
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe("startHumanTakeover / endHumanTakeover", () => {
  it("switches VNC writable on start and back to read-only on return, releasing the lease", async () => {
    const id = await createDesktop({ vncPort: nextPort() });

    const handle = await startHumanTakeover(id, {
      registryEnv: env,
      env,
      drainTimeoutMs: 500,
    });
    expect(handle.sessionId).toBe(id);
    expect(isPidAlive(handle.vncPid)).toBe(true);
    expect((await readHumanLease(id, env))?.leaseId).toBe(handle.leaseId);

    const afterStart = await getSession(id, env);
    expect(afterStart?.desktop?.vncViewOnly).toBe(false);
    expect(afterStart?.desktop?.vncPid).toBe(handle.vncPid);

    const startArgv = await readArgvLog();
    expect(startArgv).toHaveLength(1);
    expect(startArgv[0]).not.toContain("-viewonly");

    const startedVncPid = handle.vncPid;
    const result = await endHumanTakeover(handle, {
      registryEnv: env,
      env,
      reason: "return",
    });
    expect(result.reason).toBe("return");
    expect(isPidAlive(startedVncPid)).toBe(false);
    expect(await readHumanLease(id, env)).toBeUndefined();

    const afterEnd = await getSession(id, env);
    expect(afterEnd?.desktop?.vncViewOnly).toBe(true);
    expect(afterEnd?.desktop?.vncPid).not.toBe(startedVncPid);

    const fullArgv = await readArgvLog();
    expect(fullArgv).toHaveLength(2);
    expect(fullArgv[1]).toContain("-viewonly");
  });

  it("records a takeover_start and takeover_<reason> evidence transition, and reverts VNC to read-only on the cancelled path", async () => {
    const id = await createDesktop({ vncPort: nextPort() });
    const handle = await startHumanTakeover(id, { registryEnv: env, env });
    await endHumanTakeover(handle, { registryEnv: env, env, reason: "cancelled" });

    // The cancelled exit path reverts VNC to read-only exactly like the
    // return path: writable on start, `-viewonly` on end — never left
    // writable because the reason for ending was "cancelled" rather than
    // "return".
    const cancelledArgv = await readArgvLog();
    expect(cancelledArgv).toHaveLength(2);
    expect(cancelledArgv[0]).not.toContain("-viewonly");
    expect(cancelledArgv[1]).toContain("-viewonly");

    const pointerless = await resolveActivePointer(root, id, env);
    // The evidence run was finalized by nothing yet (no destroySessionRecord
    // call), so it is still resolvable as the session's active run.
    expect(pointerless.status === "active" || pointerless.status === "stale").toBe(
      true,
    );
    const runId =
      pointerless.status === "active" ? pointerless.pointer.runId : undefined;
    if (runId !== undefined) {
      const { runsDir } = await resolveRunStorage(root, env);
      const actions = await readActions(path.join(runsDir, runId));
      const tools = actions.map((a) => (a as { tool?: string }).tool);
      expect(tools).toContain("takeover_start");
      expect(tools).toContain("takeover_cancelled");
    }
  });

  it("refuses a second takeover while the first is live", async () => {
    const id = await createDesktop({ vncPort: nextPort() });
    const handle = await startHumanTakeover(id, { registryEnv: env, env });
    await expect(
      startHumanTakeover(id, { registryEnv: env, env }),
    ).rejects.toThrow(HumanLeaseHeldError);
    await endHumanTakeover(handle, { registryEnv: env, env, reason: "return" });
  });

  it("renews the lease TTL while control is held, and reverts VNC to read-only on the timeout path", async () => {
    const id = await createDesktop({ vncPort: nextPort() });
    const handle = await startHumanTakeover(id, { registryEnv: env, env });
    const before = await readHumanLease(id, env);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const renewed = await renewHumanTakeover(handle, env);
    expect(renewed).toBeDefined();
    const after = await readHumanLease(id, env);
    expect(Date.parse(after!.expiresAt)).toBeGreaterThanOrEqual(
      Date.parse(before!.expiresAt),
    );
    await endHumanTakeover(handle, { registryEnv: env, env, reason: "timeout" });

    // The timeout exit path also reverts VNC to read-only — writable never
    // outlives the lease on this path either.
    const timeoutArgv = await readArgvLog();
    expect(timeoutArgv).toHaveLength(2);
    expect(timeoutArgv[0]).not.toContain("-viewonly");
    expect(timeoutArgv[1]).toContain("-viewonly");
  });

  it("reports renewal failure once the lease is gone (post-timeout)", async () => {
    const id = await createDesktop({ vncPort: nextPort() });
    const handle = await startHumanTakeover(id, { registryEnv: env, env });
    await endHumanTakeover(handle, { registryEnv: env, env, reason: "timeout" });
    expect(await renewHumanTakeover(handle, env)).toBeUndefined();
  });

  it("refuses to renew a lease that has gone stale by TTL, even though its owner is alive (P0-B)", async () => {
    const id = await createDesktop({ vncPort: nextPort() });
    const handle = await startHumanTakeover(id, { registryEnv: env, env });
    // Force the on-disk lease's TTL into the past directly, rather than
    // racing a real wall-clock sleep against real VNC startup timing: the
    // owner (this process) is still very much alive, but the lease must be
    // treated as free once its TTL has passed regardless.
    const current = await readHumanLease(id, env);
    await fs.promises.writeFile(
      path.join(env.PICKFORGE_HOME as string, "sessions", id, "human.lease.json"),
      `${JSON.stringify({ ...current, expiresAt: new Date(Date.now() - 1_000).toISOString() })}\n`,
    );
    expect(await readHumanLease(id, env)).toMatchObject({
      leaseId: handle.leaseId,
    });
    expect(await renewHumanTakeover(handle, env)).toBeUndefined();
    // The stale lease is left exactly as it was — a late renewal must never
    // resurrect it, so a concurrent acquirer can safely reclaim it.
    expect(await readHumanLease(id, env)).toMatchObject({ leaseId: handle.leaseId });

    const { recovered } = await recoverStaleHumanLease(id, env);
    expect(recovered).toBe(true);
    expect(await readHumanLease(id, env)).toBeUndefined();
  });
});

describe("recoverStaleHumanLease (crash recovery)", () => {
  it("stops an orphaned writable VNC, clears the record, and releases a stale lease", async () => {
    const id = await createDesktop({ vncPort: nextPort() });
    const handle = await startHumanTakeover(id, { registryEnv: env, env });
    const vncPid = handle.vncPid;
    expect(isPidAlive(vncPid)).toBe(true);

    // Simulate a crash: the owner process is gone and the TTL has lapsed,
    // but nobody ran the graceful `endHumanTakeover` cleanup.
    const crashed = {
      ...(await readHumanLease(id, env))!,
      ownerPid: 999_999,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    };
    await fs.promises.writeFile(
      path.join(env.PICKFORGE_HOME as string, "sessions", id, "human.lease.json"),
      `${JSON.stringify(crashed)}\n`,
    );

    const { recovered } = await recoverStaleHumanLease(id, env);
    expect(recovered).toBe(true);
    expect(isPidAlive(vncPid)).toBe(false);
    expect(await readHumanLease(id, env)).toBeUndefined();
    const record = await getSession(id, env);
    expect(record?.desktop?.vncPid).toBeUndefined();
    expect(record?.desktop?.vncViewOnly).toBeUndefined();
  });

  it("leaves a live lease and its writable VNC untouched", async () => {
    const id = await createDesktop({ vncPort: nextPort() });
    const handle = await startHumanTakeover(id, { registryEnv: env, env });

    const { recovered } = await recoverStaleHumanLease(id, env);
    expect(recovered).toBe(false);
    expect(isPidAlive(handle.vncPid)).toBe(true);
    expect((await readHumanLease(id, env))?.leaseId).toBe(handle.leaseId);

    await endHumanTakeover(handle, { registryEnv: env, env, reason: "return" });
  });

  it("bails without touching VNC when the lease is renewed between the check and the stop (P1-C TOCTOU)", async () => {
    const id = await createDesktop({ vncPort: nextPort() });
    const handle = await startHumanTakeover(id, { registryEnv: env, env, drainTimeoutMs: 500 });

    // Make the lease appear stale (TTL elapsed) to the cheap *initial*
    // check, while the owner (this process) is still very much alive.
    const stale = {
      ...(await readHumanLease(id, env))!,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    };
    await fs.promises.writeFile(
      path.join(env.PICKFORGE_HOME as string, "sessions", id, "human.lease.json"),
      `${JSON.stringify(stale)}\n`,
    );

    // Interleave: right as recovery performs its *final* re-check
    // (immediately before the destructive VNC stop), simulate the owner's
    // heartbeat winning the race and renewing the lease first. Written
    // directly (not via `renewHumanTakeover`) because a renewal that itself
    // re-validates staleness would correctly refuse to renew what is, at
    // that exact instant, still on-disk as stale (P0-B) — this reproduces
    // what a *successful*, just-in-time renewal would have left on disk a
    // moment earlier, which is the scenario under test.
    const renewed = { ...stale, expiresAt: new Date(Date.now() + 30_000).toISOString() };
    const readHumanLeaseRawMock = readHumanLeaseRaw as unknown as ReturnType<typeof vi.fn>;
    readHumanLeaseRawMock.mockImplementationOnce(
      async (sessionId: string, callEnv: EnvLike) => {
        await fs.promises.writeFile(
          path.join(callEnv.PICKFORGE_HOME as string, "sessions", sessionId, "human.lease.json"),
          `${JSON.stringify(renewed)}\n`,
        );
        return { raw: `${JSON.stringify(renewed)}\n`, lease: renewed };
      },
    );

    const { recovered } = await recoverStaleHumanLease(id, env);

    // Recovery must bail entirely: no VNC stop, no lease deletion — the
    // renewal that landed mid-check made this a live takeover again.
    expect(recovered).toBe(false);
    expect(isPidAlive(handle.vncPid)).toBe(true);
    const after = await readHumanLease(id, env);
    expect(after?.leaseId).toBe(handle.leaseId);
    expect(Date.parse(after!.expiresAt)).toBeGreaterThan(Date.parse(stale.expiresAt));
    const record = await getSession(id, env);
    expect(record?.desktop?.vncPid).toBe(handle.vncPid);
    expect(record?.desktop?.vncViewOnly).toBe(false);

    await endHumanTakeover(handle, { registryEnv: env, env, reason: "return" });
  });

  it("is a no-op when there is no lease at all", async () => {
    const id = await createDesktop({ vncPort: nextPort() });
    const { recovered } = await recoverStaleHumanLease(id, env);
    expect(recovered).toBe(false);
  });
});

describe("startHumanTakeover self-healing", () => {
  it("recovers a stale lease left by a crashed takeover, then proceeds", async () => {
    const id = await createDesktop({ vncPort: nextPort() });
    const firstHandle = await startHumanTakeover(id, { registryEnv: env, env });
    const staleVncPid = firstHandle.vncPid;

    const crashed = {
      ...(await readHumanLease(id, env))!,
      ownerPid: 999_999,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    };
    await fs.promises.writeFile(
      path.join(env.PICKFORGE_HOME as string, "sessions", id, "human.lease.json"),
      `${JSON.stringify(crashed)}\n`,
    );

    const secondHandle = await startHumanTakeover(id, {
      registryEnv: env,
      env,
      drainTimeoutMs: 500,
    });
    expect(secondHandle.leaseId).not.toBe(firstHandle.leaseId);
    expect(isPidAlive(staleVncPid)).toBe(false);
    expect(isPidAlive(secondHandle.vncPid)).toBe(true);

    await endHumanTakeover(secondHandle, { registryEnv: env, env, reason: "return" });
  });
});

describe("startHumanTakeover against a pre-existing --vnc-control session", () => {
  it("degrades safely: fails cleanly, leaves the persistent writable VNC undisturbed, and rolls back the lease", async () => {
    // Simulates `pickforge-lab session create --vnc-control`'s persistent, lease-
    // uncoordinated writable VNC — a completely different mechanism (#22)
    // from the leased takeover this module implements (#21). The two must
    // never be silently conflated: a takeover attempt against a session
    // already writable this way must not corrupt or hijack it.
    const port = nextPort();
    const preExisting = await startVnc({
      display: ":42",
      port,
      logDir: path.join(root, "pre-existing-vnc-control"),
      env,
      viewOnly: false,
    });
    const id = await createDesktop({
      vncPid: preExisting.pid,
      vncStartTimeTicks: preExisting.startTimeTicks,
      vncPort: port,
      vncViewOnly: false,
    });

    await expect(startHumanTakeover(id, { registryEnv: env, env })).rejects.toThrow();

    // Safe degradation: the pre-existing writable VNC is exactly as it was —
    // never stopped, never restarted, never handed a lease it doesn't know
    // about — and no orphaned lease is left behind for the failed attempt.
    expect(isPidAlive(preExisting.pid)).toBe(true);
    expect(await readHumanLease(id, env)).toBeUndefined();
    const record = await getSession(id, env);
    expect(record?.desktop?.vncPid).toBe(preExisting.pid);
    expect(record?.desktop?.vncViewOnly).toBe(false);

    await stopPid(preExisting.pid);
  });
});

describe("ensureSessionVnc recovery integration", () => {
  it("recovers a crash-orphaned writable VNC instead of refusing to watch", async () => {
    const { ensureSessionVnc } = await import("../src/session.js");
    const id = await createDesktop({ vncPort: nextPort() });
    const handle = await startHumanTakeover(id, { registryEnv: env, env });
    const staleVncPid = handle.vncPid;

    const crashed = {
      ...(await readHumanLease(id, env))!,
      ownerPid: 999_999,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    };
    await fs.promises.writeFile(
      path.join(env.PICKFORGE_HOME as string, "sessions", id, "human.lease.json"),
      `${JSON.stringify(crashed)}\n`,
    );

    const ensured = await ensureSessionVnc(id, { registryEnv: env, env });
    expect(ensured.reused).toBe(false);
    expect(isPidAlive(staleVncPid)).toBe(false);
    const record = await getSession(id, env);
    expect(record?.desktop?.vncViewOnly).toBe(true);
  });

  it("still refuses to watch while a live human lease holds writable VNC", async () => {
    const { ensureSessionVnc } = await import("../src/session.js");
    const id = await createDesktop({ vncPort: nextPort() });
    const handle = await startHumanTakeover(id, { registryEnv: env, env });

    await expect(ensureSessionVnc(id, { registryEnv: env, env })).rejects.toThrow(
      /server-enforced read-only VNC/,
    );

    await endHumanTakeover(handle, { registryEnv: env, env, reason: "return" });
  });
});

// Real separate-process proof (pickforge/pickforge#21 P0-A): the watchdog must
// actively reclaim a stale lease running as a genuinely independent OS
// process — not merely "correct in-process against a mock" — since the whole
// point is surviving a `SIGKILL` of its sibling `watch --control` process.
// Spawned via `bun` (this repo's test runtime), matching the existing
// `evidence.concurrency.test.ts` separate-process pattern. VNC-stop
// verification itself (mocked-identity, real spawned x11vnc) is already
// covered above; this test only needs to prove the lease-level reclaim
// happens from an independent process, so it stays platform-portable by
// never depending on `/proc`-verified VNC identity.
const BUN = /[\\/]bun$/.test(process.execPath) ? process.execPath : "bun";
const watchdogWorker = fileURLToPath(
  new URL("./workers/takeover-watchdog-worker.ts", import.meta.url),
);
// Bun's default package resolution for a plain `bun <script.ts>` invocation
// follows `@pickforge/lab-core`'s published `exports.default`
// (`dist/index.js`) rather than vitest's own source alias, so the worker
// would otherwise run against whatever the core package's dist happened to
// contain at last build — stale during normal iteration, unlike every other
// test in this suite (which runs in-process through vitest's source alias).
// `--conditions=development` selects `packages/core/package.json`'s
// `development` export condition (source) instead, so this test is exercised
// against the same source the rest of the suite is.
const BUN_ARGS = ["--conditions=development"];

function spawnWorker(args: string[]) {
  return spawn(BUN, [...BUN_ARGS, ...args], { stdio: "ignore" });
}

function runWorker(args: string[]): Promise<{ code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawnWorker(args);
    child.on("error", reject);
    child.on("close", (code) => resolve({ code }));
  });
}

describe("runTakeoverWatchdogLoop (real separate-process)", () => {
  it("reclaims a stale lease from a genuinely independent OS process", async () => {
    const id = await createDesktop();
    const stale = {
      leaseId: "crashed-lease",
      sessionId: id,
      ownerPid: 999_999,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      ttlMs: 30_000,
      heartbeatMs: 5_000,
    };
    await fs.promises.mkdir(path.join(env.PICKFORGE_HOME as string, "sessions", id), {
      recursive: true,
    });
    await fs.promises.writeFile(
      path.join(env.PICKFORGE_HOME as string, "sessions", id, "human.lease.json"),
      `${JSON.stringify(stale)}\n`,
    );
    expect(await readHumanLease(id, env)).toBeDefined();

    await runWorker([
      watchdogWorker,
      id,
      "crashed-lease",
      env.PICKFORGE_HOME as string,
      "20",
    ]);

    // A separate process, with no shared in-memory state whatsoever with
    // this test, independently discovered the stale lease and cleared it.
    expect(await readHumanLease(id, env)).toBeUndefined();
  });

  it("keeps polling without touching a live lease (never exits early)", async () => {
    const id = await createDesktop({ vncPort: nextPort() });
    const handle = await startHumanTakeover(id, { registryEnv: env, env });

    // A live lease never makes the watchdog exit on its own — that only
    // happens once it goes stale, is released, or is superseded — so this
    // proves the negative (no premature reclaim) by letting it poll for
    // several cycles, then terminating it directly rather than waiting for
    // a natural exit that would never come.
    const child = spawnWorker([watchdogWorker, id, handle.leaseId, env.PICKFORGE_HOME as string, "20"]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await readHumanLease(id, env))?.leaseId).toBe(handle.leaseId);
    child.kill("SIGTERM");

    await endHumanTakeover(handle, { registryEnv: env, env, reason: "return" });
  });
});
