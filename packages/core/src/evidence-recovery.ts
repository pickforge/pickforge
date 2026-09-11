import fs from "node:fs";
import path from "node:path";
import { RunStorageAccessError, type DirHandle } from "./dir-handle.js";
import type { EnvLike } from "./paths.js";
import { EVIDENCE_ACTION_LOG, type RunManifest } from "./run.js";
import { openRunDirIn, withRecoveryRunsRootDir } from "./run-root.js";
import {
  inspectEvidenceManifestIn,
  parseRecoverableActionsJournal,
  recoverySessionMayBeWritingIn,
  readEvidenceManifestIn,
  withJournalLock,
  type RecoverableJournal,
} from "./evidence.js";
import {
  EVIDENCE_REPORT,
  renderEvidenceSessionIndex,
  writeEvidenceReportIn,
} from "./evidence-render.js";

export interface RecoveredEvidenceRun {
  runId: string;
  status: RunManifest["status"];
  actions: number;
  journal: NonNullable<RunManifest["evidenceRecovery"]>;
  warning?: string;
}

export interface SkippedEvidenceRun {
  runId: string;
  reason: string;
}

export interface EvidenceRecoveryResult {
  sessions: { sessionId: string; index: string; runs: RecoveredEvidenceRun[] }[];
  skipped: SkippedEvidenceRun[];
}

type RecoverOutcome =
  | { kind: "ignore" }
  | { kind: "skip"; reason: string }
  | { kind: "run"; sessionId: string; run: RecoveredEvidenceRun };

function safeId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]*$/i.test(value) && !value.includes("..");
}

function isDisappearedRun(error: unknown): boolean {
  return (
    error instanceof RunStorageAccessError &&
    /disappeared while being verified/.test(error.message)
  );
}

function skipIdentity(): RecoverOutcome {
  return { kind: "skip", reason: "owner or session identity unavailable" };
}

function recoveredRun(
  manifest: RunManifest,
  parsed: RecoverableJournal,
): RecoveredEvidenceRun {
  return {
    runId: manifest.runId,
    status: manifest.status,
    actions: parsed.records.length,
    journal: parsed.journal,
    warning: parsed.warning,
  };
}

async function recoveryJournal(dir: DirHandle): Promise<RecoverableJournal> {
  const stat = await dir.lstatChild(EVIDENCE_ACTION_LOG);
  if (stat === undefined) return { records: [], journal: "missing" };
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    return { records: [], journal: "corrupt", warning: "journal corrupt after record 0" };
  }
  const handle = await dir.openFile(
    EVIDENCE_ACTION_LOG,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1) {
      return { records: [], journal: "corrupt", warning: "journal corrupt after record 0" };
    }
    return parseRecoverableActionsJournal(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

async function reportIsMissing(dir: DirHandle): Promise<boolean> {
  const stat = await dir.lstatChild(EVIDENCE_REPORT);
  return stat === undefined || stat.isSymbolicLink() || !stat.isFile();
}

function isReadOnlyRecoveryInput(manifest: RunManifest, reportMissing: boolean): boolean {
  if (reportMissing) return false;
  return manifest.status === "completed" || manifest.status === "failed";
}

async function indexReadOnlyRun(
  dir: DirHandle,
  manifest: RunManifest,
): Promise<RecoverOutcome> {
  if (!safeId(manifest.sessionId)) return skipIdentity();
  const parsed = await recoveryJournal(dir);
  return {
    kind: "run",
    sessionId: manifest.sessionId,
    run: recoveredRun(manifest, parsed),
  };
}

async function writeRecoveredRun(dir: DirHandle, manifest: RunManifest): Promise<RecoveredEvidenceRun> {
  const parsed = await recoveryJournal(dir);
  if (manifest.status === "running") manifest.status = "orphaned";
  manifest.evidenceRecovery = parsed.journal;
  // Seal before publishing: if this finalizer dies and releases the lock,
  // stale adopters must not append before a crash retry rebuilds the report.
  await dir.writeFileAtomic("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  await writeEvidenceReportIn(dir, manifest, parsed.records);
  return recoveredRun(manifest, parsed);
}

async function finalizeLockedRun(root: DirHandle, dir: DirHandle): Promise<RecoverOutcome> {
  let manifest: RunManifest;
  try {
    // The manifest can turn invalid, symlinked or hard-linked between
    // inspection and lock acquisition; skip that run instead of aborting.
    manifest = await readEvidenceManifestIn(dir);
  } catch (error) {
    if (error instanceof RunStorageAccessError) {
      return { kind: "skip", reason: "invalid evidence manifest" };
    }
    throw error;
  }
  // A peer may have finalized this run while we waited for the lock; index it
  // like any already finalized run instead of rewriting its report.
  if (isReadOnlyRecoveryInput(manifest, await reportIsMissing(dir))) {
    return indexReadOnlyRun(dir, manifest);
  }
  if (!safeId(manifest.sessionId) || await recoverySessionMayBeWritingIn(root, manifest.sessionId)) {
    return skipIdentity();
  }
  return {
    kind: "run",
    sessionId: manifest.sessionId,
    run: await writeRecoveredRun(dir, manifest),
  };
}

async function recoverRun(
  root: DirHandle,
  dir: DirHandle,
): Promise<RecoverOutcome> {
  const inspected = await inspectEvidenceManifestIn(dir);
  if (inspected.kind === "foreign") return { kind: "ignore" };
  if (inspected.kind === "invalid") {
    return { kind: "skip", reason: "invalid evidence manifest" };
  }
  // A peer recovery renames manifest.json more than once under the journal
  // lock, so a reader can miss it repeatedly out here; take the lock and read
  // what that peer left instead of calling the run invalid.
  if (inspected.kind === "usable" && isReadOnlyRecoveryInput(inspected.manifest, await reportIsMissing(dir))) {
    return indexReadOnlyRun(dir, inspected.manifest);
  }
  return withJournalLock(dir, () => finalizeLockedRun(root, dir));
}

async function runDirectoryNames(root: DirHandle): Promise<string[]> {
  const names: string[] = [];
  for (const name of (await root.readEntryNames()).sort()) {
    if (!safeId(name)) continue;
    const stat = await root.lstatChild(name);
    if (stat?.isDirectory() !== true || stat.isSymbolicLink()) continue;
    names.push(name);
  }
  return names;
}

async function openRecoverableRun(
  root: DirHandle,
  name: string,
): Promise<DirHandle | { skipped: SkippedEvidenceRun }> {
  try {
    return await openRunDirIn(root, name);
  } catch (error) {
    if (isDisappearedRun(error)) {
      return { skipped: { runId: name, reason: "run disappeared" } };
    }
    throw error;
  }
}

async function recoverRoot(root: DirHandle): Promise<EvidenceRecoveryResult> {
  const result: EvidenceRecoveryResult = { sessions: [], skipped: [] };
  const sessions = new Map<string, RecoveredEvidenceRun[]>();
  for (const name of await runDirectoryNames(root)) {
    const opened = await openRecoverableRun(root, name);
    if ("skipped" in opened) {
      result.skipped.push(opened.skipped);
      continue;
    }
    const dir = opened;
    try {
      const outcome = await recoverRun(root, dir);
      if (outcome.kind === "ignore") continue;
      if (outcome.kind === "skip") {
        result.skipped.push({ runId: name, reason: outcome.reason });
        continue;
      }
      const runs = sessions.get(outcome.sessionId) ?? [];
      runs.push(outcome.run);
      sessions.set(outcome.sessionId, runs);
    } finally {
      await dir.close();
    }
  }
  for (const [sessionId, runs] of sessions) {
    const name = `session-${sessionId}.html`;
    await root.writeFileAtomic(name, renderEvidenceSessionIndex(sessionId, runs));
    result.sessions.push({ sessionId, index: path.join(root.dir, name), runs });
  }
  return result;
}

/**
 * Explicit, non-destructive recovery in the configured write root only.
 * Stop producers first: historical pointers identify creators, not all adopters.
 * No pointer changes, session teardown, migration, or retention runs here.
 */
export async function finalizeOrphanedEvidenceRuns(
  projectDir: string,
  env: EnvLike = process.env,
): Promise<EvidenceRecoveryResult> {
  return withRecoveryRunsRootDir(projectDir, env, async (root) => {
    if (root === undefined) return { sessions: [], skipped: [] };
    return recoverRoot(root);
  });
}
