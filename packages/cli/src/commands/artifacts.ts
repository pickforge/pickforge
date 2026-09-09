import { spawn } from "node:child_process";
import {
  EVIDENCE_ACTION_LOG,
  recordEvidenceOutcome,
  type EvidenceOutcomeInput,
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
    const entries = await catalog.list();
    const runs = entries.map(({ manifest }) => ({
      runId: manifest.runId,
      slug: manifest.slug,
      createdAt: manifest.createdAt,
      status: manifest.status,
      artifacts: manifest.artifacts.length,
    }));
    return {
      data: { projectDir, runs },
      lines:
        runs.length === 0
          ? [
              `no runs found under ${(await resolveRunStorage(projectDir)).runsDir}`,
            ]
          : runs.map(
              (run) =>
                `${run.runId}  ${run.status}  ${run.artifacts} artifact(s)`,
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
    const { catalog, entry } = await findRun(projectDir, runId);
    const { manifest, dir } = entry;
    const records = await readCatalogActions(catalog, entry);
    return {
      data: { runId: manifest.runId, dir, manifest, ...(recovery === undefined ? {} : { recovery }) },
      lines: [
        ...renderRunReport(manifest, dir, records),
        ...(recovery === undefined ? [] : recoveryReportLines(recovery)),
      ],
    };
  });
}

export async function runArtifactsOutcome(
  runId: string,
  opts: BaseCliOptions & Omit<EvidenceOutcomeInput, "inspectedScreenshots"> & { inspected?: string[]; step?: string[]; limitation?: string[] },
): Promise<number> {
  return runReported(opts, async () => {
    const outcome = await recordEvidenceOutcome(resolveProjectDir(opts), runId, {
      scenario: opts.scenario, status: opts.status, revision: opts.revision,
      steps: opts.step, limitations: opts.limitation, notes: opts.notes,
      inspectedScreenshots: opts.inspected ?? [],
    });
    return { data: { runId, outcome }, lines: [`Outcome: ${outcome.status} (${outcome.scenario})`] };
  });
}
