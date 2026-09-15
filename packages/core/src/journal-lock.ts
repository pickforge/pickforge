import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { DirHandle } from "./dir-handle.js";
import { identityIsAlive, readProcessStartTicks } from "./proc.js";

export const EVIDENCE_VERSION = 1 as const;
const JOURNAL_LOCK = ".evidence-journal.lock";
export const CLAIM_TOTAL_DEADLINE_MS = 5_000;
const CLAIM_BACKOFF_MS = 5;
const CLAIM_BACKOFF_MAX_MS = 50;
export const EMPTY_CLAIM_GRACE_ATTEMPTS = 4;
export const MAX_CLAIM_ATTEMPTS = 10_000;

export function claimBackoff(attempt: number): number {
  return Math.min(CLAIM_BACKOFF_MS * (attempt + 1), CLAIM_BACKOFF_MAX_MS);
}

/** Compare and unlink through the same held directory, preserving the existing claim protocol. */
export async function unlinkIfMatchesIn(dir: DirHandle, name: string, expected: string): Promise<boolean> {
  const current = await dir.readFileIfPresent(name);
  if (current === undefined) return false;
  if (current !== expected) return false;
  return dir.unlinkChild(name);
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
        throw new Error(`short journal lock write: ${bytesWritten}/${buffer.length} bytes`);
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

/** Serialize manifest mutations, recovery/report snapshots and appenders with one existing lock. */
export async function withJournalLock<T>(dir: DirHandle, operation: () => Promise<T>): Promise<T> {
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
