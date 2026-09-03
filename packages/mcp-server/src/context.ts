import fs from "node:fs";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
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
    opts.projectDir ?? env.PICKLAB_PROJECT_DIR ?? process.cwd(),
  );
  return { projectDir, env };
}

export interface ToolReport {
  data?: Record<string, unknown>;
  errors?: string[];
  extraContent?: CallToolResult["content"];
}

export function reportResult(report: ToolReport): CallToolResult {
  const errors = report.errors ?? [];
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
