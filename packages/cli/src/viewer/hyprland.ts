import { execFile } from "node:child_process";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { EnvLike } from "@pickforge/lab-core";
import {
  findOnPath,
  type ViewerHyprlandLaunch,
  type ViewerLaunchRecord,
  type ViewerWindowSize,
} from "@pickforge/lab-desktop-linux";
import type { ViewerWindowMode } from "./contract.js";

/**
 * Hyprland adapter for the passive viewer window (pickforge/pickforge#207).
 *
 * Verified against Hyprland 0.56 with a Lua config: `hyprctl keyword` is
 * rejected there, so every change goes through `hyprctl eval '<lua>'`. A
 * runtime rule floats, pins and places the window at map time without
 * giving it focus; Lua has no rule delete, so cleanup disables the named
 * rule. Later resizes use dispatchers on the exact client address, because
 * `window.resizeTo` does not change a Hyprland window's real size.
 */

/** The compositor that owns the window, as the launcher found it. */
export type HyprlandContext = Pick<ViewerHyprlandLaunch, "hyprctl" | "instance" | "xdgRuntimeDir">;

export interface HyprlandClient {
  address: string;
  class: string;
  pid: number;
  floating: boolean;
  monitor: number;
}

interface HyprlandMonitor {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  transform: number;
  reserved: [number, number, number, number];
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const HYPRCTL_TIMEOUT_MS = 2_000;
const HYPRCTL_MAX_BUFFER = 4 * 1024 * 1024;
const INSTANCE_PATTERN = /^[A-Za-z0-9_]+$/;
const ADDRESS_PATTERN = /^0x[0-9a-f]+$/;
/** Space between the thumbnail and the screen edges, in logical pixels. */
export const THUMBNAIL_MARGIN = 24;
/** The expanded window never covers more than this share of the work area. */
export const EXPANDED_SCREEN_SHARE = 0.9;
export const WINDOW_WAIT_MS = 10_000;
const WINDOW_POLL_MS = 200;

export function hyprlandRuleName(launchId: string): string {
  return `pickforge-viewer-${launchId}`;
}

/**
 * Anchored class pattern for one launch. Chromium on Wayland derives the
 * app id from the `--app` URL host and path plus the profile name and
 * ignores `--class`; under X11 (XWayland) the class is the `--class` value.
 * The launch id is lowercase hex, so it needs no regex escaping.
 */
export function viewerClassPattern(launchId: string): string {
  return `^(chrome-127\\.0\\.0\\.1__viewer_${launchId}-Default|pickforge-viewer-${launchId})$`;
}

/** A Lua string literal. Rejects control characters instead of escaping them. */
export function luaString(value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Refusing a Lua string with control characters");
  }
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

/** A Lua integer literal. Only safe integers are ever emitted. */
export function luaInt(value: number): string {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Refusing a non-integer Lua number: ${String(value)}`);
  }
  return String(value);
}

function hyprctlEnv(ctx: HyprlandContext): NodeJS.ProcessEnv {
  return {
    ...process.env,
    XDG_RUNTIME_DIR: ctx.xdgRuntimeDir,
    HYPRLAND_INSTANCE_SIGNATURE: ctx.instance,
  };
}

/** Run hyprctl against one instance, as an argv array without a shell. */
export function runHyprctl(ctx: HyprlandContext, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      ctx.hyprctl,
      ["--instance", ctx.instance, ...args],
      {
        env: hyprctlEnv(ctx),
        shell: false,
        timeout: HYPRCTL_TIMEOUT_MS,
        maxBuffer: HYPRCTL_MAX_BUFFER,
        encoding: "utf8",
      },
      (error, stdout) => {
        if (error !== null) reject(error);
        else resolve(stdout);
      },
    );
  });
}

async function hyprctlJson(ctx: HyprlandContext, what: string): Promise<unknown> {
  return JSON.parse(await runHyprctl(ctx, ["-j", what])) as unknown;
}

/** Run Lua through `hyprctl eval`; true only when Hyprland answered `ok`. */
async function hyprctlEval(ctx: HyprlandContext, lua: string): Promise<boolean> {
  try {
    return (await runHyprctl(ctx, ["eval", lua])).trim() === "ok";
  } catch {
    return false;
  }
}

/**
 * The Hyprland instance this process runs under, when the adapter applies:
 * `HYPRLAND_INSTANCE_SIGNATURE` and `XDG_RUNTIME_DIR` are set, an absolute
 * hyprctl is on PATH, and `hyprctl -j status` reports the Lua config
 * provider. Anything else gets an ordinary window.
 */
export async function detectHyprland(env: EnvLike = process.env): Promise<HyprlandContext | undefined> {
  const instance = env.HYPRLAND_INSTANCE_SIGNATURE;
  const xdgRuntimeDir = env.XDG_RUNTIME_DIR;
  if (instance === undefined || !INSTANCE_PATTERN.test(instance)) return undefined;
  if (xdgRuntimeDir === undefined || !path.isAbsolute(xdgRuntimeDir)) return undefined;
  const hyprctl = findOnPath("hyprctl", env);
  if (hyprctl === null || !path.isAbsolute(hyprctl)) return undefined;
  const ctx = { hyprctl, instance, xdgRuntimeDir };
  try {
    const status = await hyprctlJson(ctx, "status");
    return (status as { configProvider?: unknown }).configProvider === "lua" ? ctx : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseClient(value: unknown): HyprlandClient | undefined {
  if (!isRecord(value)) return undefined;
  const { address, pid, floating, monitor } = value;
  const windowClass = value.class;
  if (typeof address !== "string" || !ADDRESS_PATTERN.test(address)) return undefined;
  if (typeof windowClass !== "string" || !isNumber(pid) || !isNumber(monitor)) return undefined;
  return { address, class: windowClass, pid, floating: floating === true, monitor };
}

function parseReserved(value: unknown): [number, number, number, number] {
  if (Array.isArray(value) && value.length === 4 && value.every(isNumber)) {
    return [value[0], value[1], value[2], value[3]];
  }
  return [0, 0, 0, 0];
}

function parseMonitor(value: unknown): HyprlandMonitor | undefined {
  if (!isRecord(value)) return undefined;
  const { id, x, y, width, height, scale, transform } = value;
  if (![id, x, y, width, height].every(isNumber)) return undefined;
  const validScale = isNumber(scale) && scale > 0 ? scale : 1;
  return {
    id: id as number,
    x: x as number,
    y: y as number,
    width: width as number,
    height: height as number,
    scale: validScale,
    transform: isNumber(transform) ? transform : 0,
    reserved: parseReserved(value.reserved),
  };
}

function parseList<T>(value: unknown, parse: (entry: unknown) => T | undefined): T[] {
  if (!Array.isArray(value)) return [];
  return value.map(parse).filter((entry): entry is T => entry !== undefined);
}

/** This launch's mapped window: class match, and the browser pid when known. */
export async function findViewerWindow(
  ctx: HyprlandContext,
  classPattern: string,
  pid: number | undefined,
): Promise<HyprlandClient | undefined> {
  const matcher = new RegExp(classPattern);
  const clients = parseList(await hyprctlJson(ctx, "clients"), parseClient);
  return clients.find(
    (client) => matcher.test(client.class) && (pid === undefined || client.pid === pid),
  );
}

/**
 * The monitor's work area in logical layout pixels: the mode size divided
 * by the scale, swapped for 90 and 270 degree transforms, minus the
 * reserved areas (left, top, right, bottom) that bars claim.
 */
export function monitorWorkArea(monitor: HyprlandMonitor): Rect {
  const rotated = monitor.transform % 2 === 1;
  const width = Math.floor((rotated ? monitor.height : monitor.width) / monitor.scale);
  const height = Math.floor((rotated ? monitor.width : monitor.height) / monitor.scale);
  const [left, top, right, bottom] = monitor.reserved;
  return {
    x: monitor.x + left,
    y: monitor.y + top,
    width: Math.max(1, width - left - right),
    height: Math.max(1, height - top - bottom),
  };
}

/** Scale a size down uniformly so it fits inside the bounds. */
function fitSize(size: ViewerWindowSize, maxWidth: number, maxHeight: number): ViewerWindowSize {
  const factor = Math.min(1, maxWidth / size.width, maxHeight / size.height);
  return {
    width: Math.max(1, Math.floor(size.width * factor)),
    height: Math.max(1, Math.floor(size.height * factor)),
  };
}

/** Where the window goes for `mode`, in global layout coordinates. */
export function placeViewerWindow(
  launch: Pick<ViewerLaunchRecord, "thumbnail" | "expanded">,
  mode: ViewerWindowMode,
  area: Rect,
): Rect {
  if (mode === "expanded") {
    const size = fitSize(
      launch.expanded,
      Math.floor(area.width * EXPANDED_SCREEN_SHARE),
      Math.floor(area.height * EXPANDED_SCREEN_SHARE),
    );
    return {
      ...size,
      x: area.x + Math.floor((area.width - size.width) / 2),
      y: area.y + Math.floor((area.height - size.height) / 2),
    };
  }
  const size = fitSize(
    launch.thumbnail,
    area.width - 2 * THUMBNAIL_MARGIN,
    area.height - 2 * THUMBNAIL_MARGIN,
  );
  return {
    ...size,
    x: area.x + area.width - size.width - THUMBNAIL_MARGIN,
    y: area.y + area.height - size.height - THUMBNAIL_MARGIN,
  };
}

function windowSelector(address: string): string {
  return luaString(`address:${address}`);
}

/** Lua that resizes and then moves exactly one client, by address. */
export function buildPlacementLua(address: string, rect: Rect): string {
  if (!ADDRESS_PATTERN.test(address)) {
    throw new Error("Refusing an invalid Hyprland client address");
  }
  const target = windowSelector(address);
  return (
    `hl.dispatch(hl.dsp.window.resize({x=${luaInt(rect.width)},y=${luaInt(rect.height)},window=${target}})); ` +
    `hl.dispatch(hl.dsp.window.move({x=${luaInt(rect.x)},y=${luaInt(rect.y)},window=${target}}))`
  );
}

/**
 * Lua for the launch rule: float, pin, no initial focus, the thumbnail size,
 * and the bottom-right corner of the monitor the window opens on. `move`
 * uses Hyprland's monitor-relative expressions, so the rule follows the
 * monitor; `reserved` is the right and bottom reserved space of the focused
 * monitor when the rule was built.
 */
export function buildRuleInstallLua(
  ruleName: string,
  classPattern: string,
  size: ViewerWindowSize,
  reserved: { right: number; bottom: number } = { right: 0, bottom: 0 },
): string {
  const width = luaInt(size.width);
  const height = luaInt(size.height);
  const right = luaInt(THUMBNAIL_MARGIN + reserved.right);
  const bottom = luaInt(THUMBNAIL_MARGIN + reserved.bottom);
  return (
    `hl.window_rule({name=${luaString(ruleName)}, match={class=${luaString(classPattern)}}, ` +
    `float=true, pin=true, no_initial_focus=true, size={${width},${height}}, ` +
    `move={${luaString(`(monitor_w-${width}-${right})`)},${luaString(`(monitor_h-${height}-${bottom})`)}}})`
  );
}

export function buildRuleDisableLua(ruleName: string): string {
  return `hl.window_rule({name=${luaString(ruleName)}, enabled=false})`;
}

async function focusedReserved(ctx: HyprlandContext): Promise<{ right: number; bottom: number }> {
  try {
    const monitors = await hyprctlJson(ctx, "monitors");
    const focused = Array.isArray(monitors)
      ? monitors.find((entry) => isRecord(entry) && entry.focused === true)
      : undefined;
    const [, , right, bottom] = parseReserved(isRecord(focused) ? focused.reserved : undefined);
    return { right: Math.max(0, Math.round(right)), bottom: Math.max(0, Math.round(bottom)) };
  } catch {
    return { right: 0, bottom: 0 };
  }
}

/** Install the named launch rule. Resolves false when Hyprland refused it. */
export async function installViewerRule(
  ctx: HyprlandContext,
  ruleName: string,
  classPattern: string,
  size: ViewerWindowSize,
): Promise<boolean> {
  const reserved = await focusedReserved(ctx);
  return hyprctlEval(ctx, buildRuleInstallLua(ruleName, classPattern, size, reserved));
}

/** Disable the named launch rule. It stays registered until a config reload. */
export async function disableViewerRule(ctx: HyprlandContext, ruleName: string): Promise<boolean> {
  return hyprctlEval(ctx, buildRuleDisableLua(ruleName));
}

export interface WaitForViewerWindowOptions {
  timeoutMs?: number;
  pollMs?: number;
  /** Stop waiting early once this returns true (the browser exited). */
  stopped?: () => boolean;
}

/** Poll `hyprctl -j clients` until this launch's window maps, or give up. */
export async function waitForViewerWindow(
  ctx: HyprlandContext,
  classPattern: string,
  pid: number | undefined,
  opts: WaitForViewerWindowOptions = {},
): Promise<HyprlandClient | undefined> {
  const deadline = Date.now() + (opts.timeoutMs ?? WINDOW_WAIT_MS);
  const pollMs = opts.pollMs ?? WINDOW_POLL_MS;
  while (opts.stopped?.() !== true) {
    const found = await findViewerWindow(ctx, classPattern, pid).catch(() => undefined);
    if (found !== undefined) return found;
    if (Date.now() + pollMs > deadline) return undefined;
    await sleep(pollMs);
  }
  return undefined;
}

async function readMonitor(ctx: HyprlandContext, id: number): Promise<HyprlandMonitor | undefined> {
  const monitors = parseList(await hyprctlJson(ctx, "monitors"), parseMonitor);
  return monitors.find((monitor) => monitor.id === id);
}

/**
 * Resize and place this launch's window for `mode` through the compositor.
 * Resolves true when applied, false when the launch has no Hyprland context
 * or the window cannot be verified. Never throws for an absent window.
 *
 * The window must match the launch class pattern and the recorded browser
 * pid, and must be floating (the launch rule floated it), so a dispatch
 * never reaches another window or rearranges a tiled layout.
 */
export async function applyHyprlandWindowMode(
  launch: ViewerLaunchRecord,
  mode: ViewerWindowMode,
): Promise<boolean> {
  const ctx = launch.hyprland;
  if (ctx === undefined) return false;
  try {
    const client = await findViewerWindow(ctx, ctx.classPattern, launch.pid);
    if (client === undefined || !client.floating) return false;
    const monitor = await readMonitor(ctx, client.monitor);
    if (monitor === undefined) return false;
    const rect = placeViewerWindow(launch, mode, monitorWorkArea(monitor));
    return await hyprctlEval(ctx, buildPlacementLua(client.address, rect));
  } catch {
    return false;
  }
}
