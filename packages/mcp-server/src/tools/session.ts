import type {
  McpServer,
  ServerContext as SdkServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  createAndroidSession,
  destroyAndroidSession,
  getAndroidSessionStatus,
  teardownAndroidSession,
} from "@pickforge/lab-android";
import {
  createBrowserSession,
  destroyBrowserSession,
  getBrowserSessionStatus,
  teardownBrowserSession,
} from "@pickforge/lab-browser";
import {
  createLocalSessions,
  destroyLocalSessions,
  getSession,
  listSessions,
  loadConfig,
  localSessionStatusEntry,
  reapDeadRunningSessions,
  type LocalSessionCreateRuntime,
  type LocalSessionDestroyRuntime,
  type LocalSessionLifecycle,
  type LocalSessionStatusEntry,
  type LocalSessionStatusRuntime,
  type LocalSessionSummary,
  type LocalSessionTeardownRuntime,
  type SessionRecord,
} from "@pickforge/lab-core";
import {
  createDesktopSession,
  destroyDesktopSession,
  getDesktopSessionStatus,
  teardownDesktopSession,
} from "@pickforge/lab-desktop-linux";
import { runTool, type ServerContext } from "../context.js";
import { withMcpEvidence } from "../evidence.js";

export interface SessionLifecycle extends LocalSessionLifecycle {
  onProgress?: (message: string) => void;
}

export function progressReporter(
  context: SdkServerContext,
): ((message: string) => void) | undefined {
  const progressToken = context.mcpReq._meta?.progressToken;
  if (progressToken === undefined) {
    return undefined;
  }
  let progress = 0;
  return (message: string) => {
    progress += 1;
    void context.mcpReq
      .notify({
        method: "notifications/progress",
        params: { progressToken, progress, message },
      })
      .catch(() => {});
  };
}

function createRuntime(
  ctx: ServerContext,
  args: {
    width?: number;
    height?: number;
    vnc?: boolean;
    vncControl?: boolean;
    avdName?: string;
    coldBoot?: boolean;
    readOnly?: boolean;
  },
  lifecycle: SessionLifecycle,
): LocalSessionCreateRuntime {
  return {
    desktop: {
      create: () =>
        createDesktopSession({
          projectDir: ctx.projectDir,
          registryEnv: ctx.env,
          env: ctx.env,
          width: args.width,
          height: args.height,
          vnc: args.vnc,
          vncControl: args.vncControl,
        }),
      destroy: (id) => destroyDesktopSession(id, ctx.env),
    },
    browser: {
      create: () =>
        createBrowserSession({
          projectDir: ctx.projectDir,
          registryEnv: ctx.env,
          env: ctx.env,
          width: args.width,
          height: args.height,
          signal: lifecycle.signal,
        }),
    },
    android: {
      create: async () => {
        const config = await loadConfig(ctx.projectDir, ctx.env);
        const avdName = args.avdName ?? config.android?.avdName;
        return createAndroidSession({
          projectDir: ctx.projectDir,
          registryEnv: ctx.env,
          env: ctx.env,
          onProgress: lifecycle.onProgress,
          signal: lifecycle.signal,
          ...(avdName === undefined ? {} : { avdName }),
          ...(args.coldBoot === true ? { coldBoot: true } : {}),
          ...(args.readOnly === true ? { readOnly: true } : {}),
        });
      },
    },
  };
}

function statusRuntime(ctx: ServerContext): LocalSessionStatusRuntime {
  return {
    desktop: { status: (id) => getDesktopSessionStatus(id, ctx.env) },
    browser: { status: (id) => getBrowserSessionStatus(id, ctx.env) },
    android: {
      status: (id) => getAndroidSessionStatus(id, ctx.env, { env: ctx.env }),
    },
  };
}

function destroyRuntime(ctx: ServerContext): LocalSessionDestroyRuntime {
  return {
    desktop: { destroy: (id) => destroyDesktopSession(id, ctx.env) },
    browser: { destroy: (id) => destroyBrowserSession(id, ctx.env) },
    android: {
      destroy: (id) => destroyAndroidSession(id, ctx.env, { env: ctx.env }),
    },
  };
}

function reaperRuntime(ctx: ServerContext): LocalSessionTeardownRuntime {
  return {
    desktop: {
      teardown: (id, finalize) =>
        teardownDesktopSession(id, ctx.env, finalize),
    },
    browser: {
      teardown: (id, finalize) =>
        teardownBrowserSession(id, ctx.env, finalize),
    },
    android: {
      teardown: (id, finalize) =>
        teardownAndroidSession(id, ctx.env, { env: ctx.env }, finalize),
    },
  };
}

export async function createSessions(
  ctx: ServerContext,
  args: {
    type?: "desktop" | "android" | "desktop+android" | "browser";
    width?: number;
    height?: number;
    vnc?: boolean;
    vncControl?: boolean;
    avdName?: string;
    coldBoot?: boolean;
    readOnly?: boolean;
  },
  lifecycle: SessionLifecycle = {},
): Promise<LocalSessionSummary[]> {
  await reapDeadRunningSessions(ctx.env, reaperRuntime(ctx));
  return createLocalSessions(
    args.type ?? "desktop",
    createRuntime(ctx, args, lifecycle),
    lifecycle,
  );
}

export async function recordCreatedSessionsEvidence(
  ctx: ServerContext,
  sessions: readonly LocalSessionSummary[],
  tool: "session_create" | "android_start",
): Promise<void> {
  for (const session of sessions) {
    await withMcpEvidence(
      ctx,
      {
        sessionId: session.id,
        tool,
        target: { name: session.type },
      },
      async () => ({ data: {} }),
    );
  }
}

export async function sessionStatusEntry(
  ctx: ServerContext,
  record: SessionRecord,
): Promise<LocalSessionStatusEntry> {
  const entry = await localSessionStatusEntry(record, statusRuntime(ctx));
  if (entry.viewer !== undefined) {
    entry.viewer.hostGuiLaunchSupported = false;
  }
  return entry;
}

function registerSessionCreateTool(
  server: McpServer,
  ctx: ServerContext,
): void {
  server.registerTool(
    "session_create",
    {
      title: "Create lab session",
      description:
        "Create an isolated lab session: a virtual desktop display (Xvfb), " +
        "headed Chrome/Chromium browser, and/or an Android emulator. Defaults to type \"desktop\".",
      inputSchema: {
        type: z
          .enum(["desktop", "android", "desktop+android", "browser"])
          .optional()
          .describe('Session type (default "desktop")'),
        width: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Desktop display width in pixels"),
        height: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Desktop display height in pixels"),
        vnc: z
          .boolean()
          .optional()
          .describe("Expose the desktop display over read-only VNC"),
        vncControl: z
          .boolean()
          .optional()
          .describe(
            "Expose writable VNC for explicit manual secret entry; input is not coordinated with the agent",
          ),
        avdName: z.string().min(1).optional().describe("Android AVD name"),
        coldBoot: z
          .boolean()
          .optional()
          .describe("Skip the AVD's saved state (emulator -no-snapshot-load)"),
        readOnly: z
          .boolean()
          .optional()
          .describe(
            "Share the AVD with another running emulator (emulator -read-only)",
          ),
      },
    },
    (args, extra) =>
      runTool(async () => {
        const sessions = await createSessions(ctx, args, {
          onProgress: progressReporter(extra),
          signal: extra.mcpReq.signal,
        });
        await recordCreatedSessionsEvidence(ctx, sessions, "session_create");
        return { data: { sessions } };
      }),
  );
}

function registerSessionStatusTool(
  server: McpServer,
  ctx: ServerContext,
): void {
  server.registerTool(
    "session_status",
    {
      title: "Session status",
      description:
        "Show liveness for one session (by id) or for all known sessions.",
      inputSchema: {
        sessionId: z.string().min(1).optional().describe("Session id"),
      },
    },
    (args) =>
      runTool(async () => {
        let records: SessionRecord[];
        if (args.sessionId !== undefined) {
          const record = await getSession(args.sessionId, ctx.env);
          if (record === undefined) {
            throw new Error(`Session not found: ${args.sessionId}`);
          }
          records = [record];
        } else {
          records = await listSessions(ctx.env);
        }
        const sessions: Array<Record<string, unknown>> = [];
        for (const record of records) {
          sessions.push(await sessionStatusEntry(ctx, record));
        }
        return { data: { sessions } };
      }),
  );
}

async function resolveDestroyTargets(
  ctx: ServerContext,
  args: { sessionId?: string; all?: boolean },
): Promise<SessionRecord[]> {
  if (args.sessionId !== undefined && args.all === true) {
    throw new Error('Pass either "sessionId" or "all", not both');
  }
  if (args.sessionId === undefined && args.all !== true) {
    throw new Error('Pass a "sessionId" or set "all" to true');
  }
  if (args.sessionId === undefined) {
    return listSessions(ctx.env);
  }
  const record = await getSession(args.sessionId, ctx.env);
  if (record === undefined) {
    throw new Error(`Session not found: ${args.sessionId}`);
  }
  return [record];
}

function registerSessionDestroyTool(
  server: McpServer,
  ctx: ServerContext,
): void {
  server.registerTool(
    "session_destroy",
    {
      title: "Destroy lab session",
      description:
        "Destroy a session and stop its processes. Pass a session id, or " +
        "all=true to destroy every session.",
      inputSchema: {
        sessionId: z.string().min(1).optional().describe("Session id"),
        all: z.boolean().optional().describe("Destroy all sessions"),
      },
    },
    (args) =>
      runTool(async () => {
        const records = await resolveDestroyTargets(ctx, args);
        const { destroyed, errors } = await destroyLocalSessions(
          records,
          destroyRuntime(ctx),
          {
            aroundDestroy: (record, destroy) =>
              withMcpEvidence(
                ctx,
                {
                  sessionId: record.id,
                  tool: "session_destroy",
                  target: { name: record.type },
                  refreshReportAfterRecord: true,
                },
                async () => {
                  await destroy();
                  return { data: {} };
                },
              ).then(() => undefined),
          },
        );
        return { data: { destroyed }, errors };
      }),
  );
}

export function registerSessionTools(
  server: McpServer,
  ctx: ServerContext,
): void {
  registerSessionCreateTool(server, ctx);
  registerSessionStatusTool(server, ctx);
  registerSessionDestroyTool(server, ctx);
}
