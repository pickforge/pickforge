import fs from "node:fs";
import path from "node:path";
import { RunStorageAccessError, type DirHandle } from "./dir-handle.js";
import type { EnvLike } from "./paths.js";
import { EVIDENCE_ACTION_LOG, type RunManifest } from "./run.js";
import { openRunDirIn, withRecoveryRunsRootDir } from "./run-root.js";
import {
  recoverySessionMayBeWritingIn,
  parseActionsJournal,
  readEvidenceManifestIn,
  withJournalLock,
  type EvidenceRecord,
} from "./evidence.js";
import { renderEvidenceSessionIndex, writeEvidenceReportIn } from "./evidence-render.js";

export interface RecoveredEvidenceRun {
  runId: string;
  status: RunManifest["status"];
  actions: number;
  journal: NonNullable<RunManifest["evidenceRecovery"]>;
}

export interface EvidenceRecoveryResult {
  sessions: { sessionId: string; index: string; runs: RecoveredEvidenceRun[] }[];
  skipped: string[];
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]*$/i.test(value) && !value.includes("..");
}

async function recoveryJournal(dir: DirHandle): Promise<{
  records: EvidenceRecord[];
  journal: RecoveredEvidenceRun["journal"];
}> {
  const stat = await dir.lstatChild(EVIDENCE_ACTION_LOG);
  if (stat === undefined) return { records: [], journal: "missing" };
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    return { records: [], journal: "corrupt" };
  }
  const handle = await dir.openFile(
    EVIDENCE_ACTION_LOG,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1) return { records: [], journal: "corrupt" };
    const raw = await handle.readFile("utf8");
    try {
      return {
        records: parseActionsJournal(raw, dir.dir),
        journal: raw !== "" && !raw.endsWith("\n") ? "torn-tail" : "complete",
      };
    } catch {
      return { records: [], journal: "corrupt" };
    }
  } finally {
    await handle.close();
  }
}

async function recoverRun(
  root: DirHandle,
  dir: DirHandle,
): Promise<{ sessionId: string; run: RecoveredEvidenceRun } | undefined> {
  return withJournalLock(dir, async () => {
    const manifest = await readEvidenceManifestIn(dir);
    if (!safeId(manifest.sessionId) || await recoverySessionMayBeWritingIn(root, manifest.sessionId)) return undefined;
    const { records, journal } = await recoveryJournal(dir);
    if (manifest.status === "running") manifest.status = "orphaned";
    manifest.evidenceRecovery = journal;
    // Seal before publishing: if this finalizer dies and releases the lock,
    // stale adopters must not append before a crash retry rebuilds the report.
    await dir.writeFileAtomic("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
    await writeEvidenceReportIn(dir, manifest, records);
    return {
      sessionId: manifest.sessionId,
      run: { runId: manifest.runId, status: manifest.status, actions: records.length, journal },
    };
  });
}

function unidentifiableManifest(error: unknown): boolean {
  if (error instanceof RunStorageAccessError || error instanceof SyntaxError) return true;
  return ["ENOENT", "ELOOP", "ENXIO", "ENODEV"].includes((error as NodeJS.ErrnoException).code ?? "");
}

async function evidenceDirectories(root: DirHandle): Promise<string[]> {
  const names: string[] = [];
  for (const name of (await root.readEntryNames()).sort()) {
    if (!safeId(name)) continue;
    const stat = await root.lstatChild(name);
    if (stat?.isDirectory() !== true || stat.isSymbolicLink()) continue;
    const dir = await openRunDirIn(root, name);
    try {
      // Foreign runs (including the Rust CLI's) and invalid manifests are not ours.
      await readEvidenceManifestIn(dir);
      names.push(name);
    } catch (error) {
      // Discovery never repairs an unidentifiable run, but I/O failures need retry.
      if (!unidentifiableManifest(error)) throw error;
    } finally {
      await dir.close();
    }
  }
  return names;
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
    const result: EvidenceRecoveryResult = { sessions: [], skipped: [] };
    if (root === undefined) return result;
    const sessions = new Map<string, RecoveredEvidenceRun[]>();
    for (const name of await evidenceDirectories(root)) {
      const dir = await openRunDirIn(root, name);
      try {
        const recovered = await recoverRun(root, dir);
        if (recovered === undefined) { result.skipped.push(name); continue; }
        const runs = sessions.get(recovered.sessionId) ?? [];
        runs.push(recovered.run);
        sessions.set(recovered.sessionId, runs);
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
  });
}
