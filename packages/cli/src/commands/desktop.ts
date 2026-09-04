import { withAgentPermit } from "@pickforge/lab-core";
import {
  click,
  desktopEnvironmentRecipe,
  desktopSessionLogDir,
  doubleClick,
  drag,
  execApp,
  launchApp,
  MAX_DOUBLE_CLICK_INTERVAL_MS,
  MAX_DRAG_DURATION_MS,
  MAX_SCROLL_STEPS,
  move,
  noClientWindowsWarning,
  pressKey,
  screenshot,
  scroll,
  typeText,
  waitForWindow,
} from "@pickforge/lab-desktop-linux";
import {
  captureToTarget,
  parseIntArg,
  parseSignedIntArg,
  requireDisplay,
  resolveScreenshotTarget,
  resolveSessionRecord,
  runReported,
  type BaseCliOptions,
  type ScreenshotTargetOptions,
} from "./shared.js";

const MAX_EXEC_WINDOW_TIMEOUT_MS = 300_000;

export interface DesktopCommandOptions extends BaseCliOptions {
  session?: string;
}

async function resolveDesktop(
  opts: DesktopCommandOptions,
): Promise<{ id: string; display: string }> {
  const record = await resolveSessionRecord("desktop", opts);
  return { id: record.id, display: requireDisplay(record) };
}

export interface DesktopLaunchOptions extends DesktopCommandOptions {
  cwd?: string;
  waitWindow?: string;
}

export async function runDesktopLaunch(
  command: string,
  args: string[],
  opts: DesktopLaunchOptions,
): Promise<number> {
  return runReported(opts, async () => {
    const { id, display } = await resolveDesktop(opts);
    // A newly launched client on the shared display can grab input focus —
    // gated the same as direct input, so it can never land while a human
    // holds the takeover lease (pickforge/pickforge#21 P1-E).
    const app = await withAgentPermit(id, process.env, () =>
      launchApp({
        display,
        command,
        args,
        logDir: desktopSessionLogDir(id),
        cwd: opts.cwd,
      }),
    );
    const data: Record<string, unknown> = {
      sessionId: id,
      display,
      pid: app.pid,
      logPath: app.logPath,
    };
    const lines = [
      `launched ${command} (pid ${app.pid}) on ${display}`,
      `log: ${app.logPath}`,
    ];
    if (opts.waitWindow !== undefined) {
      const window = await waitForWindow(display, opts.waitWindow);
      data.window = window;
      lines.push(`window appeared: ${JSON.stringify(window.name)} (id ${window.id})`);
    }
    return { data, lines };
  });
}

export interface DesktopExecOptions extends DesktopCommandOptions {
  cwd?: string;
  windowTimeout?: string;
}

export async function runDesktopExec(
  command: string,
  args: string[],
  opts: DesktopExecOptions,
): Promise<number> {
  return runReported(opts, async () => {
    const { id, display } = await resolveDesktop(opts);
    const windowTimeoutMs = parseBoundedMsOption(
      opts.windowTimeout,
      "--window-timeout",
      MAX_EXEC_WINDOW_TIMEOUT_MS,
    );
    const app = await withAgentPermit(id, process.env, () =>
      execApp({
        display,
        command,
        args,
        logDir: desktopSessionLogDir(id),
        cwd: opts.cwd,
        windowTimeoutMs,
      }),
    );
    return {
      data: {
        sessionId: id,
        display,
        pid: app.pid,
        processGroupId: app.processGroupId,
        logPath: app.logPath,
        windowCount: app.windows.length,
        windows: app.windows,
      },
      lines: [
        `started ${command} (process group ${app.processGroupId}) on ${display}`,
        `client windows: ${app.windows.length}`,
        `log: ${app.logPath}`,
      ],
    };
  });
}

export async function runDesktopEnv(
  opts: DesktopCommandOptions,
): Promise<number> {
  return runReported(opts, async () => {
    const { id, display } = await resolveDesktop(opts);
    const recipe = desktopEnvironmentRecipe(display, process.env);
    return {
      data: {
        sessionId: id,
        display,
        exports: recipe.exports,
        unset: recipe.unset,
        script: recipe.lines.join("\n"),
      },
      lines: recipe.lines,
    };
  });
}

export interface DesktopScreenshotOptions
  extends DesktopCommandOptions,
    ScreenshotTargetOptions {}

export async function runDesktopScreenshot(
  opts: DesktopScreenshotOptions,
): Promise<number> {
  return runReported(opts, async () => {
    const { id, display } = await resolveDesktop(opts);
    const target = await resolveScreenshotTarget(opts, "desktop", id);
    let tool: string | undefined;
    let windowCount: number | undefined;
    let warnings: string[] = [];
    const data = await captureToTarget(target, async (outPath) => {
      const result = await screenshot({ display, outPath });
      tool = result.tool;
      windowCount = result.windowCount;
      warnings = result.warnings;
    });
    data.sessionId = id;
    data.display = display;
    data.tool = tool;
    data.windowCount = windowCount;
    const lines = [`screenshot saved to ${target.outPath}`];
    if (windowCount !== undefined) {
      lines.push(`client windows: ${windowCount}`);
    }
    if (windowCount === 0) {
      warnings.push(noClientWindowsWarning(display, id));
    }
    if (warnings.length > 0) {
      data.warnings = warnings;
      lines.push(...warnings.map((warning) => `warning: ${warning}`));
    }
    if (data.runId !== undefined) {
      lines.push(`run: ${data.runId}`);
    }
    return { data, lines };
  });
}

function parseButtonOption(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const button = parseIntArg(value, "--button");
  if (button < 1 || button > 9) {
    throw new Error(
      `Invalid --button "${value}": expected an integer between 1 and 9`,
    );
  }
  return button;
}

function parseBoundedMsOption(
  value: string | undefined,
  label: string,
  max: number,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const ms = parseIntArg(value, label);
  if (ms > max) {
    throw new Error(
      `Invalid ${label} "${value}": expected an integer between 0 and ${max}`,
    );
  }
  return ms;
}

function parseDeltaArg(value: string, label: string): number {
  const delta = parseSignedIntArg(value, label);
  if (Math.abs(delta) > MAX_SCROLL_STEPS) {
    throw new Error(
      `Invalid ${label} "${value}": expected at most ${MAX_SCROLL_STEPS} wheel steps per call`,
    );
  }
  return delta;
}

export interface DesktopClickOptions extends DesktopCommandOptions {
  button?: string;
}

export async function runDesktopClick(
  x: string,
  y: string,
  opts: DesktopClickOptions,
): Promise<number> {
  return runReported(opts, async () => {
    const parsedX = parseIntArg(x, "x");
    const parsedY = parseIntArg(y, "y");
    const button = parseButtonOption(opts.button);
    const { id, display } = await resolveDesktop(opts);
    await click({ display, sessionId: id, x: parsedX, y: parsedY, button });
    return {
      data: { sessionId: id, display, x: parsedX, y: parsedY, button: button ?? 1 },
      lines: [`clicked (${parsedX}, ${parsedY}) on ${display}`],
    };
  });
}

export async function runDesktopMove(
  x: string,
  y: string,
  opts: DesktopCommandOptions,
): Promise<number> {
  return runReported(opts, async () => {
    const parsedX = parseIntArg(x, "x");
    const parsedY = parseIntArg(y, "y");
    const { id, display } = await resolveDesktop(opts);
    await move({ display, sessionId: id, x: parsedX, y: parsedY });
    return {
      data: { sessionId: id, display, x: parsedX, y: parsedY },
      lines: [`moved pointer to (${parsedX}, ${parsedY}) on ${display}`],
    };
  });
}

export interface DesktopScrollOptions extends DesktopCommandOptions {
  at?: string;
}

export async function runDesktopScroll(
  deltaX: string,
  deltaY: string,
  opts: DesktopScrollOptions,
): Promise<number> {
  return runReported(opts, async () => {
    const parsedDeltaX = parseDeltaArg(deltaX, "deltaX");
    const parsedDeltaY = parseDeltaArg(deltaY, "deltaY");
    if (parsedDeltaX === 0 && parsedDeltaY === 0) {
      throw new Error(
        "Invalid scroll deltas: expected a non-zero deltaX and/or deltaY",
      );
    }
    let x: number | undefined;
    let y: number | undefined;
    if (opts.at !== undefined) {
      const match = /^(\d+),(\d+)$/.exec(opts.at);
      if (match === null) {
        throw new Error(
          `Invalid --at "${opts.at}": expected "<x>,<y>" with non-negative integers`,
        );
      }
      x = Number(match[1]);
      y = Number(match[2]);
    }
    const { id, display } = await resolveDesktop(opts);
    await scroll({ display, sessionId: id, deltaX: parsedDeltaX, deltaY: parsedDeltaY, x, y });
    const data: Record<string, unknown> = {
      sessionId: id,
      display,
      deltaX: parsedDeltaX,
      deltaY: parsedDeltaY,
    };
    if (x !== undefined && y !== undefined) {
      data.x = x;
      data.y = y;
    }
    return {
      data,
      lines: [
        `scrolled (deltaX ${parsedDeltaX}, deltaY ${parsedDeltaY}) on ${display}`,
      ],
    };
  });
}

export interface DesktopDragOptions extends DesktopCommandOptions {
  button?: string;
  duration?: string;
}

export async function runDesktopDrag(
  fromX: string,
  fromY: string,
  toX: string,
  toY: string,
  opts: DesktopDragOptions,
): Promise<number> {
  return runReported(opts, async () => {
    const parsedFromX = parseIntArg(fromX, "fromX");
    const parsedFromY = parseIntArg(fromY, "fromY");
    const parsedToX = parseIntArg(toX, "toX");
    const parsedToY = parseIntArg(toY, "toY");
    const button = parseButtonOption(opts.button);
    const durationMs = parseBoundedMsOption(
      opts.duration,
      "--duration",
      MAX_DRAG_DURATION_MS,
    );
    const { id, display } = await resolveDesktop(opts);
    await drag({
      display,
      sessionId: id,
      fromX: parsedFromX,
      fromY: parsedFromY,
      toX: parsedToX,
      toY: parsedToY,
      button,
      durationMs,
    });
    return {
      data: {
        sessionId: id,
        display,
        fromX: parsedFromX,
        fromY: parsedFromY,
        toX: parsedToX,
        toY: parsedToY,
        button: button ?? 1,
      },
      lines: [
        `dragged (${parsedFromX}, ${parsedFromY}) -> ` +
          `(${parsedToX}, ${parsedToY}) on ${display}`,
      ],
    };
  });
}

export interface DesktopDoubleClickOptions extends DesktopCommandOptions {
  button?: string;
  interval?: string;
}

export async function runDesktopDoubleClick(
  x: string,
  y: string,
  opts: DesktopDoubleClickOptions,
): Promise<number> {
  return runReported(opts, async () => {
    const parsedX = parseIntArg(x, "x");
    const parsedY = parseIntArg(y, "y");
    const button = parseButtonOption(opts.button);
    const intervalMs = parseBoundedMsOption(
      opts.interval,
      "--interval",
      MAX_DOUBLE_CLICK_INTERVAL_MS,
    );
    const { id, display } = await resolveDesktop(opts);
    await doubleClick({
      display,
      sessionId: id,
      x: parsedX,
      y: parsedY,
      button,
      intervalMs,
    });
    return {
      data: {
        sessionId: id,
        display,
        x: parsedX,
        y: parsedY,
        button: button ?? 1,
      },
      lines: [`double-clicked (${parsedX}, ${parsedY}) on ${display}`],
    };
  });
}

export async function runDesktopType(
  text: string,
  opts: DesktopCommandOptions,
): Promise<number> {
  return runReported(opts, async () => {
    const { id, display } = await resolveDesktop(opts);
    await typeText({ display, sessionId: id, text });
    return {
      data: { sessionId: id, display, length: text.length },
      lines: [`typed ${text.length} character(s) on ${display}`],
    };
  });
}

export async function runDesktopKey(
  key: string,
  opts: DesktopCommandOptions,
): Promise<number> {
  return runReported(opts, async () => {
    const { id, display } = await resolveDesktop(opts);
    await pressKey({ display, sessionId: id, key });
    return {
      data: { sessionId: id, display, key },
      lines: [`pressed ${key} on ${display}`],
    };
  });
}
