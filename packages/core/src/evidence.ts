import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type EnvLike } from "./paths.js";
import {
  DirHandle,
  RunStorageAccessError,
  withDirHandle,
} from "./dir-handle.js";
import { openRunCatalog } from "./run-catalog.js";
import {
  openRunDirIn,
  withBoundRunDir,
  withExistingRunsRootDir,
  withRunsRootDir,
  type RunDirBinding,
} from "./run-root.js";
import { resolveRunStorage } from "./storage.js";
import {
  isPidAlive,
  processIdentityMatches,
  readProcessStartTicks,
} from "./proc.js";
import {
  EVIDENCE_ACTION_LOG,
  EVIDENCE_VERSION,
  RunHandle,
  adoptRunIn,
  createRun,
  type RunManifest,
  type RunStatus,
} from "./run.js";

/**
 * Dormant evidence storage foundation.
 *
 * This module owns the durable, single-owner storage contract for computer-use
 * evidence: a session-scoped active-run pointer, an append-only action journal
 * (`actions.jsonl`), a byte cap with one deterministic truncation marker, and
 * finalized-run retention. It deliberately wires no producers — no MCP tool,
 * relay, or screenshot policy calls into it yet.
 *
 * Invariants:
 * - The manifest is single-owner summary data. The journal is authoritative;
 *   appending an action never rewrites the manifest.
 * - A recoverable cross-process lock serializes tail repair, cap accounting, and
 *   one verified `O_APPEND` write of each bounded, newline-terminated record.
 * - Reads are deterministic: a torn final line is dropped and repaired before the
 *   next append; any corruption before the final line is rejected.
 */

/** Per-run cap on auto-generated evidence bytes (journal + counted artifacts). */
export const EVIDENCE_MAX_BYTES = 100 * 1024 * 1024;
/** Upper bound on a single serialized journal record, including its newline. */
export const EVIDENCE_MAX_LINE_BYTES = 64 * 1024;
/** Number of finalized evidence runs retained per project. */
export const EVIDENCE_RETENTION_KEEP = 20;
/** Filename of the truncation gate sentinel inside a run dir. */
const TRUNCATION_SENTINEL = ".evidence-truncated";
/** Recoverable cross-process lock that serializes journal repair and appends. */
const JOURNAL_LOCK = ".evidence-journal.lock";

/** Wall-clock budget for waiting on a live claimer before giving up (ms). */
const CLAIM_TOTAL_DEADLINE_MS = 5_000;
/** Base and max backoff between claim retries (ms). */
const CLAIM_BACKOFF_MS = 5;
const CLAIM_BACKOFF_MAX_MS = 50;
/**
 * How many retries to tolerate an owner-unknown (empty) claim before assuming
 * the claimer died in the microscopic window between `wx` create and its
 * identity stamp, and reclaiming it. A live winner stamps its identity
 * synchronously right after the create, so this only ever fires for a genuinely
 * dead claimer. Shared by the active-run pointer and the truncation-marker
 * sentinel, which both use the same recoverable-claim protocol.
 */
const EMPTY_CLAIM_GRACE_ATTEMPTS = 4;
/** Hard cap on claim attempts as a spin guard alongside the wall-clock budget. */
const MAX_CLAIM_ATTEMPTS = 10_000;
const SAFE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

export type EvidenceActionStatus = "ok" | "error" | "cancelled" | "timeout";

/**
 * One sanitized computer-use action. Producers are responsible for redacting
 * `target`, `artifacts`, and `error` before handing a record here; this module
 * only enforces framing and byte bounds, never inspects field contents.
 */
export interface EvidenceAction {
  actionId: string;
  source: string;
  tool: string;
  sessionId?: string;
  startedAt: string;
  durationMs?: number;
  status: EvidenceActionStatus;
  /** Allowlisted, already-sanitized target metadata. */
  target?: Record<string, unknown>;
  /** Run-relative artifact paths this action produced. */
  artifacts?: string[];
  /** Redacted, human-readable error summary. */
  error?: string;
}

/** The single, deterministic marker appended when the evidence cap is reached. */
export interface EvidenceTruncationRecord {
  actionId: string;
  evidenceTruncated: true;
  reason: "evidence-cap";
  bytes: number;
  maxBytes: number;
  recordedAt: string;
}

export type EvidenceRecord = EvidenceAction | EvidenceTruncationRecord;

export function isTruncationRecord(
  record: EvidenceRecord,
): record is EvidenceTruncationRecord {
  return (record as EvidenceTruncationRecord).evidenceTruncated === true;
}

/** Atomically-published pointer to a session's active evidence run. */
export interface ActiveEvidencePointer {
  evidenceVersion: typeof EVIDENCE_VERSION;
  sessionId: string;
  runId: string;
  ownerPid: number;
  ownerStartTicks?: number;
  createdAt: string;
}

/**
 * The interim record a claimant stamps into the pointer file at atomic (`wx`)
 * creation time, before its run directory exists. It carries verifiable owner
 * identity (`ownerPid` plus the `/proc` `ownerStartTicks`) so a peer can tell a
 * live claimer apart from a crashed one and never steal a claim from a process
 * that is merely slow. It has no `runId` — that only appears once the run is
 * created and the full pointer is published over this claim.
 */
export interface ActiveEvidenceClaim {
  evidenceVersion: typeof EVIDENCE_VERSION;
  sessionId: string;
  ownerPid: number;
  ownerStartTicks?: number;
  claim: true;
  claimedAt: string;
}

export type PointerResolution =
  | { status: "absent" }
  | { status: "claiming"; raw: string; claim?: ActiveEvidenceClaim }
  | {
      status: "active";
      raw: string;
      pointer: ActiveEvidencePointer;
      manifest: RunManifest;
    }
  | { status: "stale"; raw: string; pointer?: ActiveEvidencePointer }
  | { status: "corrupt"; raw: string };

export interface BeginEvidenceRunOptions {
  slug?: string;
  now?: Date;
  meta?: Record<string, unknown>;
  /**
   * @internal Test hook, awaited after the claim identity is stamped but before
   * the run directory is created. Lets a test hold a claim open while peers race
   * it, proving a live-but-slow claimer is never stolen. Never set in
   * production; there is no producer wiring.
   */
  _afterClaim?: () => void | Promise<void>;
}

export interface BeginEvidenceRunResult {
  run: RunHandle;
  /** True when an existing active run was adopted instead of created. */
  adopted: boolean;
}

export type AppendOutcome = "appended" | "truncated" | "capped";

export interface AppendActionOptions {
  /** Cap on total evidence bytes; injectable so tests avoid 100 MiB. */
  maxBytes?: number;
  /** Per-record byte bound; injectable for bounded-line tests. */
  maxLineBytes?: number;
  /**
   * Extra bytes to count toward the cap for this append that are *not yet* on
   * disk under the run directory (e.g. an artifact the producer is about to
   * write). Bytes already written under the run directory are measured directly
   * and must not be passed here, or they would be double-counted. This is an
   * additive hint on top of the authoritative on-disk measurement — never the
   * sole accounting — so the 100 MiB cap is enforced cumulatively across every
   * append and every process, not just per call.
   */
  externalBytes?: number;
  /**
   * @internal Test hook, awaited after the truncation-marker claim identity is
   * stamped but before the marker is appended. Lets a test hold the marker claim
   * open while peers race it (proving a live claim is never stolen) or exit to
   * simulate a crash mid-claim. Never set in production.
   */
  _afterMarkerClaim?: () => void | Promise<void>;
  /**
   * @internal Test hook, invoked in place of the marker append to inject a
   * failure, proving an append error cleans its claim instead of leaving a
   * permanent gate. Never set in production.
   */
  _failMarkerAppend?: () => Promise<never> | never;
}

export interface AppendResult {
  outcome: AppendOutcome;
  bytesWritten: number;
  usedBytes: number;
  /** The action landed, but truncation-marker recovery must finish on a later append. */
  truncationPending?: true;
}

export interface PruneEvidenceOptions {
  keep?: number;
}

function assertSafeSessionId(sessionId: string): void {
  if (!SAFE_NAME_PATTERN.test(sessionId) || sessionId.includes("..")) {
    throw new Error(
      `Invalid evidence session id "${sessionId}": must start with a letter ` +
        `or digit and contain only letters, digits, ".", "_", or "-"`,
    );
  }
}

function isSafeRunId(runId: string): boolean {
  return SAFE_NAME_PATTERN.test(runId) && !runId.includes("..");
}

function manifestMatchesPointer(
  manifest: RunManifest,
  pointer: ActiveEvidencePointer,
  sessionId: string,
): boolean {
  return (
    manifest.runId === pointer.runId &&
    manifest.sessionId === sessionId &&
    pointer.sessionId === sessionId
  );
}

/** File name of a session's active-run pointer inside the runs root. */
function pointerName(sessionId: string): string {
  return `.active-${sessionId}.json`;
}

/**
 * Absolute path of the active-run pointer for a session. This is a location
 * for reporting and inspection; every pointer read and write goes through the
 * verified runs-root descriptor instead of this pathname.
 */
export async function activePointerPath(
  projectDir: string,
  sessionId: string,
  env: EnvLike = process.env,
): Promise<string> {
  assertSafeSessionId(sessionId);
  const parent = (await resolveRunStorage(projectDir, env)).runsDir;
  return path.join(parent, pointerName(sessionId));
}

function parsePointer(raw: string): ActiveEvidencePointer | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.evidenceVersion !== EVIDENCE_VERSION ||
    typeof candidate.sessionId !== "string" ||
    typeof candidate.runId !== "string" ||
    typeof candidate.ownerPid !== "number" ||
    typeof candidate.createdAt !== "string" ||
    !isSafeRunId(candidate.runId)
  ) {
    return undefined;
  }
  const pointer: ActiveEvidencePointer = {
    evidenceVersion: EVIDENCE_VERSION,
    sessionId: candidate.sessionId,
    runId: candidate.runId,
    ownerPid: candidate.ownerPid,
    createdAt: candidate.createdAt,
  };
  if (typeof candidate.ownerStartTicks === "number") {
    pointer.ownerStartTicks = candidate.ownerStartTicks;
  }
  return pointer;
}

function parseClaim(raw: string): ActiveEvidenceClaim | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.evidenceVersion !== EVIDENCE_VERSION ||
    candidate.claim !== true ||
    typeof candidate.sessionId !== "string" ||
    typeof candidate.ownerPid !== "number" ||
    typeof candidate.claimedAt !== "string"
  ) {
    return undefined;
  }
  const claim: ActiveEvidenceClaim = {
    evidenceVersion: EVIDENCE_VERSION,
    sessionId: candidate.sessionId,
    ownerPid: candidate.ownerPid,
    claim: true,
    claimedAt: candidate.claimedAt,
  };
  if (typeof candidate.ownerStartTicks === "number") {
    claim.ownerStartTicks = candidate.ownerStartTicks;
  }
  return claim;
}

/**
 * Whether the process behind a recorded owner identity is still the same live
 * process. When a `/proc` start time was recorded, it must match (this rejects a
 * later, unrelated process that reused the PID); otherwise we fall back to a
 * plain liveness probe. A dead or reused owner is never treated as alive, so its
 * claim or run is safe to reclaim.
 */
function identityIsAlive(pid: number, startTicks?: number): boolean {
  if (startTicks !== undefined) {
    return processIdentityMatches({ pid, startTicks });
  }
  return isPidAlive(pid);
}

/**
 * Read a run's manifest through the verified runs-root descriptor, so the
 * lookup cannot be redirected by a swapped ancestor and an unsafe or
 * traversing run id is refused rather than followed.
 */
async function readManifestIn(
  root: DirHandle,
  runId: string,
): Promise<RunManifest | undefined> {
  let runDir: DirHandle;
  try {
    runDir = await openRunDirIn(root, runId);
  } catch (error) {
    // Missing, unsafe, or traversing: no manifest to read. Other failures
    // (permissions, I/O) still propagate from the read below.
    if (error instanceof RunStorageAccessError) return undefined;
    throw error;
  }
  let raw: string | undefined;
  try {
    raw = await runDir.readFileIfPresent("manifest.json");
  } finally {
    await runDir.close();
  }
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return parsed as RunManifest;
  } catch {
    return undefined;
  }
}

/**
 * Read and classify a session's active-run pointer. A pointer is `active` only
 * when it references a run whose manifest still reports `running` *and* whose
 * recorded owner process is still alive. A running run whose recorded owner has
 * died or had its PID reused is `stale` (recoverable): the creator is gone, so a
 * fresh caller must not adopt an orphaned run. Anything finalized or missing is
 * likewise `stale` and safe to clear. An interim claim record (owner stamped,
 * no run yet) or an empty file is a peer mid-claim (`claiming`); when the owner
 * identity is present it is returned so callers can tell a live claimer apart
 * from a dead one.
 */
export async function resolveActivePointer(
  projectDir: string,
  sessionId: string,
  env: EnvLike = process.env,
): Promise<PointerResolution> {
  assertSafeSessionId(sessionId);
  return withExistingRunsRootDir(projectDir, env, async (root) =>
    root === undefined
      ? { status: "absent" }
      : resolveActivePointerIn(root, sessionId),
  );
}

/** {@link resolveActivePointer} against an already open, verified root. */
async function resolveActivePointerIn(
  root: DirHandle,
  sessionId: string,
): Promise<PointerResolution> {
  const raw = await root.readFileIfPresent(pointerName(sessionId));
  if (raw === undefined) return { status: "absent" };
  if (raw.trim() === "") return { status: "claiming", raw };
  const claim = parseClaim(raw);
  if (claim !== undefined) return { status: "claiming", raw, claim };
  const pointer = parsePointer(raw);
  if (pointer === undefined) return { status: "corrupt", raw };
  const manifest = await readManifestIn(root, pointer.runId);
  if (
    manifest === undefined ||
    manifest.status !== "running" ||
    !manifestMatchesPointer(manifest, pointer, sessionId)
  ) {
    return { status: "stale", raw, pointer };
  }
  // A running manifest is only truly active while its recorded owner lives. A
  // dead or PID-reused owner means the run was orphaned mid-flight; classify it
  // stale so recovery starts a fresh run instead of adopting a dead one.
  if (!identityIsAlive(pointer.ownerPid, pointer.ownerStartTicks)) {
    return { status: "stale", raw, pointer };
  }
  return { status: "active", raw, pointer, manifest };
}

/**
 * Remove a session's active-run pointer. Without options, clears only a pointer
 * that currently resolves as stale or corrupt (never an active one). `expectRaw`
 * performs a compare-and-clear — used by the owner to release exactly the
 * pointer it published. `force` clears unconditionally. Returns whether a
 * pointer was removed.
 */
export async function clearActivePointer(
  projectDir: string,
  sessionId: string,
  opts: { expectRaw?: string; force?: boolean } = {},
  env: EnvLike = process.env,
): Promise<boolean> {
  assertSafeSessionId(sessionId);
  return withExistingRunsRootDir(projectDir, env, async (root) =>
    root === undefined ? false : clearActivePointerIn(root, sessionId, opts),
  );
}

/** {@link clearActivePointer} against an already open, verified root. */
async function clearActivePointerIn(
  root: DirHandle,
  sessionId: string,
  opts: { expectRaw?: string; force?: boolean } = {},
): Promise<boolean> {
  const name = pointerName(sessionId);
  if (opts.force === true) return root.unlinkChild(name);
  const current = await root.readFileIfPresent(name);
  if (current === undefined) return false;
  if (opts.expectRaw !== undefined) {
    if (current !== opts.expectRaw) return false;
    return unlinkIfMatchesIn(root, name, current);
  }
  // Default: only clear a pointer that is genuinely stale/corrupt.
  const resolution = await resolveActivePointerIn(root, sessionId);
  if (resolution.status === "stale" || resolution.status === "corrupt") {
    return unlinkIfMatchesIn(root, name, current);
  }
  return false;
}

/**
 * Unlink only if the file content still matches what we last read, closing the
 * window where a peer republishes a fresh pointer between our read and unlink.
 * Both the compare and the unlink resolve through the same directory
 * descriptor, so they always act on the same directory.
 */
async function unlinkIfMatchesIn(
  dir: DirHandle,
  name: string,
  expected: string,
): Promise<boolean> {
  const current = await dir.readFileIfPresent(name);
  if (current === undefined) return false;
  if (current !== expected) return false;
  return dir.unlinkChild(name);
}

/** Raised internally when a winner discovers it no longer owns its claim. */
class ClaimLostError extends Error {
  constructor() {
    super("evidence claim lost before publication");
    this.name = "ClaimLostError";
  }
}

function claimBackoff(attempt: number): number {
  return Math.min(CLAIM_BACKOFF_MS * (attempt + 1), CLAIM_BACKOFF_MAX_MS);
}

interface JournalLockClaim {
  evidenceVersion: typeof EVIDENCE_VERSION;
  ownerPid: number;
  ownerStartTicks?: number;
  claimedAt: string;
}

function parseJournalLockClaim(raw: string): JournalLockClaim | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.evidenceVersion !== EVIDENCE_VERSION ||
    typeof candidate.ownerPid !== "number" ||
    typeof candidate.claimedAt !== "string"
  ) {
    return undefined;
  }
  const claim: JournalLockClaim = {
    evidenceVersion: EVIDENCE_VERSION,
    ownerPid: candidate.ownerPid,
    claimedAt: candidate.claimedAt,
  };
  if (typeof candidate.ownerStartTicks === "number") {
    claim.ownerStartTicks = candidate.ownerStartTicks;
  }
  return claim;
}

interface JournalLockHandle {
  claimContent: string;
}

async function acquireJournalLock(dir: DirHandle): Promise<JournalLockHandle> {
  const ownerPid = process.pid;
  const ownerStartTicks = readProcessStartTicks(ownerPid);
  const deadline = Date.now() + CLAIM_TOTAL_DEADLINE_MS;

  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
    let handle: fs.promises.FileHandle;
    try {
      handle = await dir.openFile(JOURNAL_LOCK, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const raw = await dir.readFileIfPresent(JOURNAL_LOCK);
      if (raw === undefined) continue;
      const claim = parseJournalLockClaim(raw);
      if (
        claim !== undefined &&
        identityIsAlive(claim.ownerPid, claim.ownerStartTicks)
      ) {
        if (Date.now() >= deadline) break;
        await delay(claimBackoff(attempt));
        continue;
      }
      if (claim !== undefined || attempt >= EMPTY_CLAIM_GRACE_ATTEMPTS) {
        await unlinkIfMatchesIn(dir, JOURNAL_LOCK, raw).catch(() => {});
      }
      if (Date.now() >= deadline) break;
      await delay(claimBackoff(attempt));
      continue;
    }

    const claim: JournalLockClaim = {
      evidenceVersion: EVIDENCE_VERSION,
      ownerPid,
      claimedAt: new Date().toISOString(),
    };
    if (ownerStartTicks !== undefined) claim.ownerStartTicks = ownerStartTicks;
    const claimContent = `${JSON.stringify(claim)}\n`;
    try {
      const buffer = Buffer.from(claimContent, "utf8");
      const { bytesWritten } = await handle.write(buffer, 0, buffer.length, 0);
      if (bytesWritten !== buffer.length) {
        throw new Error(
          `short journal lock write: ${bytesWritten}/${buffer.length} bytes`,
        );
      }
    } catch (error) {
      await handle.close().catch(() => {});
      await dir.unlinkChild(JOURNAL_LOCK).catch(() => {});
      throw error;
    }
    await handle.close();
    return { claimContent };
  }

  throw new Error(`Timed out waiting for evidence journal lock in ${dir.dir}`);
}

async function withJournalLock<T>(
  dir: DirHandle,
  operation: () => Promise<T>,
): Promise<T> {
  const lock = await acquireJournalLock(dir);
  let result: T;
  let operationError: unknown;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }

  // Never turn a successful append into a retryable error after its bytes landed.
  // A release failure leaves a recoverable owner-stamped lock for a later process.
  await unlinkIfMatchesIn(dir, JOURNAL_LOCK, lock.claimContent).catch(() => {});
  if (operationError !== undefined) throw operationError;
  return result!;
}

/**
 * Create or adopt the session's active evidence run.
 *
 * Ownership is claimed with an atomic `wx` create of the pointer file *before*
 * any run directory is made, so a process that loses the race never leaves an
 * orphan run. The winner immediately stamps a claim record carrying its
 * verifiable owner identity (PID + `/proc` start ticks), then creates the run,
 * then atomically publishes the full pointer over its own claim and confirms it
 * is the published owner before returning.
 *
 * A peer that finds a claim never steals it from a *live* owner — only a claim
 * whose owner is provably dead (or an owner-unknown empty claim that persists
 * past a short grace) is reclaimed. This means a slow-but-live claimer can never
 * be timed out from under itself. Losers adopt the winner's run; stale/corrupt
 * pointers are cleared and retried.
 *
 * If the run is created but publication or ownership verification fails, the
 * just-created run is finalized (`failed`) and the claim released, so no
 * permanent running orphan is ever left behind.
 */
export async function beginEvidenceRun(
  projectDir: string,
  sessionId: string,
  opts: BeginEvidenceRunOptions = {},
  env: EnvLike = process.env,
): Promise<BeginEvidenceRunResult> {
  assertSafeSessionId(sessionId);
  // The runs root is materialized descriptor by descriptor through the same
  // trust boundary the catalog reads with (#54), and the descriptor stays open
  // for the whole claim: every pointer create, publish, read, and unlink below
  // resolves through it, so a `.picklab` swapped at any point cannot redirect
  // the pointer file or the run directory.
  return withRunsRootDir(projectDir, env, async (root) => {
    const ownerPid = process.pid;
    const ctx: ClaimContext = {
      projectDir,
      sessionId,
      env,
      root,
      pointerName: pointerName(sessionId),
      ownerPid,
      ownerStartTicks: readProcessStartTicks(ownerPid),
      deadline: Date.now() + CLAIM_TOTAL_DEADLINE_MS,
    };

    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
      const step = await tryClaimPointer(ctx, attempt);
      if (step.kind === "adopt") {
        return adoptEvidenceRun(ctx, step.pointer, step.manifest);
      }
      if (step.kind === "retry") continue;
      if (step.kind === "wait") {
        if (Date.now() >= ctx.deadline) break;
        await delay(claimBackoff(attempt));
        continue;
      }
      const result = await completeOwnedClaim(ctx, step.handle, opts);
      if (result !== undefined) return result;
      if (Date.now() >= ctx.deadline) break;
    }
    throw new Error(
      `Failed to acquire an active evidence run for session ${sessionId} ` +
        `within ${CLAIM_TOTAL_DEADLINE_MS}ms`,
    );
  });
}

interface ClaimContext {
  projectDir: string;
  sessionId: string;
  env: EnvLike;
  /** Open, verified runs root every pointer operation resolves through. */
  root: DirHandle;
  pointerName: string;
  ownerPid: number;
  ownerStartTicks: number | undefined;
  deadline: number;
}

type ClaimStep =
  | { kind: "claimed"; handle: fs.promises.FileHandle }
  | { kind: "adopt"; pointer: ActiveEvidencePointer; manifest: RunManifest }
  /** Retry the claim immediately. */
  | { kind: "retry" }
  /** Back off, or give up at the deadline, then retry the claim. */
  | { kind: "wait" };

async function adoptEvidenceRun(
  ctx: ClaimContext,
  pointer: ActiveEvidencePointer,
  manifest: RunManifest,
): Promise<BeginEvidenceRunResult> {
  return {
    run: await adoptRunIn(ctx.root, pointer.runId, manifest),
    adopted: true,
  };
}

function clearClaim(ctx: ClaimContext, expectRaw: string): Promise<boolean> {
  return clearActivePointerIn(ctx.root, ctx.sessionId, { expectRaw });
}

/**
 * A peer holds the claim. If its owner identity is present and the owner is
 * alive, it is merely slow: wait, never steal. Only reclaim a claim whose
 * owner is provably dead, or an owner-unknown (empty) claim that outlives a
 * short grace (a claimer that died in the microscopic window between the wx
 * create and its identity stamp).
 */
async function stepPastForeignClaim(
  ctx: ClaimContext,
  attempt: number,
  raw: string,
  owner: ActiveEvidenceClaim | undefined,
): Promise<ClaimStep> {
  if (owner !== undefined) {
    if (identityIsAlive(owner.ownerPid, owner.ownerStartTicks)) {
      return { kind: "wait" };
    }
    await clearClaim(ctx, raw);
    return { kind: "retry" };
  }
  if (attempt >= EMPTY_CLAIM_GRACE_ATTEMPTS) await clearClaim(ctx, raw);
  return { kind: "wait" };
}

/** Decide the next step when the `wx` claim failed because a pointer exists. */
async function stepPastExistingPointer(
  ctx: ClaimContext,
  attempt: number,
): Promise<ClaimStep> {
  const resolution = await resolveActivePointerIn(ctx.root, ctx.sessionId);
  switch (resolution.status) {
    case "active":
      return {
        kind: "adopt",
        pointer: resolution.pointer,
        manifest: resolution.manifest,
      };
    case "claiming":
      return stepPastForeignClaim(ctx, attempt, resolution.raw, resolution.claim);
    case "absent":
      // The pointer vanished between our failed claim and the read; retry.
      return { kind: "retry" };
    default:
      // stale or corrupt: clear exactly this content, then retry the claim.
      await clearClaim(ctx, resolution.raw);
      return { kind: "retry" };
  }
}

async function tryClaimPointer(
  ctx: ClaimContext,
  attempt: number,
): Promise<ClaimStep> {
  try {
    const handle = await ctx.root.openFile(ctx.pointerName, "wx");
    return { kind: "claimed", handle };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return stepPastExistingPointer(ctx, attempt);
  }
}

function claimRecordFor(ctx: ClaimContext): string {
  const claimRecord: ActiveEvidenceClaim = {
    evidenceVersion: EVIDENCE_VERSION,
    sessionId: ctx.sessionId,
    ownerPid: ctx.ownerPid,
    claim: true,
    claimedAt: new Date().toISOString(),
  };
  if (ctx.ownerStartTicks !== undefined) {
    claimRecord.ownerStartTicks = ctx.ownerStartTicks;
  }
  return `${JSON.stringify(claimRecord)}\n`;
}

/**
 * We own the claim. Stamp our verifiable identity synchronously so peers can
 * tell we are alive, closing the owner-unknown window as fast as possible.
 */
async function stampClaim(
  ctx: ClaimContext,
  handle: fs.promises.FileHandle,
  claimContent: string,
): Promise<void> {
  try {
    const buf = Buffer.from(claimContent, "utf8");
    const { bytesWritten } = await handle.write(buf, 0, buf.length, 0);
    if (bytesWritten !== buf.length) {
      throw new Error(`short claim write: ${bytesWritten}/${buf.length} bytes`);
    }
  } catch (error) {
    await handle.close().catch(() => {});
    await clearClaim(ctx, claimContent).catch(() => {});
    // Fall back to unconditional cleanup if the claim was never readable.
    await unlinkIfMatchesIn(ctx.root, ctx.pointerName, "").catch(() => {});
    throw error;
  }
  await handle.close().catch(() => {});
}

function pointerRecordFor(ctx: ClaimContext, runId: string): string {
  const pointer: ActiveEvidencePointer = {
    evidenceVersion: EVIDENCE_VERSION,
    sessionId: ctx.sessionId,
    runId,
    ownerPid: ctx.ownerPid,
    createdAt: new Date().toISOString(),
  };
  if (ctx.ownerStartTicks !== undefined) {
    pointer.ownerStartTicks = ctx.ownerStartTicks;
  }
  return `${JSON.stringify(pointer)}\n`;
}

/** Publish the full pointer over our claim and confirm we are the owner. */
async function publishPointer(
  ctx: ClaimContext,
  runId: string,
  claimContent: string,
): Promise<void> {
  // Confirm we still own the claim before publishing. A live owner is never
  // reclaimed, so this passes in practice; it is defense in depth against a
  // reclaim we did not expect.
  const current = await ctx.root.readFileIfPresent(ctx.pointerName);
  if (current !== claimContent) throw new ClaimLostError();

  // Publish atomically (temp + rename) so a concurrent reader never sees a
  // torn pointer: only the intact claim or the intact full pointer. Both the
  // temp create and the rename resolve through the verified root descriptor.
  await ctx.root.writeFileAtomic(ctx.pointerName, pointerRecordFor(ctx, runId));

  // Final confirmation that the published pointer is ours.
  const publishedRaw = await ctx.root.readFileIfPresent(ctx.pointerName);
  const published =
    publishedRaw === undefined ? undefined : parsePointer(publishedRaw);
  if (
    published === undefined ||
    published.runId !== runId ||
    published.ownerPid !== ctx.ownerPid ||
    published.ownerStartTicks !== ctx.ownerStartTicks
  ) {
    throw new ClaimLostError();
  }
}

/**
 * Create the run, then publish the pointer over our claim. If publication or
 * verification fails, the just-created run is finalized (`failed`) so it is
 * never a permanent running orphan, and the claim is released (a no-op if a
 * peer already replaced it) so the session can recover.
 */
async function createAndPublishRun(
  ctx: ClaimContext,
  opts: BeginEvidenceRunOptions,
  claimContent: string,
): Promise<RunHandle> {
  let run: RunHandle | undefined;
  try {
    if (opts._afterClaim !== undefined) await opts._afterClaim();
    run = await createRun(
      ctx.projectDir,
      opts.slug ?? "evidence",
      {
        now: opts.now,
        sessionId: ctx.sessionId,
        meta: opts.meta,
        evidence: true,
      },
      ctx.env,
    );
    await publishPointer(ctx, run.runId, claimContent);
    return run;
  } catch (error) {
    if (run !== undefined) await run.finish("failed").catch(() => {});
    await clearClaim(ctx, claimContent).catch(() => {});
    throw error;
  }
}

/**
 * Own the claim end to end. Returns the new run, the adopted run of an owner
 * that took the session meanwhile, or `undefined` when the claim was lost and
 * nothing is active yet (the caller retries within the remaining budget).
 */
async function completeOwnedClaim(
  ctx: ClaimContext,
  handle: fs.promises.FileHandle,
  opts: BeginEvidenceRunOptions,
): Promise<BeginEvidenceRunResult | undefined> {
  const claimContent = claimRecordFor(ctx);
  await stampClaim(ctx, handle, claimContent);
  try {
    const run = await createAndPublishRun(ctx, opts, claimContent);
    return { run, adopted: false };
  } catch (error) {
    if (!(error instanceof ClaimLostError)) throw error;
    const resolution = await resolveActivePointerIn(ctx.root, ctx.sessionId);
    if (resolution.status === "active") {
      return adoptEvidenceRun(ctx, resolution.pointer, resolution.manifest);
    }
    return undefined;
  }
}

/**
 * Finalize and release the evidence run currently associated with a session.
 * The pointer is compare-cleared only after the manifest is durable, so a
 * concurrently replaced pointer is never removed.
 */
export async function finalizeActiveEvidenceRun(
  projectDir: string,
  sessionId: string,
  status: RunStatus = "completed",
  env: EnvLike = process.env,
): Promise<RunManifest | undefined> {
  const finalized = await withExistingRunsRootDir(
    projectDir,
    env,
    async (root) => {
      if (root === undefined) return { done: true as const };
      return finalizeUnderRoot(
        { projectDir, sessionId, env, root },
        status,
      );
    },
  );
  if (finalized.done) return undefined;
  await pruneFinalizedEvidenceRuns(projectDir, {}, env);
  return finalized.manifest;
}

/**
 * Finalize under an open, verified runs root: the run is adopted through the
 * same descriptor the pointer was read from, so the manifest update lands in
 * the verified run directory or fails.
 */
async function finalizeUnderRoot(
  ctx: FinalizeContext,
  status: RunStatus,
): Promise<{ done: true } | { done: false; manifest: RunManifest }> {
  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
    const step = await resolveFinalizableRun(ctx, attempt);
    if (step.kind === "done") return { done: true };
    if (step.kind === "retry") continue;

    const { pointer, manifest } = step;
    if (manifest.status === "running") {
      const run = await adoptRunIn(ctx.root, pointer.runId, manifest);
      manifest.evidenceTruncated = await isEvidenceTruncatedIn(run.binding);
      await run.finish(status);
    }
    const cleared = await clearActivePointerIn(ctx.root, ctx.sessionId, {
      expectRaw: step.raw,
    });
    if (!cleared) continue;
    return { done: false, manifest };
  }
  throw new Error(
    `Failed to finalize the active evidence run for session ${ctx.sessionId}`,
  );
}

interface FinalizeContext {
  projectDir: string;
  sessionId: string;
  env: EnvLike;
  /** Open, verified runs root every pointer and run access resolves through. */
  root: DirHandle;
}

type FinalizeStep =
  | { kind: "done" }
  | { kind: "retry" }
  | {
      kind: "ready";
      raw: string;
      pointer: ActiveEvidencePointer;
      manifest: RunManifest;
    };

/** Compare-clear the pointer: done if it was ours to clear, else retry. */
async function clearOrRetry(
  ctx: FinalizeContext,
  raw: string,
): Promise<FinalizeStep> {
  const cleared = await clearActivePointerIn(ctx.root, ctx.sessionId, {
    expectRaw: raw,
  });
  return { kind: cleared ? "done" : "retry" };
}

/** Wait out a live or freshly made claim; reclaim only a provably dead one. */
async function waitOutForeignClaim(
  ctx: FinalizeContext,
  attempt: number,
  raw: string,
  owner: ActiveEvidenceClaim | undefined,
): Promise<FinalizeStep> {
  const live =
    owner !== undefined &&
    identityIsAlive(owner.ownerPid, owner.ownerStartTicks);
  const inGrace = owner === undefined && attempt < EMPTY_CLAIM_GRACE_ATTEMPTS;
  if (live || inGrace) {
    await delay(claimBackoff(attempt));
    return { kind: "retry" };
  }
  return clearOrRetry(ctx, raw);
}

async function resolveFinalizableRun(
  ctx: FinalizeContext,
  attempt: number,
): Promise<FinalizeStep> {
  const resolution = await resolveActivePointerIn(ctx.root, ctx.sessionId);
  if (resolution.status === "absent") return { kind: "done" };
  if (resolution.status === "claiming") {
    return waitOutForeignClaim(ctx, attempt, resolution.raw, resolution.claim);
  }
  if (resolution.status === "corrupt") return clearOrRetry(ctx, resolution.raw);

  const pointer = resolution.pointer;
  if (pointer === undefined) return { kind: "retry" };
  const manifest =
    resolution.status === "active"
      ? resolution.manifest
      : await readManifestIn(ctx.root, pointer.runId);
  if (
    manifest === undefined ||
    !isEvidenceRun(manifest) ||
    !manifestMatchesPointer(manifest, pointer, ctx.sessionId)
  ) {
    return clearOrRetry(ctx, resolution.raw);
  }
  return { kind: "ready", raw: resolution.raw, pointer, manifest };
}

function encodeRecord(record: EvidenceRecord): string {
  return `${JSON.stringify(record)}\n`;
}

function isMetadataOnly(record: EvidenceRecord): boolean {
  if (isTruncationRecord(record)) return true;
  return record.artifacts === undefined || record.artifacts.length === 0;
}

function buildTruncationMarker(
  usedBytes: number,
  maxBytes: number,
): EvidenceTruncationRecord {
  return {
    actionId: `truncation-${Date.now().toString(36)}`,
    evidenceTruncated: true,
    reason: "evidence-cap",
    bytes: usedBytes,
    maxBytes,
    recordedAt: new Date().toISOString(),
  };
}

/**
 * Measure the cumulative on-disk evidence footprint of a run: the action
 * journal plus every artifact file written under the run directory
 * (screenshots, logs, and any other run-relative artifact). Control and summary
 * files that are not auto-generated evidence — the manifest, the truncation
 * sentinel, and transient dot-prefixed temp files — are excluded, as are
 * symlinks (never followed, so a planted link cannot skew the count or escape
 * the tree).
 *
 * Because this reads real bytes on disk, the count is inherently cumulative
 * across appends and consistent across processes: any process appending to the
 * same run observes the same total, so the cap cannot be evaded by spreading
 * writes over many calls or many processes.
 */
interface RunByteCacheEntry {
  /** Cumulative bytes of every counted file except the journal itself. */
  artifactBytes: number;
  /**
   * The exact same *counted* entry names measurement itself would see (every
   * non-symlink file except the manifest, the journal, and dot-prefixed
   * control/temp files, plus every non-symlink subdirectory), keyed by path
   * relative to runDir. Deliberately excludes uncounted control files (the
   * journal lock, the truncation sentinel, the manifest) so their churn on
   * every append never forces a rescan.
   */
  entries: Map<string, string>;
}

/** In-process cache of the last-measured artifact footprint per run directory. */
const runByteCache = new Map<string, RunByteCacheEntry>();

/** Drop a run's cached byte-accounting state (e.g. once it is pruned). */
function forgetRunByteCache(runDir: string): void {
  runByteCache.delete(runDir);
}

/**
 * Snapshot the set of *counted* entry names in every directory of the run tree
 * (never following symlinks, never touching a file's contents) — the same
 * filter `walkRunArtifactBytes` applies. Comparing this against a prior
 * snapshot is a cheap, correct way to tell whether anything that contributes
 * to the artifact total was added, removed, or renamed, without lstat-ing any
 * file and without being fooled by uncounted control-file churn (the journal
 * lock and truncation sentinel are created and removed on every append).
 * Returns `undefined` if the run directory itself is gone.
 */
async function snapshotRunDirEntries(
  runDir: string,
): Promise<Map<string, string> | undefined> {
  // `runDir` is the pinned directory's capability path: the whole walk stays
  // inside the descriptor's directory, whatever happens to its ancestors.
  const result = new Map<string, string>();
  const walk = async (dir: string, rel: string): Promise<boolean> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    const files: string[] = [];
    const subdirs: string[] = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        subdirs.push(entry.name);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel2 = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (rel2 === "manifest.json") continue;
      if (rel2 === EVIDENCE_ACTION_LOG) continue;
      if (entry.name.startsWith(".")) continue;
      files.push(entry.name);
    }
    files.sort();
    subdirs.sort();
    result.set(rel, files.join("\0"));
    for (const name of subdirs) {
      const childRel = rel === "" ? name : `${rel}/${name}`;
      if (!(await walk(path.join(dir, name), childRel))) return false;
    }
    return true;
  };
  return (await walk(runDir, "")) ? result : undefined;
}

function dirEntriesEqual(
  a: Map<string, string>,
  b: Map<string, string>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [rel, signature] of a) {
    if (b.get(rel) !== signature) return false;
  }
  return true;
}

/**
 * Full recursive scan of every counted file under the run directory (every
 * file except the action journal, the manifest, and dot-prefixed control/temp
 * files; symlinks are never followed). This is the ground truth the cache in
 * `measureRunArtifactBytes` falls back to whenever the directory-mtime
 * snapshot shows the tree may have changed.
 */
async function walkRunArtifactBytes(runDir: string): Promise<number> {
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(runDir, full);
      // Exclude the manifest, the journal (measured live, separately, since it
      // is appended in place rather than replaced), and any dot-prefixed
      // control/temp file (the truncation sentinel, `.manifest.json.tmp-*`,
      // pointer temps).
      if (rel === "manifest.json") continue;
      if (rel === EVIDENCE_ACTION_LOG) continue;
      if (entry.name.startsWith(".")) continue;
      try {
        const stat = await fs.promises.lstat(full);
        total += stat.size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
  };
  await walk(runDir);
  return total;
}

/**
 * Measure the cumulative on-disk bytes of every counted artifact under the run
 * directory, excluding the action journal (whose live size the caller adds
 * separately, since it is appended to in place). Because this reads real bytes
 * on disk it stays consistent across processes: the cap cannot be evaded by
 * spreading writes over many calls or many processes, or by writing artifact
 * files directly without ever referencing them in a journaled action.
 *
 * A full recursive lstat scan is only performed the first time a run is seen,
 * or when an entry-name snapshot (readdir only, no lstat) shows the counted
 * tree actually changed since the last scan (a file was added, removed, or
 * renamed somewhere in the tree). Otherwise the previously measured total is
 * reused as-is, turning the common case — many actions in a row that write no
 * new artifact — into a handful of `readdir` calls instead of a full recursive
 * `readdir`+`lstat` of every file on every append.
 */
async function measureRunArtifactBytes(dir: DirHandle): Promise<number> {
  // The cache is keyed by the run's stable logical path; the scan itself walks
  // the descriptor's capability path, which changes with the descriptor number.
  const cacheKey = dir.dir;
  const walkRoot = dir.resolve();
  const cached = runByteCache.get(cacheKey);
  const currentEntries = await snapshotRunDirEntries(walkRoot);
  if (
    cached !== undefined &&
    currentEntries !== undefined &&
    dirEntriesEqual(cached.entries, currentEntries)
  ) {
    return cached.artifactBytes;
  }
  const artifactBytes = await walkRunArtifactBytes(walkRoot);
  if (currentEntries === undefined) {
    forgetRunByteCache(cacheKey);
  } else {
    runByteCache.set(cacheKey, { artifactBytes, entries: currentEntries });
  }
  return artifactBytes;
}

/**
 * Measure the cumulative on-disk evidence footprint of a run: the action
 * journal plus every artifact file written under the run directory
 * (screenshots, logs, and any other run-relative artifact). Control and summary
 * files that are not auto-generated evidence — the manifest, the truncation
 * sentinel, and transient dot-prefixed temp files — are excluded, as are
 * symlinks (never followed, so a planted link cannot skew the count or escape
 * the tree).
 *
 * Because this reads real bytes on disk, the count is inherently cumulative
 * across appends and consistent across processes: any process appending to the
 * same run observes the same total, so the cap cannot be evaded by spreading
 * writes over many calls or many processes.
 */
async function measureRunEvidenceBytes(
  dir: DirHandle,
  journalBytes: number,
): Promise<number> {
  return (await measureRunArtifactBytes(dir)) + journalBytes;
}

async function repairTornJournalTail(
  handle: fs.promises.FileHandle,
): Promise<void> {
  const { size } = await handle.stat();
  if (size === 0) return;

  const lastByte = Buffer.allocUnsafe(1);
  const { bytesRead } = await handle.read(lastByte, 0, 1, size - 1);
  if (bytesRead === 1 && lastByte[0] === 0x0a) return;

  const chunkSize = EVIDENCE_MAX_LINE_BYTES;
  let end = size;
  while (end > 0) {
    const start = Math.max(0, end - chunkSize);
    const chunk = Buffer.allocUnsafe(end - start);
    const read = await handle.read(chunk, 0, chunk.length, start);
    const newline = chunk.subarray(0, read.bytesRead).lastIndexOf(0x0a);
    if (newline >= 0) {
      await handle.truncate(start + newline + 1);
      return;
    }
    end = start;
  }
  await handle.truncate(0);
}

async function appendLine(
  handle: fs.promises.FileHandle,
  line: string,
): Promise<number> {
  const startSize = (await handle.stat()).size;
  const buf = Buffer.from(line, "utf8");
  const { bytesWritten } = await handle.write(buf);
  if (bytesWritten !== buf.length) {
    await handle.truncate(startSize).catch(() => {});
    throw new Error(
      `short evidence append: ${bytesWritten}/${buf.length} bytes`,
    );
  }
  return bytesWritten;
}

/**
 * Whether a run has already crossed its evidence cap. Backed by the wx sentinel
 * that gates the one-time truncation marker, so this is O(1) and consistent
 * across processes.
 */
export async function isEvidenceTruncated(
  run: EvidenceRunTarget,
): Promise<boolean> {
  return withEvidenceDir(run, sentinelExists);
}

/** {@link isEvidenceTruncated} for a run that is already bound. */
async function isEvidenceTruncatedIn(
  binding: RunDirBinding,
): Promise<boolean> {
  return withBoundRunDir(binding, sentinelExists);
}

async function sentinelExists(dir: DirHandle): Promise<boolean> {
  try {
    await fs.promises.stat(dir.resolve(TRUNCATION_SENTINEL));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * A run to write evidence into: a {@link RunHandle}, whose binding re-verifies
 * the runs root and the run directory identity before handing out a
 * descriptor, or a run directory path for callers that only have one. Either
 * way every journal, lock, sentinel, and marker write of a single call is
 * issued through one descriptor opened with `O_DIRECTORY|O_NOFOLLOW`, so the
 * writes of that call cannot be split across two directories by a swap.
 */
export type EvidenceRunTarget = string | RunHandle;

function withEvidenceDir<T>(
  run: EvidenceRunTarget,
  fn: (dir: DirHandle) => Promise<T>,
): Promise<T> {
  if (typeof run !== "string") return withBoundRunDir(run.binding, fn);
  return withDirHandle(DirHandle.open(run), fn);
}

/**
 * Append one bounded, newline-terminated JSON record to the run's action
 * journal using a single `O_APPEND` write, and verify the full write. The
 * manifest is never touched.
 *
 * Cap behavior: while under `maxBytes` the record is appended normally. The
 * append that first reaches the cap also writes exactly one truncation marker
 * (gated by an atomic `wx` sentinel, so concurrent processes still write it at
 * most once) and returns `"truncated"`. Once truncated, bounded metadata-only
 * actions continue to be recorded (`"appended"`), while actions carrying
 * artifacts are dropped (`"capped"`).
 *
 * Over-long records are rejected with a `RangeError` before any write.
 */
export async function appendAction(
  run: EvidenceRunTarget,
  record: EvidenceRecord,
  opts: AppendActionOptions = {},
): Promise<AppendResult> {
  const maxLineBytes = opts.maxLineBytes ?? EVIDENCE_MAX_LINE_BYTES;
  const maxBytes = opts.maxBytes ?? EVIDENCE_MAX_BYTES;
  const externalBytes = opts.externalBytes ?? 0;
  const markerHooks: MarkerHooks = {
    afterClaim: opts._afterMarkerClaim,
    failAppend: opts._failMarkerAppend,
  };

  const line = encodeRecord(record);
  const lineBytes = Buffer.byteLength(line, "utf8");
  if (lineBytes > maxLineBytes) {
    throw new RangeError(
      `evidence record is ${lineBytes} bytes, exceeding the ` +
        `${maxLineBytes}-byte per-record limit`,
    );
  }

  return withEvidenceDir(run, (dir) =>
    withJournalLock(dir, async () => {
      const handle = await dir.openFile(
        EVIDENCE_ACTION_LOG,
        fs.constants.O_RDWR |
          fs.constants.O_CREAT |
          fs.constants.O_APPEND |
          fs.constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await repairTornJournalTail(handle);
        // Derive current usage from the run directory's real on-disk bytes
        // (journal + artifacts), so the cap is cumulative across every prior
        // append and every process. `externalBytes` only adds bytes not yet
        // under the run dir. The journal's own live size comes straight off the
        // open handle (already repaired above), since it is appended to in
        // place rather than replaced.
        const journalBytes = (await handle.stat()).size;
        const used =
          (await measureRunEvidenceBytes(dir, journalBytes)) + externalBytes;

        if (used >= maxBytes) {
          // Already at or beyond the cap. Ensure the one-time marker exists,
          // then record only bounded metadata-only actions.
          const wroteMarker = await writeTruncationMarkerOnce(
            dir,
            handle,
            used,
            maxBytes,
            markerHooks,
          );
          if (!isMetadataOnly(record)) {
            return { outcome: "capped", bytesWritten: 0, usedBytes: used };
          }
          const written = await appendLine(handle, line);
          return {
            outcome: wroteMarker ? "truncated" : "appended",
            bytesWritten: written,
            usedBytes: used + written,
          };
        }

        const written = await appendLine(handle, line);
        const usedAfter = used + written;
        if (usedAfter >= maxBytes) {
          try {
            await writeTruncationMarkerOnce(
              dir,
              handle,
              usedAfter,
              maxBytes,
              markerHooks,
            );
            return {
              outcome: "truncated",
              bytesWritten: written,
              usedBytes: usedAfter,
            };
          } catch {
            // The caller's record is already durable and cannot be rolled back
            // without risking another process's append. Report success and let
            // the next append recover the marker instead of inviting a
            // duplicate retry.
            return {
              outcome: "appended",
              bytesWritten: written,
              usedBytes: usedAfter,
              truncationPending: true,
            };
          }
        }
        return {
          outcome: "appended",
          bytesWritten: written,
          usedBytes: usedAfter,
        };
      } finally {
        await handle.close();
      }
    }),
  );
}

/** Interim record a claimant stamps into the truncation sentinel at `wx` time. */
interface TruncationClaim {
  evidenceVersion: typeof EVIDENCE_VERSION;
  ownerPid: number;
  ownerStartTicks?: number;
  claim: true;
  claimedAt: string;
}

/** Committed sentinel: the marker is durably in the journal, so peers skip. */
interface TruncationCommit {
  evidenceVersion: typeof EVIDENCE_VERSION;
  ownerPid: number;
  ownerStartTicks?: number;
  committed: true;
  committedAt: string;
}

type TruncationSentinelState =
  | { kind: "claim"; claim: TruncationClaim }
  | { kind: "committed" };

/** @internal Test hooks threaded from `appendAction` into the marker writer. */
interface MarkerHooks {
  afterClaim?: () => void | Promise<void>;
  failAppend?: () => Promise<never> | never;
}

/**
 * Classify truncation-sentinel content. A `committed` record means the marker is
 * durably written; a `claim` record carries the writer's verifiable identity so
 * a peer can tell a live claimer from a crashed one. Empty, torn, or otherwise
 * unparseable content is `undefined` (owner-unknown), handled with a grace.
 */
function parseTruncationSentinel(
  raw: string,
): TruncationSentinelState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const candidate = parsed as Record<string, unknown>;
  if (candidate.evidenceVersion !== EVIDENCE_VERSION) return undefined;
  if (candidate.committed === true) return { kind: "committed" };
  if (
    candidate.claim === true &&
    typeof candidate.ownerPid === "number" &&
    typeof candidate.claimedAt === "string"
  ) {
    const claim: TruncationClaim = {
      evidenceVersion: EVIDENCE_VERSION,
      ownerPid: candidate.ownerPid,
      claim: true,
      claimedAt: candidate.claimedAt,
    };
    if (typeof candidate.ownerStartTicks === "number") {
      claim.ownerStartTicks = candidate.ownerStartTicks;
    }
    return { kind: "claim", claim };
  }
  return undefined;
}

/**
 * Best-effort scan for a committed truncation marker anywhere in the journal.
 * Used only on winning a (re)claim, to avoid writing a second marker when a
 * prior writer crashed after appending the marker but before committing its
 * sentinel. Tolerant of a torn final line and of unparseable lines (skipped),
 * since it only needs to answer "is a marker already present?".
 */
async function journalHasTruncationMarker(dir: DirHandle): Promise<boolean> {
  const raw = await dir.readFileIfPresent(EVIDENCE_ACTION_LOG);
  if (raw === undefined || raw === "") return false;
  const segments = raw.split("\n");
  // Drop the clean terminator's trailing "" or a torn (unterminated) final line.
  segments.pop();
  for (const segment of segments) {
    if (segment === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(segment);
    } catch {
      continue;
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as EvidenceTruncationRecord).evidenceTruncated === true
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Atomically commit the truncation sentinel to a `committed` record (temp +
 * rename), publishing that the marker is durably in the journal. The rename
 * replaces the claim in place, so a concurrent reader only ever sees the intact
 * claim or the intact commit — never a torn sentinel and never an absent one.
 */
async function commitTruncationSentinel(
  dir: DirHandle,
  ownerPid: number,
  ownerStartTicks: number | undefined,
): Promise<void> {
  const commit: TruncationCommit = {
    evidenceVersion: EVIDENCE_VERSION,
    ownerPid,
    committed: true,
    committedAt: new Date().toISOString(),
  };
  if (ownerStartTicks !== undefined) commit.ownerStartTicks = ownerStartTicks;
  await dir.writeFileAtomic(TRUNCATION_SENTINEL, `${JSON.stringify(commit)}\n`);
}

/**
 * Write the truncation marker at most once for a run, durably and recoverably.
 *
 * The sentinel is a recoverable claim, not a bare flag. The winner of the atomic
 * `wx` create stamps its verifiable owner identity (PID + `/proc` start ticks),
 * appends the marker to the journal, then atomically commits the sentinel to a
 * `committed` record. A committed sentinel means the marker is durably present,
 * so peers skip idempotently.
 *
 * This closes the crash/append-failure gap a bare sentinel leaves — where a
 * process that created the sentinel but died (or failed) before appending the
 * marker would block truncation forever:
 * - A peer never steals a *live* claim; it returns false and lets the owner
 *   finish (or, if that owner later dies, the next append reclaims).
 * - A claim whose owner is provably dead — or an owner-unknown empty claim that
 *   outlives a short grace — is compare-and-cleared and re-raced via `wx`, whose
 *   exclusivity elects exactly one recovery writer.
 * - On winning a (re)claim, the journal is checked first: if a prior crashed
 *   writer already committed the marker, this process commits the sentinel and
 *   returns false rather than writing a duplicate.
 * - If the marker append itself fails, the claim is cleared so the sentinel does
 *   not persist as a permanent gate with no marker; the next append retries.
 *
 * Returns true only for the process that actually appended the marker.
 */
// eslint-disable-next-line complexity -- Legacy gate debt: pickforge/pickforge#60
async function writeTruncationMarkerOnce(
  dir: DirHandle,
  handle: fs.promises.FileHandle,
  usedBytes: number,
  maxBytes: number,
  hooks: MarkerHooks = {},
): Promise<boolean> {
  const ownerPid = process.pid;
  const ownerStartTicks = readProcessStartTicks(ownerPid);
  const deadline = Date.now() + CLAIM_TOTAL_DEADLINE_MS;

  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
    let sentinel: fs.promises.FileHandle;
    try {
      sentinel = await dir.openFile(TRUNCATION_SENTINEL, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const raw = await dir.readFileIfPresent(TRUNCATION_SENTINEL);
      if (raw === undefined) continue; // Vanished between wx and read; retry.
      const state = parseTruncationSentinel(raw);
      if (state?.kind === "committed") return false; // Marker durably written.
      if (state?.kind === "claim") {
        // A live owner is writing (or will write) the marker — never duplicate.
        // Only a provably dead owner's claim is reclaimed, so a slow-but-live
        // writer is never stolen from.
        if (identityIsAlive(state.claim.ownerPid, state.claim.ownerStartTicks)) {
          const ownedByCaller =
            state.claim.ownerPid === ownerPid &&
            state.claim.ownerStartTicks === ownerStartTicks;
          // eslint-disable-next-line max-depth -- Legacy gate debt: pickforge/pickforge#60
          if (ownedByCaller && (await journalHasTruncationMarker(dir))) {
            await commitTruncationSentinel(dir, ownerPid, ownerStartTicks);
          }
          return false;
        }
        await unlinkIfMatchesIn(dir, TRUNCATION_SENTINEL, raw).catch(() => {});
        continue;
      }
      // Owner-unknown (empty/torn/unparseable) claim: a winner stamps identity
      // synchronously, so this only persists if the claimer died in the tiny
      // window between the `wx` create and its stamp. Tolerate a short grace,
      // then reclaim.
      if (attempt >= EMPTY_CLAIM_GRACE_ATTEMPTS) {
        await unlinkIfMatchesIn(dir, TRUNCATION_SENTINEL, raw).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) return false;
      await delay(claimBackoff(attempt));
      continue;
    }

    // We own a fresh claim. Stamp verifiable identity synchronously so peers can
    // tell we are alive, closing the owner-unknown window as fast as possible.
    const claimRecord: TruncationClaim = {
      evidenceVersion: EVIDENCE_VERSION,
      ownerPid,
      claim: true,
      claimedAt: new Date().toISOString(),
    };
    if (ownerStartTicks !== undefined) {
      claimRecord.ownerStartTicks = ownerStartTicks;
    }
    const claimContent = `${JSON.stringify(claimRecord)}\n`;
    try {
      const buf = Buffer.from(claimContent, "utf8");
      const { bytesWritten } = await sentinel.write(buf, 0, buf.length, 0);
      if (bytesWritten !== buf.length) {
        throw new Error(
          `short truncation claim write: ${bytesWritten}/${buf.length} bytes`,
        );
      }
    } finally {
      await sentinel.close().catch(() => {});
    }

    let appended = false;
    try {
      if (hooks.afterClaim !== undefined) await hooks.afterClaim();

      // A prior crashed writer may have appended the marker before it could
      // commit its sentinel (crash between append and commit). Never write a
      // second one: recover by committing the sentinel over the existing marker.
      if (await journalHasTruncationMarker(dir)) {
        await commitTruncationSentinel(dir, ownerPid, ownerStartTicks);
        return false;
      }

      if (hooks.failAppend !== undefined) {
        await hooks.failAppend();
      } else {
        await appendLine(
          handle,
          encodeRecord(buildTruncationMarker(usedBytes, maxBytes)),
        );
      }
      appended = true;
      await commitTruncationSentinel(dir, ownerPid, ownerStartTicks);
      return true;
    } catch (error) {
      // The append failed, so no marker was written: clear our claim so the
      // sentinel never persists as a permanent gate with no truncation action —
      // the next append retries cleanly. If instead the append succeeded and only
      // the commit failed, the marker is already durable; leave the (recoverable)
      // claim so `isEvidenceTruncated` stays true and a later append commits it
      // or, once we exit, reclaims and commits it.
      if (!appended) {
        await unlinkIfMatchesIn(dir, TRUNCATION_SENTINEL, claimContent).catch(
          () => {},
        );
      }
      throw error;
    }
  }
  return false;
}

/** Parse an action journal using the same torn-tail and corruption rules as reads. */
export function parseActionsJournal(
  raw: string,
  journalLabel: string,
): EvidenceRecord[] {
  if (raw === "") return [];

  const segments = raw.split("\n");
  // A trailing "\n" leaves a final "" segment (a clean terminator); no trailing
  // "\n" means the final segment is a torn line. Either way, drop the last.
  segments.pop();

  const records: EvidenceRecord[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (segment === "") {
      throw new Error(
        `Corrupt evidence journal in ${journalLabel}: blank record at line ${index + 1}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(segment);
    } catch (error) {
      throw new Error(
        `Corrupt evidence journal in ${journalLabel} at line ${index + 1}: ` +
          `${(error as Error).message}`,
      );
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as EvidenceAction).actionId !== "string"
    ) {
      throw new Error(
        `Corrupt evidence journal in ${journalLabel} at line ${index + 1}: ` +
          `record is not a valid evidence record`,
      );
    }
    records.push(parsed as EvidenceRecord);
  }
  return records;
}

/**
 * Read the run's action journal deterministically. Records are returned in file
 * (append) order. A missing/empty journal yields `[]`. Only a torn final line
 * (an unterminated last record from an interrupted write) is tolerated and
 * dropped; any malformed or blank line before the end is rejected.
 */
export async function readActions(runDir: string): Promise<EvidenceRecord[]> {
  const journalPath = path.join(runDir, EVIDENCE_ACTION_LOG);
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(
      journalPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let raw: string;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(`Unsafe evidence journal in ${runDir}: not a regular file`);
    }
    raw = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  return parseActionsJournal(raw, runDir);
}

export function isEvidenceRun(manifest: RunManifest): boolean {
  return manifest.evidenceVersion === EVIDENCE_VERSION;
}

function isFinalizedStatus(status: RunStatus): boolean {
  return status === "completed" || status === "failed";
}

/** Collect run ids currently referenced by any session's active pointer. */
async function collectActiveRunIds(parent: string): Promise<Set<string>> {
  const active = new Set<string>();
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(parent, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return active;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith(".active-") || !entry.name.endsWith(".json")) {
      continue;
    }
    let raw: string;
    try {
      raw = await fs.promises.readFile(path.join(parent, entry.name), "utf8");
    } catch {
      continue;
    }
    const pointer = parsePointer(raw);
    if (pointer !== undefined) active.add(pointer.runId);
  }
  return active;
}

/**
 * Retain only the newest `keep` (default 20) finalized evidence runs per
 * project, deleting older finalized evidence run directories. Never prunes:
 * running/active runs (status `running` or referenced by an active pointer),
 * legacy runs (no `evidenceVersion`), or anything outside the resolved
 * storage mode's primary root. `openRunCatalog` layers a read-only legacy
 * project-local root under home/custom mode purely for discovery
 * (`artifact_list`/`report`/resources) — pruning that root would delete
 * runs this process does not own and never migrated, so retention counting
 * and removal are scoped to `entry.rootDir === resolved.runsDir` only.
 *
 * `finalizeActiveEvidenceRun` calls this automatically after every
 * finalization.
 */
// eslint-disable-next-line complexity -- Legacy gate debt: pickforge/pickforge#60
export async function pruneFinalizedEvidenceRuns(
  projectDir: string,
  opts: PruneEvidenceOptions = {},
  env: EnvLike = process.env,
): Promise<string[]> {
  const keep = opts.keep ?? EVIDENCE_RETENTION_KEEP;
  const resolved = await resolveRunStorage(projectDir, env);
  const primaryRootDir = path.resolve(resolved.runsDir);
  const catalog = await openRunCatalog(projectDir, env);
  const entries = (await catalog.list()).filter(
    (entry) => entry.rootDir === primaryRootDir,
  );
  const activeByRoot = new Map<string, Set<string>>();
  for (const entry of entries) {
    if (!activeByRoot.has(entry.rootDir)) {
      activeByRoot.set(entry.rootDir, await collectActiveRunIds(entry.rootDir));
    }
  }

  const finalized = entries.filter(
    (entry) =>
      isEvidenceRun(entry.manifest) &&
      isFinalizedStatus(entry.manifest.status) &&
      !activeByRoot.get(entry.rootDir)?.has(entry.dirName),
  );

  const removed: string[] = [];
  for (const entry of finalized.slice(keep)) {
    const { dirName, dir, rootDir } = entry;
    if (!isSafeRunId(dirName)) continue;
    // Confinement: only a real, non-symlink directory directly under its
    // catalog root is a removal candidate.
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(dir);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
    if (path.dirname(dir) !== rootDir) continue;
    // Re-read through the catalog immediately before removal. A run that was
    // swapped, mutated, or whose manifest no longer binds to its directory is
    // never deleted.
    const fresh = await catalog.refresh(entry);
    if (
      fresh === undefined ||
      !isEvidenceRun(fresh) ||
      !isFinalizedStatus(fresh.status)
    ) {
      continue;
    }
    // Re-check the active pointers last: an owner may have re-claimed this run
    // between the first scan and now.
    const activeNow = await collectActiveRunIds(rootDir);
    if (activeNow.has(dirName)) continue;
    await fs.promises.rm(dir, { recursive: true, force: true });
    forgetRunByteCache(dir);
    removed.push(dirName);
  }
  return removed;
}
