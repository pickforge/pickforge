import path from "node:path";
import { spawn } from "node:child_process";
import {
  EVIDENCE_ACTION_LOG,
  EVIDENCE_REPORT,
  isOutcomeRecord,
  recordEvidenceOutcome,
  type EvidenceOutcomeInput,
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
                `${run.runId}  ${run.source}  ${run.status}  ${run.artifacts} artifact(s)  outcome: ${run.outcome ?? "unknown"}`,
            ),
    };
  });
}

async function findRun(
  projectDir: string,
  runId: string | undefined,
  catalog?: RunCatalog,
): Promise<{ catalog: RunCatalog; entry: RunCatalogEntry }> {
  catalog ??= await openRunCatalog(projectDir);
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
    const opened = await openRunCatalog(projectDir);
    const entries = await opened.list();
    const rustRuns = await listRustEvidenceRuns(opened, entries);
    const rust = rustRuns.find(run => run.runId === runId);
    const rustLines = rustRuns.map(run => `${run.runId}  rust  ${run.outcome}`);
    if (rust !== undefined) {
      const lines = renderRustEvidenceReport(rust);
      return {
        data: { ...rust, report: lines.join("\n"), ...(recovery === undefined ? {} : { recovery }) },
        lines: [...lines, ...(recovery === undefined ? [] : recoveryReportLines(recovery))],
      };
    }
    if (runId === undefined && rustRuns.length > 0 && entries.length === 0) {
      return { data: { rustRuns, ...(recovery === undefined ? {} : { recovery }) }, lines: rustLines };
    }
    return labReport(projectDir, runId, opened, { rustRuns, rustLines, recovery });
  });
}

interface LabReportContext {
  rustRuns: Awaited<ReturnType<typeof listRustEvidenceRuns>>;
  rustLines: string[];
  recovery: Awaited<ReturnType<typeof finalizeOrphanedEvidenceRuns>> | undefined;
}

function reportPathLine(reportPath: string | null, status: string): string[] {
  if (reportPath !== null) return [`Report: ${reportPath}`];
  return status === "running" ? ["Report: not finalized yet"] : [];
}

async function labReport(
  projectDir: string,
  runId: string | undefined,
  opened: RunCatalog,
  { rustRuns, rustLines, recovery }: LabReportContext,
) {
  const { catalog, entry } = await findRun(projectDir, runId, opened);
  const { manifest, dir } = entry;
  const records = await readCatalogActions(catalog, entry);
  const latest = records.filter(isOutcomeRecord).at(-1);
  const outcome = latest === undefined ? null : { status: latest.status, scenario: latest.scenario };
  const reportPath = await catalog.hasRootFile(entry, EVIDENCE_REPORT)
    ? path.join(dir, EVIDENCE_REPORT) : null;
  const listing = runId === undefined;
  return {
    data: {
      source: "lab", runId: manifest.runId, dir, manifest, reportPath, outcome, device: manifest.device ?? null,
      ...(listing ? { rustRuns } : {}), ...(recovery === undefined ? {} : { recovery }),
    },
    lines: [
      ...renderRunReport(manifest, dir, records),
      ...(listing ? rustLines : []),
      ...(recovery === undefined ? [] : recoveryReportLines(recovery)),
      ...reportPathLine(reportPath, manifest.status),
    ],
  };
}

/** Oversize repeated options are refused outright; the core never silently truncates them. */
function limitRepeated(flag: string, values: string[] | undefined, max: number): void {
  if (values !== undefined && values.length > max) {
    throw new Error(`At most ${max} --${flag} options are allowed (got ${values.length})`);
  }
}

export async function runArtifactsOutcome(
  runId: string,
  opts: BaseCliOptions & Omit<EvidenceOutcomeInput, "inspectedScreenshots"> & { inspected?: string[]; step?: string[]; limitation?: string[] },
): Promise<number> {
  return runReported(opts, async () => {
    limitRepeated("step", opts.step, 32);
    limitRepeated("limitation", opts.limitation, 32);
    limitRepeated("inspected", opts.inspected, 64);
    const outcome = await recordEvidenceOutcome(resolveProjectDir(opts), runId, {
      scenario: opts.scenario, status: opts.status, revision: opts.revision,
      steps: opts.step, limitations: opts.limitation, notes: opts.notes,
      inspectedScreenshots: opts.inspected ?? [],
    });
    return { data: { runId, outcome }, lines: [`Outcome: ${outcome.status} (${outcome.scenario})`] };
  });
}
