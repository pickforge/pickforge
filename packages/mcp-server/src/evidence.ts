import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  appendAction,
  ObservationTimeoutError,
  beginEvidenceRun,
  isEvidenceEnabled,
  isEvidenceRun,
  loadConfig,
  sanitizeActionTarget,
  sanitizeErrorText,
  sanitizeTypedValue,
  writeEvidenceReport,
  type EvidenceAction,
  type EvidenceCaptureLink,
  type EvidenceInputState,
  type RunHandle,
  type SanitizedTypedValue,
} from "@pickforge/lab-core";
import type { OwnedDisplayIdentity } from "@pickforge/lab-desktop-linux";
import type { ServerContext, ToolReport } from "./context.js";

/** Private record metadata. It is never copied into tool results. */
export interface EvidenceRecordMeta {
  inputState?: EvidenceInputState;
  /** Capture paths may be absolute; only confirmed artifacts are linked. */
  captures: EvidenceCaptureLink[];
  /** Focused window rect learned during the operation; only the sanitized target keeps it. */
  focus?: { x: number; y: number; width: number; height: number };
}

export interface EvidenceOperationContext {
  actionId: string;
  run?: RunHandle;
  record: EvidenceRecordMeta;
}

export interface McpEvidenceOptions<T> {
  sessionId?: string;
  tool: string;
  target?: Record<string, unknown>;
  typedValue?: { value: string; inputType?: string };
  artifacts?: (result: T, run: RunHandle) => readonly string[];
  refreshReportAfterRecord?: boolean;
  /** Records inputState, starting at "not-attempted". */
  input?: boolean;
  /** Evidence-only owned display check, run before and after the operation. */
  ownedDisplay?: () => Promise<OwnedDisplayIdentity | undefined>;
  /** Opt-in: report dropped or unconfirmed attachments without losing input results. */
  onRecordingFailure?: (result: T, reason: "capped" | "unconfirmed") => T;
}

export function evidenceStatus(error: unknown): EvidenceAction["status"] {
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

function runRelative(run: RunHandle, candidate: string): string | undefined {
  const absolute = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(run.dir, candidate);
  const relative = path.relative(run.dir, absolute);
  return relative === "" || relative.startsWith("..") || path.isAbsolute(relative)
    ? undefined
    : relative;
}

async function confinedArtifacts(
  run: RunHandle,
  candidates: readonly string[],
): Promise<string[]> {
  const realRun = await fs.promises.realpath(run.dir);
  const artifacts: string[] = [];
  for (const candidate of candidates) {
    const relative = runRelative(run, candidate);
    if (relative === undefined) continue;
    const absolute = path.join(run.dir, relative);
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

/** Links only captures whose run-relative path is a confirmed artifact. */
function confirmedCaptures(
  run: RunHandle,
  captures: readonly EvidenceCaptureLink[],
  artifacts: readonly string[],
): EvidenceCaptureLink[] {
  const size = (value: number) => Number.isSafeInteger(value) && value > 0;
  return captures.flatMap(({ path: file, phase, width, height }) => {
    const relative = runRelative(run, file);
    return relative !== undefined && artifacts.includes(relative) && size(width) && size(height)
      ? [{ path: relative, phase, width, height }]
      : [];
  });
}

interface EvidenceAttempt {
  actionId: string;
  startedAt: Date;
  run?: RunHandle;
  sessionId?: string;
  tool: string;
  target?: Record<string, unknown>;
  typedValue?: SanitizedTypedValue;
  record: EvidenceRecordMeta;
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
    typedValue,
    record: options.input === true ? { inputState: "not-attempted", captures: [] } : { captures: [] },
  };
}

async function ownedDisplay<T>(
  attempt: EvidenceAttempt,
  options: McpEvidenceOptions<T>,
): Promise<OwnedDisplayIdentity | undefined> {
  if (attempt.run === undefined || options.ownedDisplay === undefined) return undefined;
  try {
    return await options.ownedDisplay();
  } catch {
    return undefined;
  }
}

/**
 * Adds the focus learned during the operation, and marks the target as
 * xvfb-root only when both checks saw the same server.
 */
async function settleTarget<T>(
  attempt: EvidenceAttempt,
  options: McpEvidenceOptions<T>,
  before: OwnedDisplayIdentity | undefined,
): Promise<void> {
  const { focus } = attempt.record;
  const after = before === undefined ? undefined : await ownedDisplay(attempt, options);
  const verified = after !== undefined && after.display === before?.display && after.pid === before.pid && after.startTicks === before.startTicks;
  if (!verified && focus === undefined) return;
  const target = { ...options.target, ...(focus === undefined ? {} : { focus }) };
  attempt.target = sanitizedTarget(verified ? { ...target, coordinateSpace: "xvfb-root" } : target, attempt.typedValue);
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
  if (attempt.record.inputState !== undefined) action.inputState = attempt.record.inputState;
  return action;
}

async function successAction<T extends ToolReport>(
  attempt: EvidenceAttempt,
  options: McpEvidenceOptions<T>,
  result: T,
  run: RunHandle,
): Promise<EvidenceAction> {
  const errors = result.errors ?? [];
  const action = baseAction(
    attempt,
    result.evidenceStatus ?? (errors.length === 0 ? "ok" : "error"),
  );
  const artifacts =
    options.artifacts === undefined
      ? []
      : await confinedArtifacts(run, options.artifacts(result, run));
  if (artifacts.length > 0) action.artifacts = artifacts;
  const captures = confirmedCaptures(run, attempt.record.captures, artifacts);
  if (captures.length > 0) action.captures = captures;
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
): Promise<T> {
  const run = attempt.run;
  if (run === undefined) return result;
  try {
    const action = await successAction(attempt, options, result, run);
    if (options.onRecordingFailure !== undefined &&
        (action.artifacts?.length ?? 0) !== (options.artifacts?.(result, run).length ?? 0)) {
      throw new Error("Requested evidence attachments could not be verified");
    }
    const appended = await appendAction(run, action);
    if (appended.outcome === "capped" && options.onRecordingFailure !== undefined) {
      const failed = options.onRecordingFailure(result, "capped");
      // Capped means the caller record was dropped. The ordinary bounded
      // metadata path can retain the input's partial effect, without artifacts.
      await recordFailure(attempt, new Error(failed.errors?.join("; ")));
      return failed;
    }
    // Both appended and truncated mean the caller record was written.
  } catch (error) {
    reportEvidenceFailure(options.tool, error);
    // A thrown append can have an uncertain write result. Do not retry it or
    // create a duplicate record, and do not discard the operation's result.
    return options.onRecordingFailure?.(result, "unconfirmed") ?? result;
  }
  if (options.refreshReportAfterRecord === true) {
    await recordBestEffort(options.tool, () => refreshFinalizedReport(run));
  }
  return result;
}

async function recordFailure(
  attempt: EvidenceAttempt,
  error: unknown,
): Promise<void> {
  const run = attempt.run;
  if (run === undefined) return;
  await recordBestEffort(attempt.tool, async () => {
    const status = attempt.tool === "desktop_wait"
      ? (error instanceof ObservationTimeoutError ? "timeout" : "error")
      : evidenceStatus(error);
    const action = baseAction(attempt, status);
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
  const before = await ownedDisplay(attempt, options);
  let result: T;
  try {
    result = await operation({
      actionId: attempt.actionId,
      run: attempt.run,
      record: attempt.record,
    });
  } catch (error) {
    await settleTarget(attempt, options, before);
    await recordFailure(attempt, error);
    throw error;
  }
  await settleTarget(attempt, options, before);
  return await recordSuccess(attempt, options, result);
}
