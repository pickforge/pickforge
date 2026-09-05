import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  EVIDENCE_ACTION_LOG,
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
  if (!isEvidenceRun(entry.manifest)) return [];
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
        const entries = await catalog.list();
        const runs = entries.map(({ manifest }) => ({
          runId: manifest.runId,
          slug: manifest.slug,
          createdAt: manifest.createdAt,
          status: manifest.status,
          artifacts: manifest.artifacts.length,
        }));
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
      },
    },
    (args) =>
      runTool(async () => {
        const { catalog, entry } = await findRun(
          ctx.projectDir,
          args.runId,
          ctx.env,
        );
        const { manifest, dir } = entry;
        const records = await readCatalogActions(catalog, entry);
        return {
          data: {
            runId: manifest.runId,
            dir,
            manifest,
            report: renderRunReport(manifest, dir, records).join("\n"),
          },
        };
      }),
  );
}
