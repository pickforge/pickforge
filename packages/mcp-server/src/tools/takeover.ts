import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getTakeoverStatus } from "@pickforge/lab-core";
import { resolveSessionRecord, runTool, type ServerContext } from "../context.js";

const sessionArg = {
  session: z
    .string()
    .min(1)
    .optional()
    .describe("Desktop-capable session id (default: the single running session)"),
};

export function registerTakeoverTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "takeover_status",
    {
      title: "Human takeover status",
      description:
        "Check whether a session is currently under supervised human control " +
        "(pickforge/pickforge#21). While active, desktop input and the DevTools " +
        "relay fail closed with a busy error — call this before retrying, or " +
        "use `request_user_input` to ask the human to finish and return " +
        "control via `pickforge-lab watch --control`.",
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
