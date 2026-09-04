import path from "node:path";
import {
  resolveRunnableSession,
  resolveScreenshotTarget as resolveTarget,
  type EnvLike,
  type RunnableSessionType,
  type ScreenshotTarget,
  type SessionRecord,
} from "@pickforge/lab-core";

export {
  captureToTarget,
  requireDisplay,
  type RunnableSessionType,
  type ScreenshotTarget,
} from "@pickforge/lab-core";

export interface BaseCliOptions {
  json?: boolean;
  projectDir?: string;
}

export interface CommandResult {
  data?: Record<string, unknown>;
  lines?: string[];
  errors?: string[];
}

export function resolveProjectDir(opts: { projectDir?: string }): string {
  return path.resolve(opts.projectDir ?? process.cwd());
}

export function parseIntArg(value: string, label: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(
      `Invalid ${label} "${value}": expected a non-negative integer`,
    );
  }
  return Number(value);
}

export function parseSignedIntArg(value: string, label: string): number {
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`Invalid ${label} "${value}": expected an integer`);
  }
  return Number(value);
}

export async function runReported(
  opts: { json?: boolean },
  fn: () => Promise<CommandResult>,
): Promise<number> {
  let result: CommandResult;
  try {
    result = await fn();
  } catch (error) {
    result = {
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
  const errors = result.errors ?? [];
  const report: Record<string, unknown> = { ok: errors.length === 0 };
  for (const [key, value] of Object.entries(result.data ?? {})) {
    if (key !== "ok" && key !== "errors") {
      report[key] = value;
    }
  }
  report.errors = errors;
  if (opts.json === true) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const line of result.lines ?? []) {
      console.log(line);
    }
    for (const error of errors) {
      console.error(`error: ${error}`);
    }
  }
  return errors.length === 0 ? 0 : 1;
}

export async function resolveSessionRecord(
  type: RunnableSessionType,
  opts: { session?: string; projectDir?: string },
  env: EnvLike = process.env,
): Promise<SessionRecord> {
  return resolveRunnableSession(type, opts.session, {
    env,
    projectDir: resolveProjectDir(opts),
    consumerLabel: "command",
    createHint: `create one with: pickforge-lab session create --type ${type}`,
    selectHint: "pick one with --session <id>",
  });
}

export interface ScreenshotTargetOptions extends BaseCliOptions {
  out?: string;
  run?: string;
}

export async function resolveScreenshotTarget(
  opts: ScreenshotTargetOptions,
  defaultSlug: string,
  sessionId?: string,
): Promise<ScreenshotTarget> {
  return resolveTarget({
    projectDir: resolveProjectDir(opts),
    out: opts.out,
    runSlug: opts.run,
    defaultSlug,
    sessionId,
    conflictError: "use either --out or --run, not both",
  });
}
