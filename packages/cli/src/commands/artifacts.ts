import { spawn } from "node:child_process";
import {
  EVIDENCE_ACTION_LOG,
  listArtifactRuns,
  listRustEvidenceRuns,
  renderRustEvidenceReport,
  finalizeOrphanedEvidenceRuns,
  isEvidenceRun,
  openRunCatalog,
  parseActionsJournal,
  renderRunReport,
  resolveRunStorage,
  type EvidenceRecoveryResult,
  type RunCatalog,
  type RunCatalogEntry,
} from "@pickforge/lab-core";
import { findOnPath } from "@pickforge/lab-desktop-linux";
import {
  resolveProjectDir,
  runReported,
  type BaseCliOptions,
} from "./shared.js";

export async function runArtifactsList(opts: BaseCliOptions): Promise<number> {
  return runReported(opts, async () => {
    const projectDir = resolveProjectDir(opts);
    const catalog = await openRunCatalog(projectDir);
    const runs = await listArtifactRuns(catalog);
    return {
      data: { projectDir, runs },
      lines:
        runs.length === 0
          ? [
              `no runs found under ${(await resolveRunStorage(projectDir)).runsDir}`,
            ]
          : runs.map(
              (run) =>
                `${run.runId}  ${run.source}  ${run.status}  ${run.artifacts} artifact(s)`,
            ),
    };
  });
}

async function findRun(
  projectDir: string,
  runId: string | undefined,
): Promise<{ catalog: RunCatalog; entry: RunCatalogEntry }> {
  const catalog = await openRunCatalog(projectDir);
  const entry = await catalog.find(runId);
  if (entry === undefined) {
    if (runId === undefined) {
      const { runsDir } = await resolveRunStorage(projectDir);
      throw new Error(`No runs found under ${runsDir}`);
    }
    throw new Error(`Run not found: ${runId} (see: pickforge-lab artifacts list)`);
  }
  return { catalog, entry };
}

async function readCatalogActions(
  catalog: RunCatalog,
  entry: RunCatalogEntry,
): Promise<ReturnType<typeof parseActionsJournal>> {
  if (!isEvidenceRun(entry.manifest) || entry.manifest.evidenceRecovery === "corrupt") return [];
  const raw = await catalog.readRootTextIfPresent(entry, EVIDENCE_ACTION_LOG);
  return raw === undefined ? [] : parseActionsJournal(raw, entry.dir);
}

export async function runArtifactsOpen(
  runId: string,
  opts: BaseCliOptions,
): Promise<number> {
  return runReported(opts, async () => {
    const projectDir = resolveProjectDir(opts);
    const { entry } = await findRun(projectDir, runId);
    const { manifest, dir } = entry;
    let opened = false;
    const display = process.env.DISPLAY;
    if (opts.json !== true && display !== undefined && display !== "") {
      const xdgOpen = findOnPath("xdg-open");
      if (xdgOpen !== null) {
        const child = spawn(xdgOpen, [dir], {
          detached: true,
          stdio: "ignore",
        });
        child.on("error", () => {});
        child.unref();
        opened = true;
      }
    }
    return {
      data: { runId: manifest.runId, dir, opened },
      lines: [dir],
    };
  });
}

function recoveryReportLines(recovery: EvidenceRecoveryResult): string[] {
  return [
    ...recovery.sessions.map((session) => `Session index: ${session.index}`),
    ...recovery.skipped.map((item) => `Recovery skipped (${item.reason}): ${item.runId}`),
    ...recovery.sessions.flatMap((session) => session.runs)
      .filter((run) => run.warning !== undefined)
      .map((run) => `${run.runId}: ${run.warning}`),
  ];
}

export async function runArtifactsReport(
  runId: string | undefined,
  opts: BaseCliOptions & { finalizeOrphans?: boolean },
): Promise<number> {
  return runReported(opts, async () => {
    const projectDir = resolveProjectDir(opts);
    const recovery = opts.finalizeOrphans === true
      ? await finalizeOrphanedEvidenceRuns(projectDir)
      : undefined;
    const rustRuns = await listRustEvidenceRuns(await openRunCatalog(projectDir));
    const rust = rustRuns.find(run => run.runId === runId);
    const rustLines = rustRuns.map(run => `${run.runId}  rust  ${run.outcome}`);
    if (rust !== undefined) {
      const lines = renderRustEvidenceReport(rust);
      return {
        data: { ...rust, report: lines.join("\n"), ...(recovery === undefined ? {} : { recovery }) },
        lines: [...lines, ...(recovery === undefined ? [] : recoveryReportLines(recovery))],
      };
    }
    if (runId === undefined && rustRuns.length > 0 &&
        await (await openRunCatalog(projectDir)).find() === undefined) {
      return { data: { rustRuns, ...(recovery === undefined ? {} : { recovery }) }, lines: rustLines };
    }
    const { catalog, entry } = await findRun(projectDir, runId);
    const { manifest, dir } = entry;
    const records = await readCatalogActions(catalog, entry);
    return {
      data: { source: "lab", runId: manifest.runId, dir, manifest, ...(runId === undefined ? { rustRuns } : {}), ...(recovery === undefined ? {} : { recovery }) },
      lines: [
        ...renderRunReport(manifest, dir, records),
        ...(runId === undefined ? rustLines : []),
        ...(recovery === undefined ? [] : recoveryReportLines(recovery)),
      ],
    };
  });
}
