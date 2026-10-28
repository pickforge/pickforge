import { setTimeout as delay } from "node:timers/promises";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { checkHumanLeaseBusy, getTakeoverStatus } from "@pickforge/lab-core";
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

async function waitForReturn(ctx: ServerContext, id: string, timeoutMs: number, signal: AbortSignal): Promise<WaitOutcome> {
  const deadline = Date.now() + timeoutMs;
  let gap = 25;
  for (;;) {
    if (signal.aborted) return "cancelled";
    if (await checkHumanLeaseBusy(id, ctx.env) === undefined) return "returned";
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
      timeoutMs: z.number().int().min(0).max(3_600_000).optional()
        .describe("Maximum wait in milliseconds (default 600000, max 3600000)"),
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
      const startedAt = Date.now();
      const outcome = await waitForReturn(ctx, record.id, args.timeoutMs ?? 600_000, extra.mcpReq.signal);
      const heldMs = Date.now() - startedAt;
      const capture = outcome === "returned" || await checkHumanLeaseBusy(record.id, ctx.env) === undefined
        ? await captureDesktopScreenshot({
          ctx, id: record.id, display: requireDisplay(record), type: record.type,
          desktop: record.desktop, actionId, run,
        }) : undefined;
      return {
        data: { sessionId: record.id, outcome, heldMs, screenshot: capture?.data ?? null },
        extraContent: capture?.extraContent,
        evidenceStatus: outcome === "returned" ? "ok" as const : outcome,
      };
    });
  }));
}

export function registerTakeoverTools(server: McpServer, ctx: ServerContext): void {
  registerWaitTool(server, ctx);
  server.registerTool(
    "takeover_status",
    {
      title: "Human takeover status",
      description:
        "Check whether a session is currently under supervised human control. " +
        "While active, desktop input, screenshots, waits and the DevTools " +
        "relay fail closed with a busy error. Use `takeover_wait` to wait " +
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
