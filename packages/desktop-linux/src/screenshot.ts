import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DirHandle, ObservationTimeoutError, runCommand, type EnvLike } from "@pickforge/lab-core";
import { listWindows } from "./apps.js";
import { parseDisplayNumber } from "./display.js";
import { readPngImageSize, type PngImageSize } from "./png.js";
import { findOnPath } from "./util.js";

const SCREENSHOT_TIMEOUT_MS = 20_000;
export const SCREENSHOT_SCALE = 1;
export const IMAGE_PIXEL_COORDINATES = "image-pixels" as const;

export type ScreenshotTool = "maim" | "import" | "xwd" | "scrot";

export interface ScreenshotStep {
  cmd: string;
  args: string[];
  requiresDisplayEnv?: true;
}

export interface ScreenshotOptions {
  display: string;
  outPath: string;
  tool?: ScreenshotTool;
  env?: EnvLike;
  /** Overall capture bound. When omitted, each tool step uses 20s. */
  timeoutMs?: number;
  /** Skip the xdotool window listing used for escape warnings. */
  countWindows?: boolean;
}

export interface ScreenshotResult {
  path: string;
  tool: ScreenshotTool;
  windowCount: number | undefined;
  warnings: string[];
  imageSize: PngImageSize;
  displaySize?: PngImageSize;
}

export interface ScreenshotMetadata {
  imageSize: PngImageSize;
  displaySize: PngImageSize;
  scale: typeof SCREENSHOT_SCALE;
  inputCoordinates: typeof IMAGE_PIXEL_COORDINATES;
}

export function sessionDisplaySize(
  desktop: { width?: number; height?: number } | undefined,
): PngImageSize | undefined {
  const width = desktop?.width;
  const height = desktop?.height;
  if (width === undefined || height === undefined || width < 1 || height < 1) {
    return undefined;
  }
  return { width, height };
}

function sameSize(left: PngImageSize, right: PngImageSize): boolean {
  return left.width === right.width && left.height === right.height;
}

export function screenshotMetadata(
  imageSize: PngImageSize,
  displaySize?: PngImageSize,
): ScreenshotMetadata {
  const resolvedDisplay = displaySize ?? imageSize;
  if (!sameSize(imageSize, resolvedDisplay)) {
    throw new Error("Framebuffer capture dimensions do not match the display; refusing scaled coordinate metadata");
  }
  return {
    imageSize,
    displaySize: resolvedDisplay,
    scale: SCREENSHOT_SCALE,
    inputCoordinates: IMAGE_PIXEL_COORDINATES,
  };
}

export async function queryDisplaySize(
  display: string,
  env?: EnvLike,
  timeoutMs = 2_000,
): Promise<PngImageSize | undefined> {
  if (timeoutMs <= 0 || findOnPath("xwininfo", env) === null) return undefined;
  const result = await runCommand("xwininfo", ["-root", "-display", display], {
    env,
    timeoutMs,
  });
  if (!result.ok) return undefined;
  const width = /Width:\s*(\d+)/.exec(result.stdout);
  const height = /Height:\s*(\d+)/.exec(result.stdout);
  if (width === null || height === null) return undefined;
  const size = { width: Number(width[1]), height: Number(height[1]) };
  if (size.width < 1 || size.height < 1) return undefined;
  return size;
}

export function detectScreenshotTool(
  env: EnvLike = process.env,
): ScreenshotTool | null {
  if (findOnPath("maim", env) !== null) {
    return "maim";
  }
  if (findOnPath("import", env) !== null) {
    return "import";
  }
  if (findOnPath("xwd", env) !== null && findOnPath("convert", env) !== null) {
    return "xwd";
  }
  if (findOnPath("scrot", env) !== null) {
    return "scrot";
  }
  return null;
}

export function buildScreenshotCommand(
  tool: ScreenshotTool,
  display: string,
  outPath: string,
  xwdDumpPath?: string,
): ScreenshotStep[] {
  parseDisplayNumber(display);
  switch (tool) {
    case "maim":
      return [
        {
          cmd: "maim",
          args: [outPath],
          requiresDisplayEnv: true,
        },
      ];
    case "import":
      return [
        {
          cmd: "import",
          args: ["-silent", "-display", display, "-window", "root", outPath],
        },
      ];
    case "xwd": {
      const dumpPath = xwdDumpPath ?? `${outPath}.xwd`;
      return [
        {
          cmd: "xwd",
          args: ["-root", "-silent", "-display", display, "-out", dumpPath],
        },
        {
          cmd: "convert",
          args: [`xwd:${dumpPath}`, `png:${outPath}`],
        },
      ];
    }
    case "scrot":
      return [
        {
          cmd: "scrot",
          args: ["--overwrite", outPath],
          requiresDisplayEnv: true,
        },
      ];
  }
}

async function assertPngFile(
  outPath: string,
  tool: ScreenshotTool,
): Promise<PngImageSize> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(outPath);
  } catch {
    throw new Error(
      `Screenshot command (${tool}) succeeded but produced no file at ${outPath}`,
    );
  }
  if (stat.size === 0) {
    throw new Error(
      `Screenshot command (${tool}) produced an empty file at ${outPath}`,
    );
  }
  try {
    return await readPngImageSize(outPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Screenshot command (${tool}) produced an invalid PNG at ${outPath}: ${detail}`,
    );
  }
}

async function runScreenshotSteps(
  steps: ScreenshotStep[],
  display: string,
  env: EnvLike | undefined,
  overallDeadline: number | undefined,
): Promise<void> {
  for (const step of steps) {
    const timeoutMs =
      overallDeadline === undefined
        ? SCREENSHOT_TIMEOUT_MS
        : overallDeadline - Date.now();
    if (timeoutMs <= 0) {
      throw new ObservationTimeoutError(`Screenshot command timed out before ${step.cmd} on ${display}`);
    }
    const result = await runCommand(step.cmd, step.args, {
      env: { ...env, DISPLAY: display },
      timeoutMs,
    });
    if (result.timedOut) throw new ObservationTimeoutError(`Screenshot command timed out: ${step.cmd}`);
    if (!result.ok) {
      const timedOut = result.timedOut ? ", timed out" : "";
      const detail = result.stderr.trim() || `exit code ${result.code}${timedOut}`;
      throw new Error(
        `Screenshot command failed (${step.cmd} ${step.args.join(" ")}): ${detail}`,
      );
    }
  }
}

async function screenshotWindowCount(
  display: string,
  env: EnvLike,
): Promise<{ windowCount: number | undefined; warnings: string[] }> {
  if (findOnPath("xdotool", env) === null) {
    return {
      windowCount: undefined,
      warnings: [
        "xdotool is missing from PATH; the client-window count is unavailable",
      ],
    };
  }
  return { windowCount: (await listWindows(display, env)).length, warnings: [] };
}

async function captureWithOwnedDump(
  opts: ScreenshotOptions, tool: ScreenshotTool, deadline: number | undefined,
): Promise<void> {
  if (tool !== "xwd") {
    return runScreenshotSteps(buildScreenshotCommand(tool, opts.display, opts.outPath), opts.display, opts.env, deadline);
  }
  const parent = await DirHandle.open(path.dirname(opts.outPath), { followFinal: true });
  const name = `capture-${crypto.randomBytes(12).toString("hex")}.xwd`;
  try {
    const file = await parent.openFile(name, "wx", 0o600);
    try {
      const owned = await file.stat();
      const dumpPath = parent.resolve(name).replace("/proc/self/", `/proc/${process.pid}/`);
      try {
        await runScreenshotSteps(buildScreenshotCommand(tool, opts.display, opts.outPath, dumpPath), opts.display, opts.env, deadline);
      } finally {
        await parent.unlinkOwnedFile(name, owned);
      }
    } finally { await file.close(); }
  } finally { await parent.close(); }
}

export async function screenshot(
  opts: ScreenshotOptions,
): Promise<ScreenshotResult> {
  const overallDeadline =
    opts.timeoutMs === undefined ? undefined : Date.now() + opts.timeoutMs;
  parseDisplayNumber(opts.display);
  const env = opts.env ?? process.env;
  const tool = opts.tool ?? detectScreenshotTool(env);
  if (tool === null) {
    throw new Error(
      "No screenshot tool found on PATH. Install one of: " +
        "maim (preferred), imagemagick (provides `import` and `convert`), " +
        "xorg-xwd (`xwd`, combined with imagemagick `convert`), or scrot.",
    );
  }

  await fs.promises.mkdir(path.dirname(opts.outPath), { recursive: true });
  await captureWithOwnedDump(opts, tool, overallDeadline);

  const imageSize = await assertPngFile(opts.outPath, tool);
  // Every supported capture command reads the full root framebuffer, without resizing.
  const displaySize = imageSize;
  const counted =
    opts.countWindows === false
      ? { windowCount: undefined, warnings: [] as string[] }
      : await screenshotWindowCount(opts.display, env);
  return {
    path: opts.outPath,
    tool,
    windowCount: counted.windowCount,
    warnings: counted.warnings,
    imageSize,
    displaySize,
  };
}
