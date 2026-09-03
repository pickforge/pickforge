import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runCommand, type EnvLike } from "@pickforge/lab-core";
import { parseDisplayNumber } from "./display.js";
import { findOnPath } from "./util.js";

const SCREENSHOT_TIMEOUT_MS = 20_000;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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
}

export interface ScreenshotResult {
  path: string;
  tool: ScreenshotTool;
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

async function assertPngFile(outPath: string, tool: ScreenshotTool): Promise<void> {
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
  const header = Buffer.alloc(PNG_MAGIC.length);
  const handle = await fs.promises.open(outPath, "r");
  try {
    await handle.read(header, 0, PNG_MAGIC.length, 0);
  } finally {
    await handle.close();
  }
  if (!header.equals(PNG_MAGIC)) {
    throw new Error(
      `Screenshot command (${tool}) produced a file without a PNG signature at ${outPath}`,
    );
  }
}

export async function screenshot(
  opts: ScreenshotOptions,
): Promise<ScreenshotResult> {
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
  const xwdDumpPath =
    tool === "xwd"
      ? `${opts.outPath}.${process.pid}-${crypto.randomBytes(4).toString("hex")}.xwd`
      : undefined;
  const steps = buildScreenshotCommand(
    tool,
    opts.display,
    opts.outPath,
    xwdDumpPath,
  );
  try {
    for (const step of steps) {
      const result = await runCommand(step.cmd, step.args, {
        env: { ...opts.env, DISPLAY: opts.display },
        timeoutMs: SCREENSHOT_TIMEOUT_MS,
      });
      if (!result.ok) {
        const detail = result.stderr.trim() || `exit code ${result.code}`;
        throw new Error(
          `Screenshot command failed (${step.cmd} ${step.args.join(" ")}): ${detail}`,
        );
      }
    }
  } finally {
    if (xwdDumpPath !== undefined) {
      await fs.promises.rm(xwdDumpPath, { force: true });
    }
  }

  await assertPngFile(opts.outPath, tool);
  return { path: opts.outPath, tool };
}
