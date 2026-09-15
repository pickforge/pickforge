import fs from "node:fs";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/server";
import {
  resolveRunStorage,
  sanitizeErrorText,
  readProjectFileBounded,
  observationBudget,
  readOwnedRunFile,
  readPickforgeEnv,
  resolveConfinedPath,
  resolveRunnableSession,
  resolveScreenshotTarget as resolveTarget,
  type EnvLike,
  type RunnableSessionType,
  type ScreenshotTarget,
  type SessionRecord,
} from "@pickforge/lab-core";

export {
  captureRunArtifact,
  captureToTarget,
  requireDisplay,
  type RunnableSessionType,
  type ScreenshotTarget,
} from "@pickforge/lab-core";

const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;

export interface CreateMcpServerOptions {
  projectDir?: string;
  env?: EnvLike;
}

export interface ServerContext {
  projectDir: string;
  env: EnvLike;
}

export function resolveContext(
  opts: CreateMcpServerOptions = {},
): ServerContext {
  const env = opts.env ?? process.env;
  const projectDir = path.resolve(
    opts.projectDir ?? readPickforgeEnv(env, "PROJECT_DIR") ?? process.cwd(),
  );
  return { projectDir, env };
}

export interface ToolReport {
  data?: Record<string, unknown>;
  errors?: string[];
  extraContent?: CallToolResult["content"];
  evidenceStatus?: "ok" | "error" | "timeout" | "cancelled";
}

export function reportResult(report: ToolReport): CallToolResult {
  const errors = (report.errors ?? []).map((error) => sanitizeErrorText(error));
  const body: Record<string, unknown> = { ok: errors.length === 0 };
  for (const [key, value] of Object.entries(report.data ?? {})) {
    if (key !== "ok" && key !== "errors") {
      body[key] = value;
    }
  }
  body.errors = errors;
  const content: CallToolResult["content"] = [
    { type: "text", text: JSON.stringify(body, null, 2) },
    ...(report.extraContent ?? []),
  ];
  return errors.length === 0 ? { content } : { content, isError: true };
}

export async function runTool(
  fn: () => Promise<ToolReport>,
): Promise<CallToolResult> {
  try {
    return reportResult(await fn());
  } catch (error) {
    return reportResult({
      errors: [error instanceof Error ? error.message : String(error)],
    });
  }
}

export interface InlineImage {
  content: CallToolResult["content"];
  meta: Record<string, unknown>;
}

export async function imageContent(filePath: string): Promise<InlineImage> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return {
      content: [],
      meta: {
        inlineImage: false,
        inlineImageReason: `image file not readable: ${filePath}`,
      },
    };
  }
  if (stat.size > MAX_INLINE_IMAGE_BYTES) {
    return {
      content: [],
      meta: {
        inlineImage: false,
        inlineImageReason:
          `image is ${stat.size} bytes, over the ` +
          `${MAX_INLINE_IMAGE_BYTES} byte inline limit; read it from ${filePath}`,
      },
    };
  }
  const data = await fs.promises.readFile(filePath);
  return {
    content: [
      { type: "image", data: data.toString("base64"), mimeType: "image/png" },
    ],
    meta: { inlineImage: true },
  };
}

export async function resolveSessionRecord(
  ctx: ServerContext,
  type: RunnableSessionType,
  id: string | undefined,
): Promise<SessionRecord> {
  return resolveRunnableSession(type, id, {
    env: ctx.env,
    projectDir: ctx.projectDir,
    consumerLabel: "tool",
    createHint: `create one with the session_create tool (type "${type}")`,
    selectHint: 'pick one with the "session" argument',
  });
}

export async function resolveProjectPath(
  ctx: ServerContext,
  requestedPath: string,
): Promise<string> {
  return resolveConfinedPath({
    baseDir: ctx.projectDir,
    requestedPath,
    errorMessage:
      `Refusing to use a working directory outside the project directory: ${requestedPath}`,
  });
}

export interface ScreenshotTargetArgs {
  out?: string;
  runSlug?: string;
}

export async function resolveScreenshotTarget(
  ctx: ServerContext,
  args: ScreenshotTargetArgs,
  defaultSlug: string,
  sessionId?: string,
): Promise<ScreenshotTarget> {
  return resolveTarget({
    projectDir: ctx.projectDir,
    out: args.out,
    outBaseDir: ctx.projectDir,
    runSlug: args.runSlug,
    defaultSlug,
    sessionId,
    conflictError: 'Use either "out" or "runSlug", not both',
    env: ctx.env,
  });
}

function screenshotNameInRun(runDir: string, requestedPath: string): string | undefined {
  const relative = path.relative(path.resolve(runDir, "screenshots"), path.resolve(requestedPath));
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative.includes(path.sep)) {
    return undefined;
  }
  if (!/^[A-Za-z0-9._-]+\.png$/.test(relative)) return undefined;
  return relative;
}

export async function resolveWaitBaseline(
  ctx: ServerContext,
  requestedPath: string,
  deadline: number = Date.now() + 10_000,
): Promise<Buffer> {
  observationBudget(deadline);
  const refusal =
    `Refusing to read wait baseline outside the project directory or a verified run screenshot: ${requestedPath}`;
  const resolved = path.resolve(ctx.projectDir, requestedPath);
  const relative = path.relative(path.resolve(ctx.projectDir), resolved);
  if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    return readProjectFileBounded(ctx.projectDir, resolved, deadline);
  }
  const storage = await resolveRunStorage(ctx.projectDir, ctx.env);
  observationBudget(deadline);
  const runId = path.relative(storage.runsDir, resolved).split(path.sep)[0]!;
  const name = screenshotNameInRun(path.join(storage.runsDir, runId), resolved);
  if (runId === ".." || name === undefined) throw new Error(refusal);
  return readOwnedRunFile(ctx.projectDir, runId, "screenshots", name, ctx.env, deadline);
}
