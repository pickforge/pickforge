import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  appendAction,
  beginEvidenceRun,
  isEvidenceEnabled,
  isEvidenceRun,
  loadConfig,
  sanitizeActionTarget,
  sanitizeErrorText,
  sanitizeTypedValue,
  writeEvidenceReport,
  type EvidenceAction,
  type RunHandle,
  type RunManifest,
  type SanitizedTypedValue,
} from "@pickforge/lab-core";
import type { ServerContext, ToolReport } from "./context.js";

export interface EvidenceOperationContext {
  actionId: string;
  run?: RunHandle;
}

export interface McpEvidenceOptions<T> {
  sessionId?: string;
  tool: string;
  target?: Record<string, unknown>;
  typedValue?: { value: string; inputType?: string };
  artifacts?: (result: T, run: RunHandle) => readonly string[];
  refreshReportAfterRecord?: boolean;
}

function evidenceStatus(error: unknown): EvidenceAction["status"] {
  const name = error instanceof Error ? error.name.toLowerCase() : "";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (name.includes("abort") || message.includes("cancel")) return "cancelled";
  if (name.includes("timeout") || message.includes("timed out")) return "timeout";
  return "error";
}

function reportEvidenceFailure(tool: string, error: unknown): void {
  const detail = sanitizeErrorText(
    error instanceof Error ? error.message : String(error),
  );
  process.stderr.write(`[pickforge-lab evidence] ${tool}: ${detail}\n`);
}

async function evidenceRun(
  ctx: ServerContext,
  sessionId: string,
): Promise<RunHandle | undefined> {
  const config = await loadConfig(ctx.projectDir, ctx.env);
  if (!isEvidenceEnabled(config)) return undefined;
  return (
    await beginEvidenceRun(
      ctx.projectDir,
      sessionId,
      { slug: "computer-use" },
      ctx.env,
    )
  ).run;
}

async function refreshFinalizedReport(run: RunHandle): Promise<void> {
  const parsed: unknown = JSON.parse(
    await fs.promises.readFile(path.join(run.dir, "manifest.json"), "utf8"),
  );
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Invalid evidence manifest for run ${run.runId}`);
  }
  const manifest = parsed as RunManifest;
  if (
    !isEvidenceRun(manifest) ||
    manifest.runId !== run.runId ||
    manifest.sessionId !== run.manifest.sessionId ||
    manifest.status === "running"
  ) {
    return;
  }
  await writeEvidenceReport(run.dir, manifest);
}

async function confinedArtifacts(
  run: RunHandle,
  candidates: readonly string[],
): Promise<string[]> {
  const realRun = await fs.promises.realpath(run.dir);
  const artifacts: string[] = [];
  for (const candidate of candidates) {
    const absolute = path.isAbsolute(candidate)
      ? path.resolve(candidate)
      : path.resolve(run.dir, candidate);
    const relative = path.relative(run.dir, absolute);
    if (
      relative === "" ||
      relative.startsWith("..") ||
      path.isAbsolute(relative)
    ) {
      continue;
    }
    try {
      const stat = await fs.promises.lstat(absolute);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      const realArtifact = await fs.promises.realpath(absolute);
      if (realArtifact !== path.join(realRun, relative)) continue;
      artifacts.push(relative);
    } catch {
      continue;
    }
  }
  return artifacts;
}

function sanitizedTarget(
  target: Record<string, unknown> | undefined,
  typedValue: SanitizedTypedValue | undefined,
): Record<string, unknown> | undefined {
  const sanitized: Record<string, unknown> = {
    ...sanitizeActionTarget(target),
  };
  if (typedValue !== undefined) Object.assign(sanitized, typedValue);
  return Object.keys(sanitized).length === 0 ? undefined : sanitized;
}

// eslint-disable-next-line complexity -- Legacy gate debt: pickforge/pickforge#60
export async function withMcpEvidence<T extends ToolReport>(
  ctx: ServerContext,
  options: McpEvidenceOptions<T>,
  operation: (evidence: EvidenceOperationContext) => Promise<T>,
): Promise<T> {
  const actionId = crypto.randomUUID();
  const startedAt = new Date();
  let run: RunHandle | undefined;
  if (options.sessionId !== undefined) {
    try {
      run = await evidenceRun(ctx, options.sessionId);
    } catch (error) {
      reportEvidenceFailure(options.tool, error);
    }
  }

  const typedValue =
    options.typedValue === undefined
      ? undefined
      : sanitizeTypedValue(
          options.typedValue.value,
          options.typedValue.inputType,
        );
  const target = sanitizedTarget(options.target, typedValue);

  try {
    const result = await operation({ actionId, run });
    if (run !== undefined) {
      try {
        const artifacts =
          options.artifacts === undefined
            ? []
            : await confinedArtifacts(run, options.artifacts(result, run));
        const action: EvidenceAction = {
          actionId,
          source: "mcp",
          tool: options.tool,
          startedAt: startedAt.toISOString(),
          durationMs: Date.now() - startedAt.getTime(),
          status: (result.errors?.length ?? 0) === 0 ? "ok" : "error",
        };
        if (options.sessionId !== undefined) {
          action.sessionId = options.sessionId;
        }
        if (target !== undefined) action.target = target;
        if (artifacts.length > 0) action.artifacts = artifacts;
        if ((result.errors?.length ?? 0) > 0) {
          action.error = sanitizeErrorText(result.errors!.join("; "));
        }
        await appendAction(run, action);
        if (options.refreshReportAfterRecord === true) {
          await refreshFinalizedReport(run);
        }
      } catch (error) {
        reportEvidenceFailure(options.tool, error);
      }
    }
    return result;
  } catch (error) {
    if (run !== undefined) {
      try {
        const action: EvidenceAction = {
          actionId,
          source: "mcp",
          tool: options.tool,
          startedAt: startedAt.toISOString(),
          durationMs: Date.now() - startedAt.getTime(),
          status: evidenceStatus(error),
          error: sanitizeErrorText(
            error instanceof Error ? error.message : String(error),
          ),
        };
        if (options.sessionId !== undefined) {
          action.sessionId = options.sessionId;
        }
        if (target !== undefined) action.target = target;
        await appendAction(run, action);
      } catch (appendError) {
        reportEvidenceFailure(options.tool, appendError);
      }
    }
    throw error;
  }
}
