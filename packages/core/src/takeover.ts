import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isEvidenceEnabled, loadConfig } from "./config.js";
import { appendAction, beginEvidenceRun } from "./evidence.js";
import { ensureDir, writeFileAtomic, type EnvLike } from "./paths.js";
import { isPidAlive, processIdentityMatches, readProcessStartTicks } from "./proc.js";
import { sessionDataDir } from "./session.js";

/**
 * Supervised pause / human takeover (pickforge/pickforge#21).
 *
 * State machine: `agent-active -> pause-requested -> human-active(lease,
 * deadline) -> returning -> agent-active`.
 *
 * - `agent-active`: no `human.lease.json` in the session directory. Agent
 *   permits (short-lived files under `permits/`) are always granted.
 * - `pause-requested`: `acquireHumanLease` atomically (`wx`) creates the
 *   lease file — the instant it exists, every agent permit recheck starts
 *   failing closed — then waits for permits that predate the lease to drain.
 * - `human-active`: the lease is held; the caller (desktop-linux) switches
 *   VNC to writable and renews the lease every `heartbeatMs` until return.
 * - `returning`: the caller reverts VNC to read-only and releases the lease
 *   on every exit path (normal return, cancellation, timeout).
 * - Crash recovery: a lease whose owner process died, or whose `expiresAt`
 *   elapsed without a heartbeat, is "stale" and safe to reclaim — see
 *   `isHumanLeaseStale` / `StaleHumanLeaseError` / `clearStaleHumanLease`.
 *
 * This module owns only the storage-backed lease/permit primitives (pure
 * `fs` + process-identity logic, testable without X11). VNC-mode switching
 * and screenshot/evidence orchestration live in `@pickforge/lab-desktop-linux`.
 */

export const HUMAN_LEASE_FILE = "human.lease.json";
export const AGENT_PERMITS_DIR = "permits";

/** Default time-to-live for a human lease between heartbeats (ms). */
export const HUMAN_LEASE_TTL_MS = 30_000;
/** Default interval at which an active human lease is renewed (ms). */
export const HUMAN_LEASE_HEARTBEAT_MS = 5_000;
/** Default budget to wait for pre-existing agent permits to drain (ms). */
export const HUMAN_LEASE_DRAIN_TIMEOUT_MS = 5_000;
const DRAIN_POLL_MS = 25;

const SAFE_SESSION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

function assertSafeSessionId(sessionId: string): void {
  if (!SAFE_SESSION_ID_PATTERN.test(sessionId) || sessionId.includes("..")) {
    throw new Error(
      `Invalid session id "${sessionId}": must start with a letter or digit ` +
        `and contain only letters, digits, ".", "_", or "-"`,
    );
  }
}

/** A process's liveness, verified by `/proc` start ticks when available. */
function identityIsAlive(pid: number, startTicks?: number): boolean {
  if (startTicks !== undefined) {
    return processIdentityMatches({ pid, startTicks });
  }
  return isPidAlive(pid);
}

function humanLeasePath(sessionId: string, env: EnvLike): string {
  return path.join(sessionDataDir(sessionId, env), HUMAN_LEASE_FILE);
}

function agentPermitsDir(sessionId: string, env: EnvLike): string {
  return path.join(sessionDataDir(sessionId, env), AGENT_PERMITS_DIR);
}

/** Atomically-published record of who holds human control of a session. */
export interface HumanLease {
  leaseId: string;
  sessionId: string;
  ownerPid: number;
  ownerStartTicks?: number;
  createdAt: string;
  /** Renewed every `heartbeatMs` while control is held; past this, stale. */
  expiresAt: string;
  ttlMs: number;
  heartbeatMs: number;
  /** Writable VNC server metadata, patched in once VNC has switched mode. */
  vncPid?: number;
  vncStartTimeTicks?: number;
  vncPort?: number;
}

/** A short-lived marker an agent action holds while it may deliver input. */
export interface AgentPermit {
  permitId: string;
  sessionId: string;
  ownerPid: number;
  ownerStartTicks?: number;
  createdAt: string;
  path: string;
}

/** Thrown when an agent action is refused because human control is active. */
export class HumanControlActiveError extends Error {
  readonly code = "human_control_active";
  readonly lease: HumanLease;
  constructor(lease: HumanLease) {
    super(
      "Pickforge: human control is active " +
        `(lease ${lease.leaseId}, held since ${lease.createdAt}); ` +
        "agent input is paused until control returns",
    );
    this.name = "HumanControlActiveError";
    this.lease = lease;
  }
}

/** Thrown when acquiring a human lease finds another *live* owner. */
export class HumanLeaseHeldError extends Error {
  readonly code = "human_lease_held";
  readonly lease: HumanLease;
  constructor(lease: HumanLease) {
    super(
      `Session ${lease.sessionId} is already under human control ` +
        `(lease ${lease.leaseId}, owner pid ${lease.ownerPid}, ` +
        `held since ${lease.createdAt})`,
    );
    this.name = "HumanLeaseHeldError";
    this.lease = lease;
  }
}

/**
 * Thrown when acquiring a human lease finds an existing lease file whose
 * owner is dead or whose TTL has elapsed. Callers that can also manage the
 * writable VNC side (desktop-linux) should stop any recorded VNC process,
 * clear the stale file with `clearStaleHumanLease`, then retry.
 */
export class StaleHumanLeaseError extends Error {
  readonly code = "stale_human_lease";
  readonly raw: string;
  readonly lease?: HumanLease;
  constructor(raw: string, lease?: HumanLease) {
    super(
      lease === undefined
        ? "A stale, unreadable human lease file is blocking acquisition"
        : `Stale human lease ${lease.leaseId} (owner pid ${lease.ownerPid}, ` +
            `expired ${lease.expiresAt}) is blocking acquisition`,
    );
    this.name = "StaleHumanLeaseError";
    this.raw = raw;
    this.lease = lease;
  }
}

/** Thrown when in-flight agent permits do not drain before the deadline. */
export class HumanLeaseDrainTimeoutError extends Error {
  readonly code = "human_lease_drain_timeout";
  readonly pendingPermitIds: string[];
  constructor(pendingPermitIds: string[]) {
    super(
      `Timed out waiting for ${pendingPermitIds.length} in-flight agent ` +
        "action(s) to finish before granting human control",
    );
    this.name = "HumanLeaseDrainTimeoutError";
    this.pendingPermitIds = pendingPermitIds;
  }
}

async function readTextIfPresent(target: string): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function unlinkIfPresent(target: string): Promise<boolean> {
  try {
    await fs.promises.unlink(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function unlinkIfMatches(target: string, expected: string): Promise<boolean> {
  const current = await readTextIfPresent(target);
  if (current === undefined || current !== expected) return false;
  return unlinkIfPresent(target);
}

function parseHumanLease(raw: string): HumanLease | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const c = parsed as Record<string, unknown>;
  if (
    typeof c.leaseId !== "string" ||
    typeof c.sessionId !== "string" ||
    typeof c.ownerPid !== "number" ||
    typeof c.createdAt !== "string" ||
    typeof c.expiresAt !== "string" ||
    typeof c.ttlMs !== "number" ||
    typeof c.heartbeatMs !== "number"
  ) {
    return undefined;
  }
  const lease: HumanLease = {
    leaseId: c.leaseId,
    sessionId: c.sessionId,
    ownerPid: c.ownerPid,
    createdAt: c.createdAt,
    expiresAt: c.expiresAt,
    ttlMs: c.ttlMs,
    heartbeatMs: c.heartbeatMs,
  };
  if (typeof c.ownerStartTicks === "number") lease.ownerStartTicks = c.ownerStartTicks;
  if (typeof c.vncPid === "number") lease.vncPid = c.vncPid;
  if (typeof c.vncStartTimeTicks === "number") lease.vncStartTimeTicks = c.vncStartTimeTicks;
  if (typeof c.vncPort === "number") lease.vncPort = c.vncPort;
  return lease;
}

function parseAgentPermitRecord(
  raw: string,
): Omit<AgentPermit, "path"> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const c = parsed as Record<string, unknown>;
  if (
    typeof c.permitId !== "string" ||
    typeof c.sessionId !== "string" ||
    typeof c.ownerPid !== "number" ||
    typeof c.createdAt !== "string"
  ) {
    return undefined;
  }
  const record: Omit<AgentPermit, "path"> = {
    permitId: c.permitId,
    sessionId: c.sessionId,
    ownerPid: c.ownerPid,
    createdAt: c.createdAt,
  };
  if (typeof c.ownerStartTicks === "number") record.ownerStartTicks = c.ownerStartTicks;
  return record;
}

/** Read a session's human lease, or `undefined` if absent/unparseable. */
export async function readHumanLease(
  sessionId: string,
  env: EnvLike = process.env,
): Promise<HumanLease | undefined> {
  assertSafeSessionId(sessionId);
  const raw = await readTextIfPresent(humanLeasePath(sessionId, env));
  return raw === undefined ? undefined : parseHumanLease(raw);
}

/** A lease read together with its exact on-disk bytes. */
export interface HumanLeaseSnapshot {
  raw: string;
  /** `undefined` when the raw content does not parse as a lease (corrupt). */
  lease?: HumanLease;
}

/**
 * Read a session's human lease together with its exact raw bytes, for
 * callers that need to compare-and-delete on precisely what they observed
 * (recovery's re-check-immediately-before-acting protocol) rather than only
 * on `leaseId`, which does not change across a renewal and so cannot by
 * itself detect "this lease was renewed since I last looked." Returns
 * `undefined` only when no lease file exists at all.
 */
export async function readHumanLeaseRaw(
  sessionId: string,
  env: EnvLike = process.env,
): Promise<HumanLeaseSnapshot | undefined> {
  assertSafeSessionId(sessionId);
  const raw = await readTextIfPresent(humanLeasePath(sessionId, env));
  if (raw === undefined) return undefined;
  const lease = parseHumanLease(raw);
  return lease === undefined ? { raw } : { raw, lease };
}

/**
 * Whether a lease is stale: its owner process is dead (or its PID was
 * reused), or its TTL elapsed without a heartbeat renewal. Either condition
 * alone is sufficient — a hung-but-alive owner that stops heartbeating is
 * just as reclaimable as a dead one.
 */
export function isHumanLeaseStale(lease: HumanLease, now: Date = new Date()): boolean {
  if (!identityIsAlive(lease.ownerPid, lease.ownerStartTicks)) return true;
  return now.getTime() > Date.parse(lease.expiresAt);
}

export interface AcquireHumanLeaseOptions {
  ttlMs?: number;
  heartbeatMs?: number;
  drainTimeoutMs?: number;
  now?: Date;
  vncPid?: number;
  vncStartTimeTicks?: number;
  vncPort?: number;
  /**
   * @internal Test hook, awaited right after the lease is durably created but
   * before draining begins. Lets a test hold the lease open while a peer
   * races it, proving a live lease is never stolen from under itself.
   */
  _afterCreate?: () => void | Promise<void>;
}

/**
 * Acquire exclusive human control of a session: atomically (`wx`) create the
 * lease file, then wait for every agent permit that existed at that instant
 * to drain (finish, or be recognized as owned by a dead process and swept).
 *
 * A second acquisition attempt while the lease is live throws
 * `HumanLeaseHeldError` immediately — this is a single-winner primitive, not
 * a queue. An existing lease whose owner is dead or whose TTL elapsed throws
 * `StaleHumanLeaseError` so the caller can recover it (see
 * `clearStaleHumanLease`) and retry. If permits fail to drain in time, the
 * lease this call just created is released and `HumanLeaseDrainTimeoutError`
 * is thrown — "timeout aborts cleanly."
 */
// eslint-disable-next-line complexity -- Legacy gate debt: pickforge/pickforge#60
export async function acquireHumanLease(
  sessionId: string,
  env: EnvLike = process.env,
  opts: AcquireHumanLeaseOptions = {},
): Promise<HumanLease> {
  assertSafeSessionId(sessionId);
  const dir = await ensureDir(sessionDataDir(sessionId, env));
  const leasePath = path.join(dir, HUMAN_LEASE_FILE);
  const ttlMs = opts.ttlMs ?? HUMAN_LEASE_TTL_MS;
  const heartbeatMs = opts.heartbeatMs ?? HUMAN_LEASE_HEARTBEAT_MS;
  const now = opts.now ?? new Date();
  const ownerPid = process.pid;
  const ownerStartTicks = readProcessStartTicks(ownerPid);

  const lease: HumanLease = {
    leaseId: crypto.randomUUID(),
    sessionId,
    ownerPid,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    ttlMs,
    heartbeatMs,
  };
  if (ownerStartTicks !== undefined) lease.ownerStartTicks = ownerStartTicks;
  if (opts.vncPid !== undefined) lease.vncPid = opts.vncPid;
  if (opts.vncStartTimeTicks !== undefined) lease.vncStartTimeTicks = opts.vncStartTimeTicks;
  if (opts.vncPort !== undefined) lease.vncPort = opts.vncPort;

  try {
    await fs.promises.writeFile(leasePath, `${JSON.stringify(lease)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const raw = await readTextIfPresent(leasePath);
    if (raw === undefined) {
      // Vanished between our failed create and this read (a peer released
      // it). Safe to retry from the caller's side; report as contention
      // rather than silently looping here.
      throw new Error(
        `Transient contention acquiring the human lease for session ${sessionId}; retry`,
      );
    }
    const existing = parseHumanLease(raw);
    if (existing !== undefined && !isHumanLeaseStale(existing, now)) {
      throw new HumanLeaseHeldError(existing);
    }
    throw new StaleHumanLeaseError(raw, existing);
  }

  if (opts._afterCreate !== undefined) await opts._afterCreate();

  try {
    await drainAgentPermits(
      sessionId,
      env,
      opts.drainTimeoutMs ?? HUMAN_LEASE_DRAIN_TIMEOUT_MS,
    );
  } catch (error) {
    await unlinkIfMatches(leasePath, `${JSON.stringify(lease)}\n`).catch(() => {});
    throw error;
  }
  return lease;
}

/**
 * Clear a lease file identified as stale by `acquireHumanLease` (compare-and-
 * delete on its exact raw content), so a fresh acquisition can proceed. The
 * caller is responsible for stopping any writable VNC process the stale
 * lease recorded before calling this.
 */
export async function clearStaleHumanLease(
  sessionId: string,
  expectedRaw: string,
  env: EnvLike = process.env,
): Promise<boolean> {
  assertSafeSessionId(sessionId);
  return unlinkIfMatches(humanLeasePath(sessionId, env), expectedRaw);
}

/**
 * Renew a held lease's TTL (and optionally patch in VNC metadata once
 * writable VNC has actually started). Verifies the caller still owns
 * `leaseId` before writing, and again immediately after, so a lease this
 * process no longer owns is never resurrected. Returns the updated lease, or
 * `undefined` if the lease is gone or owned by someone else.
 */
export async function renewHumanLease(
  sessionId: string,
  leaseId: string,
  env: EnvLike = process.env,
  patch: { vncPid?: number; vncStartTimeTicks?: number; vncPort?: number } = {},
  now: Date = new Date(),
): Promise<HumanLease | undefined> {
  assertSafeSessionId(sessionId);
  const leasePath = humanLeasePath(sessionId, env);
  const current = await readHumanLease(sessionId, env);
  if (current === undefined || current.leaseId !== leaseId) return undefined;
  // A lease that has already gone stale (TTL elapsed, or its recorded owner
  // no longer matches this call's identity — e.g. reaped and reused) must
  // never be resurrected by a late renewal: the owner lost the lease the
  // instant it went stale, and a straggling renew must not extend it back to
  // life out from under a recovery that may already be in flight.
  if (isHumanLeaseStale(current, now)) return undefined;
  const updated: HumanLease = {
    ...current,
    expiresAt: new Date(now.getTime() + current.ttlMs).toISOString(),
  };
  if (patch.vncPid !== undefined) updated.vncPid = patch.vncPid;
  if (patch.vncStartTimeTicks !== undefined) updated.vncStartTimeTicks = patch.vncStartTimeTicks;
  if (patch.vncPort !== undefined) updated.vncPort = patch.vncPort;
  await writeFileAtomic(leasePath, `${JSON.stringify(updated)}\n`);
  const confirmed = await readHumanLease(sessionId, env);
  return confirmed?.leaseId === leaseId ? confirmed : undefined;
}

/** Release a held lease by id (compare-and-delete). Best-effort/idempotent. */
export async function releaseHumanLease(
  sessionId: string,
  leaseId: string,
  env: EnvLike = process.env,
): Promise<boolean> {
  assertSafeSessionId(sessionId);
  const leasePath = humanLeasePath(sessionId, env);
  const raw = await readTextIfPresent(leasePath);
  if (raw === undefined) return false;
  const current = parseHumanLease(raw);
  if (current?.leaseId !== leaseId) return false;
  return unlinkIfMatches(leasePath, raw);
}

export interface RecordTakeoverEvidenceOptions {
  env?: EnvLike;
  status?: "ok" | "error";
  artifacts?: string[];
}

/**
 * Append one best-effort takeover lifecycle-transition evidence action
 * (`takeover_start`, `takeover_return`, `takeover_timeout`,
 * `takeover_cancelled`, `takeover_recovered`, ...). Never throws — a
 * transition (VNC mode switch, lease release) must never fail because its
 * evidence entry could not be written.
 */
export async function recordTakeoverEvidence(
  projectDir: string,
  sessionId: string,
  tool: string,
  opts: RecordTakeoverEvidenceOptions = {},
): Promise<void> {
  try {
    if (!isEvidenceEnabled(await loadConfig(projectDir, opts.env))) return;
    const { run } = await beginEvidenceRun(
      projectDir,
      sessionId,
      { slug: "computer-use" },
      opts.env,
    );
    await appendAction(run, {
      actionId: crypto.randomUUID(),
      source: "takeover",
      tool,
      sessionId,
      startedAt: new Date().toISOString(),
      status: opts.status ?? "ok",
      ...(opts.artifacts === undefined ? {} : { artifacts: opts.artifacts }),
    });
  } catch {
    // Best-effort; see doc comment.
  }
}

/** Read-only classification of a session's takeover state. */
export interface TakeoverStatusResult {
  sessionId: string;
  /** True only while a live (non-stale) human lease is held. */
  active: boolean;
  lease?: HumanLease;
  /** True when a lease file exists but its owner is dead/expired. */
  stale?: boolean;
}

export async function getTakeoverStatus(
  sessionId: string,
  env: EnvLike = process.env,
): Promise<TakeoverStatusResult> {
  assertSafeSessionId(sessionId);
  const lease = await readHumanLease(sessionId, env);
  if (lease === undefined) return { sessionId, active: false };
  if (isHumanLeaseStale(lease)) return { sessionId, active: false, lease, stale: true };
  return { sessionId, active: true, lease };
}

/**
 * Read-only recheck used by the fail-closed input/relay gate: returns the
 * live lease if human control is active, `undefined` otherwise (including
 * when the only lease on disk is stale — a hung/dead human owner never
 * blocks the agent).
 */
export async function checkHumanLeaseBusy(
  sessionId: string,
  env: EnvLike = process.env,
): Promise<HumanLease | undefined> {
  const lease = await readHumanLease(sessionId, env);
  return lease !== undefined && !isHumanLeaseStale(lease) ? lease : undefined;
}

/** Acquire a short-lived marker recording that an agent action may run. */
export async function acquireAgentPermit(
  sessionId: string,
  env: EnvLike = process.env,
): Promise<AgentPermit> {
  assertSafeSessionId(sessionId);
  const dir = await ensureDir(agentPermitsDir(sessionId, env));
  const ownerPid = process.pid;
  const ownerStartTicks = readProcessStartTicks(ownerPid);
  const permitId = crypto.randomUUID();
  const record: Omit<AgentPermit, "path"> = {
    permitId,
    sessionId,
    ownerPid,
    createdAt: new Date().toISOString(),
  };
  if (ownerStartTicks !== undefined) record.ownerStartTicks = ownerStartTicks;
  const permitPath = path.join(dir, `${permitId}.json`);
  await fs.promises.writeFile(permitPath, `${JSON.stringify(record)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return { ...record, path: permitPath };
}

/** Release a previously-acquired agent permit. Best-effort/idempotent. */
export async function releaseAgentPermit(permit: AgentPermit): Promise<void> {
  await unlinkIfPresent(permit.path);
}

async function drainAgentPermits(
  sessionId: string,
  env: EnvLike,
  timeoutMs: number,
): Promise<void> {
  const dir = agentPermitsDir(sessionId, env);
  let entries: string[];
  try {
    entries = (await fs.promises.readdir(dir)).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const pending = new Set(entries);
  const deadline = Date.now() + timeoutMs;

  while (pending.size > 0) {
    for (const name of [...pending]) {
      const full = path.join(dir, name);
      const raw = await readTextIfPresent(full);
      if (raw === undefined) {
        pending.delete(name);
        continue;
      }
      const record = parseAgentPermitRecord(raw);
      if (record === undefined || !identityIsAlive(record.ownerPid, record.ownerStartTicks)) {
        // Corrupt, or owned by a dead process (crashed mid-action): sweep it
        // so a crash never permanently blocks a takeover.
        await unlinkIfPresent(full).catch(() => {});
        pending.delete(name);
      }
    }
    if (pending.size === 0) return;
    if (Date.now() >= deadline) {
      throw new HumanLeaseDrainTimeoutError(
        [...pending].map((name) => name.replace(/\.json$/, "")),
      );
    }
    await delay(DRAIN_POLL_MS);
  }
}

/**
 * Run `action` while holding a fail-closed agent permit: acquire the permit,
 * recheck for a live human lease, execute only if none is found, then
 * release the permit in `finally`. Throws `HumanControlActiveError` (never
 * runs `action`) when human control is active — "no permit fitness ⇒ no
 * input delivery."
 */
export async function withAgentPermit<T>(
  sessionId: string,
  env: EnvLike,
  action: () => Promise<T>,
): Promise<T> {
  const permit = await acquireAgentPermit(sessionId, env);
  try {
    const lease = await checkHumanLeaseBusy(sessionId, env);
    if (lease !== undefined) {
      throw new HumanControlActiveError(lease);
    }
    return await action();
  } finally {
    await releaseAgentPermit(permit);
  }
}
