import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
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
  type EnvLike,
  type RunCatalog,
  type RunCatalogEntry,
} from "@pickforge/lab-core";
import { runTool, type ServerContext } from "../context.js";

export async function findRun(
  projectDir: string,
  runId: string | undefined,
  env: EnvLike = process.env,
): Promise<{ catalog: RunCatalog; entry: RunCatalogEntry }> {
  const catalog = await openRunCatalog(projectDir, env);
  const entry = await catalog.find(runId);
  if (entry === undefined) {
    if (runId === undefined) {
      const { runsDir } = await resolveRunStorage(projectDir, env);
      throw new Error(`No runs found under ${runsDir}`);
    }
    throw new Error(`Run not found: ${runId} (see the artifact_list tool)`);
  }
  return { catalog, entry };
}

async function readCatalogActions(
  catalog: RunCatalog,
  entry: RunCatalogEntry,
): Promise<ReturnType<typeof parseActionsJournal>> {
  if (!isEvidenceRun(entry.manifest) || entry.manifest.evidenceRecovery === "corrupt") return [];
  const raw = await catalog.readRootTextIfPresent(
    entry,
    EVIDENCE_ACTION_LOG,
  );
  return raw === undefined ? [] : parseActionsJournal(raw, entry.dir);
}

export function registerArtifactTools(
  server: McpServer,
  ctx: ServerContext,
): void {
  server.registerTool(
    "artifact_list",
    {
      title: "List runs",
      description:
        "List recorded runs (screenshots, logs, reports). Runs default to " +
        "the shared Pickforge home outside the project directory; see " +
        "pickforge-lab doctor or the storage config docs for the resolved path.",
      inputSchema: {},
    },
    () =>
      runTool(async () => {
        const catalog = await openRunCatalog(ctx.projectDir, ctx.env);
        const runs = await listArtifactRuns(catalog);
        return { data: { projectDir: ctx.projectDir, runs } };
      }),
  );

  server.registerTool(
    "artifact_report",
    {
      title: "Run report",
      description:
        "Render a report for one run (default: the most recent run), " +
        "including its artifact inventory and evidence action timeline.",
      inputSchema: {
        runId: z.string().min(1).optional().describe("Run id"),
        finalizeOrphans: z.boolean().optional().describe(
          "Recover orphaned evidence and session indexes in the configured storage root. Stop producers first; live owners are skipped.",
        ),
      },
    },
    (args) =>
      runTool(async () => {
        const recovery = args.finalizeOrphans === true
          ? await finalizeOrphanedEvidenceRuns(ctx.projectDir, ctx.env)
          : undefined;
        const rustRuns = await listRustEvidenceRuns(await openRunCatalog(ctx.projectDir, ctx.env));
        const rust = rustRuns.find(run => run.runId === args.runId);
        if (rust !== undefined) {
          return { data: { ...rust, report: renderRustEvidenceReport(rust).join("\n"),
            ...(recovery === undefined ? {} : { recovery }) } };
        }
        const rustLines = rustRuns.map(run => `${run.runId}  rust  ${run.outcome}`);
        if (args.runId === undefined && rustRuns.length > 0 &&
            await (await openRunCatalog(ctx.projectDir, ctx.env)).find() === undefined) {
          return { data: { rustRuns, report: rustLines.join("\n"),
            ...(recovery === undefined ? {} : { recovery }) } };
        }
        const { catalog, entry } = await findRun(
          ctx.projectDir,
          args.runId,
          ctx.env,
        );
        const { manifest, dir } = entry;
        const records = await readCatalogActions(catalog, entry);
        return {
          data: {
            source: "lab",
            ...(args.runId === undefined ? { rustRuns } : {}),
            runId: manifest.runId,
            dir,
            manifest,
            report: [...renderRunReport(manifest, dir, records),
              ...(args.runId === undefined ? rustLines : [])].join("\n"),
            ...(recovery === undefined ? {} : { recovery }),
          },
        };
      }),
  );
}
