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
  const manifest = await run.readManifest();
  if (
    !isEvidenceRun(manifest) ||
    manifest.sessionId !== run.manifest.sessionId ||
    manifest.status === "running"
  ) {
    return;
  }
  await writeEvidenceReport(run, manifest);
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

interface EvidenceAttempt {
  actionId: string;
  startedAt: Date;
  run?: RunHandle;
  sessionId?: string;
  tool: string;
  target?: Record<string, unknown>;
}

async function startEvidenceAttempt<T>(
  ctx: ServerContext,
  options: McpEvidenceOptions<T>,
): Promise<EvidenceAttempt> {
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
  return {
    actionId: crypto.randomUUID(),
    startedAt: new Date(),
    run,
    sessionId: options.sessionId,
    tool: options.tool,
    target: sanitizedTarget(options.target, typedValue),
  };
}

function baseAction(
  attempt: EvidenceAttempt,
  status: EvidenceAction["status"],
): EvidenceAction {
  const action: EvidenceAction = {
    actionId: attempt.actionId,
    source: "mcp",
    tool: attempt.tool,
    startedAt: attempt.startedAt.toISOString(),
    durationMs: Date.now() - attempt.startedAt.getTime(),
    status,
  };
  if (attempt.sessionId !== undefined) action.sessionId = attempt.sessionId;
  if (attempt.target !== undefined) action.target = attempt.target;
  return action;
}

async function successAction<T extends ToolReport>(
  attempt: EvidenceAttempt,
  options: McpEvidenceOptions<T>,
  result: T,
  run: RunHandle,
): Promise<EvidenceAction> {
  const errors = result.errors ?? [];
  const action = baseAction(attempt, errors.length === 0 ? "ok" : "error");
  const artifacts =
    options.artifacts === undefined
      ? []
      : await confinedArtifacts(run, options.artifacts(result, run));
  if (artifacts.length > 0) action.artifacts = artifacts;
  if (errors.length > 0) {
    action.error = sanitizeErrorText(errors.join("; "));
  }
  return action;
}

async function recordBestEffort(
  tool: string,
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    reportEvidenceFailure(tool, error);
  }
}

async function recordSuccess<T extends ToolReport>(
  attempt: EvidenceAttempt,
  options: McpEvidenceOptions<T>,
  result: T,
): Promise<void> {
  const run = attempt.run;
  if (run === undefined) return;
  await recordBestEffort(options.tool, async () => {
    await appendAction(run, await successAction(attempt, options, result, run));
    if (options.refreshReportAfterRecord === true) {
      await refreshFinalizedReport(run);
    }
  });
}

async function recordFailure(
  attempt: EvidenceAttempt,
  error: unknown,
): Promise<void> {
  const run = attempt.run;
  if (run === undefined) return;
  await recordBestEffort(attempt.tool, async () => {
    const action = baseAction(attempt, evidenceStatus(error));
    action.error = sanitizeErrorText(
      error instanceof Error ? error.message : String(error),
    );
    await appendAction(run, action);
  });
}

export async function withMcpEvidence<T extends ToolReport>(
  ctx: ServerContext,
  options: McpEvidenceOptions<T>,
  operation: (evidence: EvidenceOperationContext) => Promise<T>,
): Promise<T> {
  const attempt = await startEvidenceAttempt(ctx, options);
  try {
    const result = await operation({
      actionId: attempt.actionId,
      run: attempt.run,
    });
    await recordSuccess(attempt, options, result);
    return result;
  } catch (error) {
    await recordFailure(attempt, error);
    throw error;
  }
}
