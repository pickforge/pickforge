import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { isEvidenceTruncated, withAgentPermit } from "@pickforge/lab-core";
import type { RunHandle, SessionType } from "@pickforge/lab-core";
import { setRunCaptureGeometry } from "@pickforge/lab-core";
import {
  click,
  DEFAULT_DESKTOP_WAIT_TIMEOUT_MS,
  desktopWait,
  desktopWindows,
  focusWindow,
  selectDesktopWindow,
  MAX_FOCUS_TIMEOUT_MS,
  desktopSessionLogDir,
  doubleClick,
  drag,
  ensureDesktopSessionIsolation,
  execApp,
  launchApp,
  MAX_DOUBLE_CLICK_INTERVAL_MS,
  MAX_DRAG_DURATION_MS,
  MAX_DESKTOP_WAIT_TIMEOUT_MS,
  MAX_SCROLL_STEPS,
  MAX_STABLE_MS,
  move,
  noClientWindowsWarning,
  pressKey,
  screenshot,
  screenshotMetadata,
  scroll,
  typeText,
  waitForWindow,
  type ScreenshotMetadata,
} from "@pickforge/lab-desktop-linux";
import {
  captureRunArtifact,
  captureToTarget,
  imageContent,
  requireDisplay,
  resolveProjectPath,
  resolveScreenshotTarget,
  resolveSessionRecord,
  resolveWaitBaseline,
  runTool,
  type ServerContext,
  type ToolReport,
} from "../context.js";
import { evidenceStatus, withMcpEvidence, type McpEvidenceOptions } from "../evidence.js";

const sessionArg = {
  session: z
    .string()
    .min(1)
    .optional()
    .describe("Desktop session id (default: the single running session)"),
};

const captureDescription = " Optional capture: after or both (before and after) saves explicit PNGs on this action's evidence run. Default off; requires enabled evidence. Never capture sensitive screens; pixels are not redacted.";
const captureArg = {
  capture: z.enum(["after", "both"]).optional().describe(captureDescription.trim()),
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
): Promise<{
  id: string;
  display: string;
  type: SessionType;
  desktop?: { width?: number; height?: number };
}> {
  const record = await resolveSessionRecord(ctx, "desktop", session);
  return {
    id: record.id,
    display: requireDisplay(record),
    type: record.type,
    desktop: record.desktop,
  };
}

async function recordCaptureDevice(
  run: RunHandle | undefined,
  metadata: ScreenshotMetadata,
  sessionType: SessionType,
): Promise<void> {
  if (run === undefined || sessionType === "android") return;
  await setRunCaptureGeometry(run, {
    image: metadata.imageSize,
    viewport: metadata.displaySize,
    scale: metadata.scale,
    coordinateSpace: metadata.inputCoordinates,
  });
}

function registerLaunchTool(server: McpServer, ctx: ServerContext): void {
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
        windowTimeoutMs: z
          .number()
          .int()
          .min(0)
          .max(300_000)
          .optional()
          .describe("Maximum time to wait for waitWindow (default 10000)"),
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
            // while a human holds the takeover lease (pickforge/pickforge#21 P1-E).
            const cwd =
              args.cwd === undefined
                ? undefined
                : await resolveProjectPath(ctx, args.cwd);
            const app = await withAgentPermit(id, ctx.env, async () => {
              const isolation = await ensureDesktopSessionIsolation(id, ctx.env);
              return launchApp({
                display,
                command: args.command,
                args: args.args ?? [],
                env: ctx.env,
                logDir: desktopSessionLogDir(id, ctx.env),
                cwd,
                ...isolation,
              });
            });
            const data: Record<string, unknown> = {
              sessionId: id,
              display,
              pid: app.pid,
              logPath: app.logPath,
              containment: app.containment,
            };
            if (args.waitWindow !== undefined) {
              data.window = await waitForWindow(
                display,
                args.waitWindow,
                args.windowTimeoutMs ?? DEFAULT_DESKTOP_WAIT_TIMEOUT_MS,
                ctx.env,
              );
            }
            return { data };
          },
        );
      }),
  );
}

function registerExecTool(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "desktop_exec",
    {
      title: "Execute desktop command",
      description:
        "Start a command in the isolated desktop environment and process " +
        "group, then wait a bounded time for a client window to appear.",
      inputSchema: {
        ...sessionArg,
        command: z.string().min(1).describe("Executable to start"),
        args: z.array(z.string()).optional().describe("Arguments for the executable"),
        cwd: z
          .string()
          .min(1)
          .optional()
          .describe("Working directory (relative to the project dir)"),
        windowTimeoutMs: z
          .number()
          .int()
          .min(0)
          .max(300_000)
          .optional()
          .describe("Maximum time to wait for a client window (default 30000)"),
      },
    },
    (args) =>
      runTool(async () => {
        const { id, display } = await resolveDesktop(ctx, args.session);
        return withMcpEvidence(
          ctx,
          {
            sessionId: id,
            tool: "desktop_exec",
            target: { name: args.command },
          },
          async () => {
            const cwd =
              args.cwd === undefined
                ? undefined
                : await resolveProjectPath(ctx, args.cwd);
            const app = await withAgentPermit(id, ctx.env, async () => {
              const isolation = await ensureDesktopSessionIsolation(id, ctx.env);
              return execApp({
                display,
                command: args.command,
                args: args.args ?? [],
                env: ctx.env,
                logDir: desktopSessionLogDir(id, ctx.env),
                cwd,
                windowTimeoutMs: args.windowTimeoutMs,
                ...isolation,
              });
            });
            return {
              data: {
                sessionId: id,
                display,
                pid: app.pid,
                processGroupId: app.processGroupId,
                containment: app.containment,
                logPath: app.logPath,
                windowCount: app.windows.length,
                windows: app.windows,
              },
            };
          },
        );
      }),
  );
}

async function captureDesktopScreenshot(opts: {
  ctx: ServerContext;
  id: string;
  display: string;
  type: SessionType;
  desktop?: { width?: number; height?: number };
  actionId: string;
  run?: RunHandle;
  out?: string;
  runSlug?: string;
  onCaptured?: (path: string) => void;
}): Promise<{ data: Record<string, unknown>; extraContent: Awaited<ReturnType<typeof imageContent>>["content"] }> {
  let tool: string | undefined;
  let windowCount: number | undefined;
  let warnings: string[] = [];
  let imageSize: ScreenshotMetadata["imageSize"] | undefined;
  let liveDisplay: ScreenshotMetadata["displaySize"] | undefined;
  const capture = async (outPath: string): Promise<void> => {
    const result = await screenshot({
      display: opts.display,
      outPath,
      env: opts.ctx.env,
    });
    tool = result.tool;
    windowCount = result.windowCount;
    warnings = result.warnings;
    imageSize = result.imageSize;
    liveDisplay = result.displaySize;
  };
  const intoEvidenceRun =
    opts.run !== undefined && opts.out === undefined && opts.runSlug === undefined;
  let data: Record<string, unknown>;
  let outPath: string;
  let capturedRun = opts.run;
  if (intoEvidenceRun && opts.run !== undefined) {
    outPath = await captureRunArtifact(
      opts.run,
      "screenshots",
      `${opts.actionId}.png`,
      capture,
    );
    opts.onCaptured?.(outPath);
    data = { path: outPath, runId: opts.run.runId, runDir: opts.run.dir };
  } else {
    const target = await resolveScreenshotTarget(
      opts.ctx,
      { out: opts.out, runSlug: opts.runSlug },
      "desktop",
      opts.id,
    );
    data = await captureToTarget(target, capture);
    outPath = target.outPath;
    capturedRun = target.run;
  }
  data.sessionId = opts.id;
  data.display = opts.display;
  data.tool = tool;
  data.windowCount = windowCount;
  if (imageSize === undefined) {
    throw new Error("Screenshot succeeded without readable image dimensions");
  }
  const metadata = screenshotMetadata(
    imageSize,
    liveDisplay ?? imageSize,
  );
  Object.assign(data, metadata);
  await recordCaptureDevice(opts.run, metadata, opts.type);
  if (capturedRun !== undefined && capturedRun.runId !== opts.run?.runId) {
    await recordCaptureDevice(capturedRun, metadata, opts.type);
  }
  if (windowCount === 0) warnings.push(noClientWindowsWarning(opts.display, opts.id));
  if (warnings.length > 0) data.warnings = warnings;
  const image = await imageContent(outPath);
  Object.assign(data, image.meta);
  return { data, extraContent: image.content };
}

function registerScreenshotTool(server: McpServer, ctx: ServerContext): void {
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
        const { id, display, desktop, type } = await resolveDesktop(ctx, args.session);
        return withMcpEvidence(
          ctx,
          {
            sessionId: id,
            tool: "desktop_screenshot",
            artifacts: (result) =>
              typeof result.data?.path === "string" ? [result.data.path] : [],
          },
          async ({ actionId, run }) =>
            captureDesktopScreenshot({
              ctx,
              id,
              display,
              type,
              desktop,
              actionId,
              run,
              out: args.out,
              runSlug: args.runSlug,
            }),
        );
      }),
  );
}

function failedCaptureRecording(
  result: ToolReport,
  reason: "capped" | "unconfirmed",
): ToolReport {
  const linkage = reason === "capped" ? "not linked (recording cap reached)" : "not confirmed";
  return {
    ...result,
    data: { ...result.data, captureRecording: reason },
    errors: [...(result.errors ?? []), `Capture evidence ${linkage}; input ${result.data?.inputState}. Input is never retried automatically`],
    evidenceStatus: "error",
  };
}

async function withInputCapture(
  ctx: ServerContext,
  options: McpEvidenceOptions<ToolReport>,
  display: string,
  capture: "after" | "both" | undefined,
  input: () => Promise<ToolReport>,
): Promise<ToolReport> {
  if (capture === undefined) return withMcpEvidence(ctx, options, input);
  const artifacts: string[] = [];
  return withMcpEvidence(ctx, {
    ...options, artifacts: () => artifacts, onRecordingFailure: failedCaptureRecording,
  }, async ({ actionId, run }) => {
    if (run === undefined) throw new Error("Explicit input capture requires available, enabled evidence; input was not attempted");
    const captures: Record<string, unknown>[] = [];
    let inputState = "not-attempted";
    let stage = "capture recording preflight";
    const take = async (phase: "before" | "after") => {
      const shot = await captureDesktopScreenshot({
        ctx, id: options.sessionId!, display, type: "desktop", run,
        actionId: `${actionId}-${phase}`,
        onCaptured: (file) => artifacts.push(file),
      });
      captures.push({ phase, ...shot.data });
    };
    try {
      if (await isEvidenceTruncated(run)) {
        return {
          data: { sessionId: options.sessionId, capture, captures, inputState, artifacts },
          errors: ["Capture recording cap reached; input not-attempted"],
          evidenceStatus: "error",
        };
      }
      stage = "before capture";
      if (capture === "both") await take("before");
      stage = "input";
      inputState = "attempted";
      const result = await input();
      if ((result.errors?.length ?? 0) > 0) return { ...result, data: { ...result.data, capture, captures, inputState, artifacts } };
      inputState = "completed";
      stage = "after capture";
      await take("after");
      return { ...result, data: { ...result.data, capture, captures, inputState, artifacts } };
    } catch (error) {
      // Typed values must not reappear through subprocess diagnostics. Keep the
      // existing length/type target, and report only the failed stage here.
      const detail = options.typedValue === undefined
        ? `: ${error instanceof Error ? error.message : String(error)}` : "";
      return {
        data: { sessionId: options.sessionId, capture, captures, inputState, artifacts },
        errors: [`${stage} failed; input ${inputState}. Input is never retried automatically${detail}`],
        evidenceStatus: evidenceStatus(error),
      };
    }
  });
}

function registerClickTool(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "desktop_click",
    {
      title: "Desktop click",
      description: "Click at the given desktop coordinates." + captureDescription,
      inputSchema: {
        ...sessionArg,
        ...captureArg,
        x: z.number().int().nonnegative().describe("X coordinate"),
        y: z.number().int().nonnegative().describe("Y coordinate"),
        button: buttonArg,
      },
    },
    (args) =>
      runTool(async () => {
        const { id, display } = await resolveDesktop(ctx, args.session);
        return withInputCapture(
          ctx,
          {
            sessionId: id,
            tool: "desktop_click",
            target: { x: args.x, y: args.y },
          },
          display, args.capture,
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
}

function registerMoveTool(server: McpServer, ctx: ServerContext): void {
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
}

function registerScrollTool(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "desktop_scroll",
    {
      title: "Desktop scroll",
      description:
        "Scroll the mouse wheel by integer steps. Positive deltaY scrolls " +
        "down, negative up; positive deltaX scrolls right, negative left. " +
        "Optionally move the pointer to (x, y) first." + captureDescription,
      inputSchema: {
        ...sessionArg,
        ...captureArg,
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
        return withInputCapture(
          ctx,
          {
            sessionId: id,
            tool: "desktop_scroll",
            target:
              args.x === undefined || args.y === undefined
                ? undefined
                : { x: args.x, y: args.y },
          },
          display, args.capture,
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
}

function registerDragTool(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "desktop_drag",
    {
      title: "Desktop drag",
      description:
        "Press the mouse button at (fromX, fromY), move to (toX, toY), " +
        "and release." + captureDescription,
      inputSchema: {
        ...sessionArg,
        ...captureArg,
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
        return withInputCapture(
          ctx,
          {
            sessionId: id,
            tool: "desktop_drag",
            target: { x: args.toX, y: args.toY },
          },
          display, args.capture,
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
}

function registerDoubleClickTool(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "desktop_double_click",
    {
      title: "Desktop double click",
      description: "Double-click at the given desktop coordinates." + captureDescription,
      inputSchema: {
        ...sessionArg,
        ...captureArg,
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
        return withInputCapture(
          ctx,
          {
            sessionId: id,
            tool: "desktop_double_click",
            target: { x: args.x, y: args.y },
          },
          display, args.capture,
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
}

function registerTypeTool(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "desktop_type",
    {
      title: "Desktop type",
      description: "Type text into the focused desktop window." + captureDescription,
      inputSchema: {
        ...sessionArg,
        ...captureArg,
        text: z.string().min(1).describe("Text to type"),
      },
    },
    (args) =>
      runTool(async () => {
        const { id, display } = await resolveDesktop(ctx, args.session);
        return withInputCapture(
          ctx,
          {
            sessionId: id,
            tool: "desktop_type",
            typedValue: { value: args.text, inputType: "text" },
          },
          display, args.capture,
          async () => {
            await typeText({ display, sessionId: id, env: ctx.env, text: args.text });
            return {
              data: { sessionId: id, display, length: args.text.length },
            };
          },
        );
      }),
  );
}

function registerKeyTool(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "desktop_key",
    {
      title: "Desktop key press",
      description:
        'Press a key or chord (e.g. "Return", "Tab", "ctrl+s") in the ' +
        "desktop session." + captureDescription,
      inputSchema: {
        ...sessionArg,
        ...captureArg,
        key: z.string().min(1).describe("Key or chord to press"),
      },
    },
    (args) =>
      runTool(async () => {
        const { id, display } = await resolveDesktop(ctx, args.session);
        return withInputCapture(
          ctx,
          {
            sessionId: id,
            tool: "desktop_key",
            typedValue: { value: args.key },
          },
          display, args.capture,
          async () => {
            await pressKey({ display, sessionId: id, env: ctx.env, key: args.key });
            return { data: { sessionId: id, display, key: args.key } };
          },
        );
      }),
  );
}

function registerWindowsTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool("desktop_windows", {
    title: "Desktop windows",
    description: "List visible named X11 windows with id, name, class, geometry and input focus state.",
    inputSchema: sessionArg,
  }, (args) => runTool(async () => {
    const { id, display } = await resolveDesktop(ctx, args.session);
    return { data: { sessionId: id, display, windows: await desktopWindows(display, ctx.env) } };
  }));
  server.registerTool("desktop_focus", {
    title: "Focus desktop window",
    description: "Focus by decimal window id or exact name (exactly one). Ambiguous names are rejected. Confirms X input focus without requiring a window manager." + captureDescription,
    inputSchema: {
      ...sessionArg,
      ...captureArg,
      id: z.string().regex(/^[1-9]\d*$/).optional(),
      name: z.string().min(1).optional(),
      timeoutMs: z.number().int().min(1).max(MAX_FOCUS_TIMEOUT_MS).optional(),
    },
  }, (args) => runTool(async () => {
    const { id, display } = await resolveDesktop(ctx, args.session);
    let window;
    try {
      window = await selectDesktopWindow(display, args, ctx.env);
    } catch (error) {
      return withMcpEvidence(ctx, {
        sessionId: id, tool: "desktop_focus",
        target: { role: "window", name: args.name, selector: args.id },
      }, async () => { throw error; });
    }
    return withInputCapture(ctx, {
      sessionId: id, tool: "desktop_focus",
      target: { role: "window", name: window.name, selector: window.id },
    }, display, args.capture, async () => ({ data: {
      sessionId: id, display,
      window: await focusWindow({ display, sessionId: id, window, env: ctx.env, timeoutMs: args.timeoutMs }),
    } }));
  }));
}

function waitMode(args: {
  baseline?: string;
  stableMs?: number;
  window?: string;
}): { type: "changed"; baselinePath: string } | { type: "stable"; stableMs: number } | { type: "window"; name: string } {
  const selected = [args.baseline, args.stableMs, args.window].filter((value) => value !== undefined);
  if (selected.length !== 1) {
    throw new Error("desktop_wait requires exactly one of baseline, stableMs, or window");
  }
  if (args.baseline !== undefined) return { type: "changed", baselinePath: args.baseline };
  if (args.stableMs !== undefined) return { type: "stable", stableMs: args.stableMs };
  return { type: "window", name: args.window! };
}

function registerWaitTool(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "desktop_wait",
    {
      title: "Wait for desktop change",
      description:
        "Wait until the screen pixels differ from a baseline PNG, sampled " +
        "pixels stay unchanged for stableMs, or a window name substring appears. " +
        "Stability is sampled, not every frame. Observation only; not an input action.",
      inputSchema: {
        ...sessionArg,
        baseline: z
          .string()
          .min(1)
          .optional()
          .describe("Existing PNG to wait for a pixel change against"),
        stableMs: z
          .number()
          .int()
          .min(1)
          .max(MAX_STABLE_MS)
          .optional()
          .describe("Require sampled unchanged pixels for this many milliseconds"),
        window: z
          .string()
          .min(1)
          .optional()
          .describe("Wait for a window whose name contains this substring"),
        timeoutMs: z
          .number()
          .int()
          .min(0)
          .max(MAX_DESKTOP_WAIT_TIMEOUT_MS)
          .optional()
          .describe("Maximum wait including capture and window queries (default 10000)"),
      },
    },
    (args) =>
      runTool(async () => {
        const { id, display } = await resolveDesktop(ctx, args.session);
        const selected = waitMode(args);
        const mode = selected;
        return withMcpEvidence(
          ctx,
          { sessionId: id, tool: "desktop_wait" },
          async () => {
            const waited = await desktopWait({
              display,
              mode,
              readBaseline: (file, deadline) => resolveWaitBaseline(ctx, file, deadline),
              timeoutMs: args.timeoutMs,
              env: ctx.env,
            });
            const data: Record<string, unknown> = {
              sessionId: id,
              display,
              reason: waited.reason,
              elapsedMs: waited.elapsedMs,
              samples: waited.samples,
              sampled: true,
            };
            if (waited.window !== undefined) data.window = waited.window;
            return {
              data,
              evidenceStatus: waited.reason === "timeout" ? "timeout" : "ok",
            };
          },
        );
      }),
  );
}

export function registerDesktopTools(
  server: McpServer,
  ctx: ServerContext,
): void {
  registerWindowsTools(server, ctx);
  registerLaunchTool(server, ctx);
  registerExecTool(server, ctx);
  registerScreenshotTool(server, ctx);
  registerWaitTool(server, ctx);
  registerClickTool(server, ctx);
  registerMoveTool(server, ctx);
  registerScrollTool(server, ctx);
  registerDragTool(server, ctx);
  registerDoubleClickTool(server, ctx);
  registerTypeTool(server, ctx);
  registerKeyTool(server, ctx);
}
