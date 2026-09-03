import { spawn } from "node:child_process";
import {
  EVIDENCE_ACTION_LOG,
  isEvidenceRun,
  openRunCatalog,
  parseActionsJournal,
  renderRunReport,
  resolveRunStorage,
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
  if (!isEvidenceRun(entry.manifest)) return [];
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

export async function runArtifactsReport(
  runId: string | undefined,
  opts: BaseCliOptions,
): Promise<number> {
  return runReported(opts, async () => {
    const projectDir = resolveProjectDir(opts);
    const { catalog, entry } = await findRun(projectDir, runId);
    const { manifest, dir } = entry;
    const records = await readCatalogActions(catalog, entry);
    return {
      data: { runId: manifest.runId, dir, manifest },
      lines: renderRunReport(manifest, dir, records),
    };
  });
}
