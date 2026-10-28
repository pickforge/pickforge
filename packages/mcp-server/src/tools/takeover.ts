import { setTimeout as delay } from "node:timers/promises";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { checkHumanLeaseBusy, getTakeoverStatus, loadConfig } from "@pickforge/lab-core";
import {
  findNativeViewerHost, requestNativeViewerHost, followNativeViewerRequest, validTakeoverMessage,
  type NativeViewerHostIdentity, type ViewerRequestOutcome,
} from "@pickforge/lab-desktop-linux";
import { requireDisplay, resolveSessionRecord, runTool, type ServerContext } from "../context.js";
import { withMcpEvidence } from "../evidence.js";
import { captureDesktopScreenshot } from "./desktop.js";

const sessionArg = {
  session: z
    .string()
    .min(1)
    .optional()
    .describe("Desktop-capable session id (default: the single running session)"),
};

type WaitOutcome = "returned" | "timeout" | "cancelled";
const timeoutArg = z.number().int().min(0).max(3_600_000).optional()
  .describe("Maximum wait in milliseconds (default 600000, max 3600000)");

interface HeldControl { since?: number; until?: number }

function heldMs(held: HeldControl): number {
  return held.since === undefined ? 0 : Math.max(0, (held.until ?? Date.now()) - held.since);
}

async function waitForReturn(ctx: ServerContext, id: string, timeoutMs: number, signal: AbortSignal,
  held: HeldControl): Promise<WaitOutcome> {
  const deadline = Date.now() + timeoutMs;
  let gap = 25;
  for (;;) {
    if (signal.aborted) return "cancelled";
    const lease = await checkHumanLeaseBusy(id, ctx.env);
    if (lease === undefined) return "returned";
    held.since ??= Date.parse(lease.createdAt);
    const remaining = deadline - Date.now();
    if (remaining <= 0) return "timeout";
    try {
      await delay(Math.min(gap, remaining), undefined, { signal });
    } catch (error) {
      if (signal.aborted) return "cancelled";
      throw error;
    }
    gap = Math.min(gap * 2, 250);
  }
}

function registerWaitTool(server: McpServer, ctx: ServerContext): void {
  server.registerTool("takeover_wait", {
    title: "Wait for human control to return",
    description: "Wait until no human lease is active, then capture a fresh desktop screenshot. " +
      "Timeout and cancellation leave control unchanged; screenshot is null while a human lease remains active.",
    inputSchema: {
      ...sessionArg,
      timeoutMs: timeoutArg,
    },
  }, (args, extra) => runTool(async () => {
    const record = await resolveSessionRecord(ctx, "desktop", args.session);
    return withMcpEvidence(ctx, {
      sessionId: record.id,
      tool: "takeover_wait",
      artifacts: (result) => {
        const shot = result.data?.screenshot as Record<string, unknown> | null | undefined;
        return typeof shot?.path === "string" ? [shot.path] : [];
      },
    }, async ({ actionId, run }) => {
      const held: HeldControl = {};
      const outcome = await waitForReturn(ctx, record.id, args.timeoutMs ?? 600_000, extra.mcpReq.signal, held);
      const duration = heldMs(held);
      const capture = outcome === "returned" || await checkHumanLeaseBusy(record.id, ctx.env) === undefined
        ? await captureDesktopScreenshot({
          ctx, id: record.id, display: requireDisplay(record), type: record.type,
          desktop: record.desktop, actionId, run,
        }) : undefined;
      return {
        data: { sessionId: record.id, outcome, heldMs: duration, screenshot: capture?.data ?? null },
        extraContent: capture?.extraContent,
        evidenceStatus: outcome === "returned" ? "ok" as const : outcome,
      };
    });
  }));
}

async function resolveViewer(ctx: ServerContext, id: string): Promise<NativeViewerHostIdentity | undefined> {
  const host = await findNativeViewerHost(id, ctx.env);
  if (host !== undefined) return host;
  const config = await loadConfig(ctx.projectDir, ctx.env);
  if (config.viewer?.mode !== "auto" || ctx.viewerLauncher === undefined || !await ctx.viewerLauncher.available(ctx.env)) return undefined;
  return ctx.viewerLauncher.launch(id, ctx.env);
}

async function trackViewerControl(host: NativeViewerHostIdentity, timeoutMs: number, held: HeldControl, signal: AbortSignal): Promise<() => Promise<void>> {
  const controller = new AbortController();
  let subscribed!: () => void;
  const ready = new Promise<void>((resolve) => { subscribed = resolve; });
  // Subscribe before requesting, so a complete take/return before request replay still has timing.
  const tracking = followNativeViewerRequest(host, undefined, { signal: AbortSignal.any([signal, controller.signal]), timeoutMs,
    onReady: subscribed, onTaken: () => { held.since ??= Date.now(); }, onReturned: () => { held.until = Date.now(); } });
  await Promise.race([ready, tracking]);
  return async () => { controller.abort(); await tracking; };
}

async function requestViewer(host: NativeViewerHostIdentity, message: string,
  timeoutMs: number, signal: AbortSignal, held: HeldControl): Promise<ViewerRequestOutcome> {
  if (signal.aborted) return "cancelled";
  const stopTracking = await trackViewerControl(host, timeoutMs, held, signal);
  try {
    if (signal.aborted) return "cancelled";
    const response = await requestNativeViewerHost(host, { op: "requestTakeover", message, timeoutMs });
    if (!response.ok || response.requestId === undefined) throw new Error("Viewer request was refused");
    try {
      return await followNativeViewerRequest(host, response.requestId, { signal, timeoutMs,
        onTaken: () => { held.since ??= Date.now(); } });
    } catch {
      await requestNativeViewerHost(host, { op: "cancelRequest", requestId: response.requestId }).catch(() => {});
      return signal.aborted ? "cancelled" : "viewer_closed";
    }
  } finally { await stopTracking(); }
}

async function requestOutcome(ctx: ServerContext, id: string, message: string, timeoutMs: number,
  signal: AbortSignal, held: HeldControl): Promise<ViewerRequestOutcome | "viewer_not_open"> {
  if (signal.aborted) return "cancelled";
  const lease = await checkHumanLeaseBusy(id, ctx.env);
  if (lease !== undefined) {
    held.since = Date.parse(lease.createdAt);
    return waitForReturn(ctx, id, timeoutMs, signal, held);
  }
  const host = await resolveViewer(ctx, id);
  if (signal.aborted) return "cancelled";
  if (host === undefined) return "viewer_not_open";
  try { return await requestViewer(host, message, timeoutMs, signal, held); }
  catch { return signal.aborted ? "cancelled" : "viewer_closed"; }
}

function registerRequestTool(server: McpServer, ctx: ServerContext): void {
  server.registerTool("request_takeover", {
    title: "Ask the human to take control",
    description: "Ask for help in the native viewer without taking focus. Wait for return, then capture a fresh screenshot. " +
      "Only viewer.mode auto may open a viewer. Timeout and cancellation leave live human control unchanged.",
    inputSchema: {
      ...sessionArg,
      message: z.string().refine(validTakeoverMessage, "Use at most 500 characters without control or bidirectional formatting characters"),
      timeoutMs: timeoutArg,
    },
  }, (args, extra) => runTool(async () => {
    const record = await resolveSessionRecord(ctx, "desktop", args.session);
    return withMcpEvidence(ctx, {
      sessionId: record.id, tool: "takeover_requested",
      artifacts: (result) => {
        const shot = result.data?.screenshot as Record<string, unknown> | null | undefined;
        return typeof shot?.path === "string" ? [shot.path] : [];
      },
    }, async ({ actionId, run }) => {
      const held: HeldControl = {};
      const signal = extra.mcpReq.signal;
      const timeoutMs = args.timeoutMs ?? 600_000;
      const outcome = await requestOutcome(ctx, record.id, args.message, timeoutMs, signal, held);
      if (outcome === "viewer_not_open") return { data: { sessionId: record.id, outcome,
        command: `pickforge-lab watch --session ${record.id}`, heldMs: 0, screenshot: null } };
      const duration = heldMs(held);
      const capture = await checkHumanLeaseBusy(record.id, ctx.env) === undefined
        ? await captureDesktopScreenshot({ ctx, id: record.id, display: requireDisplay(record), type: record.type,
          desktop: record.desktop, actionId, run }) : undefined;
      return { data: { sessionId: record.id, outcome, heldMs: duration, screenshot: capture?.data ?? null },
        extraContent: capture?.extraContent,
        evidenceStatus: outcome === "timeout" || outcome === "cancelled" ? outcome : "ok" };
    });
  }));
}

export function registerTakeoverTools(server: McpServer, ctx: ServerContext): void {
  registerWaitTool(server, ctx);
  registerRequestTool(server, ctx);
  server.registerTool(
    "takeover_status",
    {
      title: "Human takeover status",
      description:
        "Check whether a session is currently under supervised human control. " +
        "While active, desktop input, screenshots, waits and the DevTools " +
        "relay fail closed with a busy error. Use `request_takeover` to ask for help, or `takeover_wait` to wait " +
        "for control to return and receive a fresh screenshot.",
      inputSchema: { ...sessionArg },
    },
    (args) =>
      runTool(async () => {
        const record = await resolveSessionRecord(ctx, "desktop", args.session);
        const status = await getTakeoverStatus(record.id, ctx.env);
        const data: Record<string, unknown> = {
          sessionId: record.id,
          active: status.active,
        };
        if (status.stale === true) data.stale = true;
        if (status.lease !== undefined) {
          data.lease = {
            leaseId: status.lease.leaseId,
            ownerPid: status.lease.ownerPid,
            createdAt: status.lease.createdAt,
            expiresAt: status.lease.expiresAt,
          };
        }
        return { data };
      }),
  );
}
