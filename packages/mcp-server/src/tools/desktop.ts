import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { withAgentPermit } from "@pickforge/picklab-core";
import {
  click,
  desktopSessionLogDir,
  doubleClick,
  drag,
  launchApp,
  MAX_DOUBLE_CLICK_INTERVAL_MS,
  MAX_DRAG_DURATION_MS,
  MAX_SCROLL_STEPS,
  move,
  pressKey,
  screenshot,
  scroll,
  typeText,
  waitForWindow,
} from "@pickforge/picklab-desktop-linux";
import {
  captureToTarget,
  imageContent,
  requireDisplay,
  resolveScreenshotTarget,
  resolveSessionRecord,
  runTool,
  type ServerContext,
} from "../context.js";
import { withMcpEvidence } from "../evidence.js";

const sessionArg = {
  session: z
    .string()
    .min(1)
    .optional()
    .describe("Desktop session id (default: the single running session)"),
};

const buttonArg = z
  .number()
  .int()
  .min(1)
  .max(9)
  .optional()
  .describe("Mouse button (1-9, default 1)");

const scrollDelta = z
  .number()
  .int()
  .min(-MAX_SCROLL_STEPS)
  .max(MAX_SCROLL_STEPS);

async function resolveDesktop(
  ctx: ServerContext,
  session: string | undefined,
): Promise<{ id: string; display: string }> {
  const record = await resolveSessionRecord(ctx, "desktop", session);
  return { id: record.id, display: requireDisplay(record) };
}

// eslint-disable-next-line max-lines-per-function -- Legacy gate debt: pickforge/picklab#60
export function registerDesktopTools(
  server: McpServer,
  ctx: ServerContext,
): void {
  server.registerTool(
    "desktop_launch",
    {
      title: "Launch desktop app",
      description:
        "Launch an application inside the desktop session (argument array, " +
        "no shell). Optionally wait for a window whose name contains a " +
        "pattern.",
      inputSchema: {
        ...sessionArg,
        command: z.string().min(1).describe("Executable to launch"),
        args: z
          .array(z.string())
          .optional()
          .describe("Arguments for the executable"),
        cwd: z
          .string()
          .min(1)
          .optional()
          .describe("Working directory (relative to the project dir)"),
        waitWindow: z
          .string()
          .min(1)
          .optional()
          .describe("Wait for a window whose name contains this pattern"),
      },
    },
    (args) =>
      runTool(async () => {
        const { id, display } = await resolveDesktop(ctx, args.session);
        return withMcpEvidence(
          ctx,
          {
            sessionId: id,
            tool: "desktop_launch",
            target: { name: args.command },
          },
          async () => {
            // A newly launched client on the shared display can grab input
            // focus — gated the same as direct input, so it can never land
            // while a human holds the takeover lease (pickforge/picklab#21 P1-E).
            const app = await withAgentPermit(id, ctx.env, () =>
              launchApp({
                display,
                command: args.command,
                args: args.args ?? [],
                env: ctx.env,
                logDir: desktopSessionLogDir(id, ctx.env),
                cwd:
                  args.cwd === undefined
                    ? undefined
                    : path.resolve(ctx.projectDir, args.cwd),
              }),
            );
            const data: Record<string, unknown> = {
              sessionId: id,
              display,
              pid: app.pid,
              logPath: app.logPath,
            };
            if (args.waitWindow !== undefined) {
              data.window = await waitForWindow(display, args.waitWindow);
            }
            return { data };
          },
        );
      }),
  );

  server.registerTool(
    "desktop_screenshot",
    {
      title: "Desktop screenshot",
      description:
        "Capture the desktop display as PNG. By default the image joins the " +
        "session's active evidence run, or creates a one-shot run when evidence " +
        "is disabled or no session is selected. Small images return inline.",
      inputSchema: {
        ...sessionArg,
        out: z
          .string()
          .min(1)
          .optional()
          .describe("Explicit output path instead of a run artifact"),
        runSlug: z
          .string()
          .min(1)
          .optional()
          .describe('Run slug (default "desktop")'),
      },
    },
    (args) =>
      runTool(async () => {
        const { id, display } = await resolveDesktop(ctx, args.session);
        return withMcpEvidence(
          ctx,
          {
            sessionId: id,
            tool: "desktop_screenshot",
            artifacts: (result) =>
              typeof result.data?.path === "string" ? [result.data.path] : [],
          },
          async ({ actionId, run }) => {
            const target =
              run !== undefined &&
              args.out === undefined &&
              args.runSlug === undefined
                ? {
                    outPath: path.join(
                      run.dir,
                      "screenshots",
                      `${actionId}.png`,
                    ),
                  }
                : await resolveScreenshotTarget(ctx, args, "desktop", id);
            let tool: string | undefined;
            const data = await captureToTarget(target, async () => {
              const result = await screenshot({
                display,
                outPath: target.outPath,
                env: ctx.env,
              });
              tool = result.tool;
            });
            data.sessionId = id;
            data.display = display;
            data.tool = tool;
            if (run !== undefined && target.run === undefined) {
              data.runId = run.runId;
              data.runDir = run.dir;
            }
            const image = await imageContent(target.outPath);
            Object.assign(data, image.meta);
            return { data, extraContent: image.content };
          },
        );
      }),
  );

  server.registerTool(
    "desktop_click",
    {
      title: "Desktop click",
      description: "Click at the given desktop coordinates.",
      inputSchema: {
        ...sessionArg,
        x: z.number().int().nonnegative().describe("X coordinate"),
        y: z.number().int().nonnegative().describe("Y coordinate"),
        button: buttonArg,
      },
    },
    (args) =>
      runTool(async () => {
        const { id, display } = await resolveDesktop(ctx, args.session);
        return withMcpEvidence(
          ctx,
          {
            sessionId: id,
            tool: "desktop_click",
            target: { x: args.x, y: args.y },
          },
          async () => {
            await click({
              display,
              sessionId: id,
              env: ctx.env,
              x: args.x,
              y: args.y,
              button: args.button,
            });
            return {
              data: {
                sessionId: id,
                display,
                x: args.x,
                y: args.y,
                button: args.button ?? 1,
              },
            };
          },
        );
      }),
  );

  server.registerTool(
    "desktop_move",
    {
      title: "Desktop mouse move",
      description:
        "Move the pointer to the given desktop coordinates without " +
        "clicking (hover).",
      inputSchema: {
        ...sessionArg,
        x: z.number().int().nonnegative().describe("X coordinate"),
        y: z.number().int().nonnegative().describe("Y coordinate"),
      },
    },
    (args) =>
      runTool(async () => {
        const { id, display } = await resolveDesktop(ctx, args.session);
        return withMcpEvidence(
          ctx,
          {
            sessionId: id,
            tool: "desktop_move",
            target: { x: args.x, y: args.y },
          },
          async () => {
            await move({ display, sessionId: id, env: ctx.env, x: args.x, y: args.y });
            return {
              data: { sessionId: id, display, x: args.x, y: args.y },
            };
          },
        );
      }),
  );

  server.registerTool(
    "desktop_scroll",
    {
      title: "Desktop scroll",
      description:
        "Scroll the mouse wheel by integer steps. Positive deltaY scrolls " +
        "down, negative up; positive deltaX scrolls right, negative left. " +
        "Optionally move the pointer to (x, y) first.",
      inputSchema: {
        ...sessionArg,
        deltaX: scrollDelta.describe(
          "Horizontal wheel steps (positive: right, negative: left)",
        ),
        deltaY: scrollDelta.describe(
          "Vertical wheel steps (positive: down, negative: up)",
        ),
        x: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("X coordinate to move the pointer to before scrolling"),
        y: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Y coordinate to move the pointer to before scrolling"),
      },
    },
    (args) =>
      runTool(async () => {
        const { id, display } = await resolveDesktop(ctx, args.session);
        return withMcpEvidence(
          ctx,
          {
            sessionId: id,
            tool: "desktop_scroll",
            target:
              args.x === undefined || args.y === undefined
                ? undefined
                : { x: args.x, y: args.y },
          },
          async () => {
            await scroll({
              display,
              sessionId: id,
              env: ctx.env,
              deltaX: args.deltaX,
              deltaY: args.deltaY,
              x: args.x,
              y: args.y,
            });
            const data: Record<string, unknown> = {
              sessionId: id,
              display,
              deltaX: args.deltaX,
              deltaY: args.deltaY,
            };
            if (args.x !== undefined && args.y !== undefined) {
              data.x = args.x;
              data.y = args.y;
            }
            return { data };
          },
        );
      }),
  );

  server.registerTool(
    "desktop_drag",
    {
      title: "Desktop drag",
      description:
        "Press the mouse button at (fromX, fromY), move to (toX, toY), " +
        "and release.",
      inputSchema: {
        ...sessionArg,
        fromX: z.number().int().nonnegative().describe("Start X coordinate"),
        fromY: z.number().int().nonnegative().describe("Start Y coordinate"),
        toX: z.number().int().nonnegative().describe("End X coordinate"),
        toY: z.number().int().nonnegative().describe("End Y coordinate"),
        button: buttonArg,
        durationMs: z
          .number()
          .int()
          .min(0)
          .max(MAX_DRAG_DURATION_MS)
          .optional()
          .describe("Total drag duration in ms (default 300)"),
      },
    },
    (args) =>
      runTool(async () => {
        const { id, display } = await resolveDesktop(ctx, args.session);
        return withMcpEvidence(
          ctx,
          {
            sessionId: id,
            tool: "desktop_drag",
            target: { x: args.toX, y: args.toY },
          },
          async () => {
            await drag({
              display,
              sessionId: id,
              env: ctx.env,
              fromX: args.fromX,
              fromY: args.fromY,
              toX: args.toX,
              toY: args.toY,
              button: args.button,
              durationMs: args.durationMs,
            });
            return {
              data: {
                sessionId: id,
                display,
                fromX: args.fromX,
                fromY: args.fromY,
                toX: args.toX,
                toY: args.toY,
                button: args.button ?? 1,
              },
            };
          },
        );
      }),
  );

  server.registerTool(
    "desktop_double_click",
    {
      title: "Desktop double click",
      description: "Double-click at the given desktop coordinates.",
      inputSchema: {
        ...sessionArg,
        x: z.number().int().nonnegative().describe("X coordinate"),
        y: z.number().int().nonnegative().describe("Y coordinate"),
        button: buttonArg,
        intervalMs: z
          .number()
          .int()
          .min(0)
          .max(MAX_DOUBLE_CLICK_INTERVAL_MS)
          .optional()
          .describe("Delay between the two clicks in ms (default 100)"),
      },
    },
    (args) =>
      runTool(async () => {
        const { id, display } = await resolveDesktop(ctx, args.session);
        return withMcpEvidence(
          ctx,
          {
            sessionId: id,
            tool: "desktop_double_click",
            target: { x: args.x, y: args.y },
          },
          async () => {
            await doubleClick({
              display,
              sessionId: id,
              env: ctx.env,
              x: args.x,
              y: args.y,
              button: args.button,
              intervalMs: args.intervalMs,
            });
            return {
              data: {
                sessionId: id,
                display,
                x: args.x,
                y: args.y,
                button: args.button ?? 1,
              },
            };
          },
        );
      }),
  );

  server.registerTool(
    "desktop_type",
    {
      title: "Desktop type",
      description: "Type text into the focused desktop window.",
      inputSchema: {
        ...sessionArg,
        text: z.string().min(1).describe("Text to type"),
      },
    },
    (args) =>
      runTool(async () => {
        const { id, display } = await resolveDesktop(ctx, args.session);
        return withMcpEvidence(
          ctx,
          {
            sessionId: id,
            tool: "desktop_type",
            typedValue: { value: args.text, inputType: "text" },
          },
          async () => {
            await typeText({ display, sessionId: id, env: ctx.env, text: args.text });
            return {
              data: { sessionId: id, display, length: args.text.length },
            };
          },
        );
      }),
  );

  server.registerTool(
    "desktop_key",
    {
      title: "Desktop key press",
      description:
        'Press a key or chord (e.g. "Return", "Tab", "ctrl+s") in the ' +
        "desktop session.",
      inputSchema: {
        ...sessionArg,
        key: z.string().min(1).describe("Key or chord to press"),
      },
    },
    (args) =>
      runTool(async () => {
        const { id, display } = await resolveDesktop(ctx, args.session);
        return withMcpEvidence(
          ctx,
          {
            sessionId: id,
            tool: "desktop_key",
            typedValue: { value: args.key },
          },
          async () => {
            await pressKey({ display, sessionId: id, env: ctx.env, key: args.key });
            return { data: { sessionId: id, display, key: args.key } };
          },
        );
      }),
  );
}
