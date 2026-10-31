import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { runCommand, type EnvLike } from "@pickforge/lab-core";
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
 *
 * A hyprlang config (pickforge/pickforge#228) gets the same rule through
 * `hyprctl keyword 'windowrule[<name>]:<field>' <value>` and the same
 * placement through the `resizewindowpixel` and `movewindowpixel` dispatchers.
 */

/** The compositor that owns the window, as the launcher found it. */
export type HyprlandContext = Pick<ViewerHyprlandLaunch, "hyprctl" | "instance" | "xdgRuntimeDir" | "provider">;

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

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const HYPRCTL_TIMEOUT_MS = 2_000;
const HYPRCTL_MAX_OUTPUT = 4 * 1024 * 1024;
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
export function viewerClassPattern(launchId: string, kind?: "native"): string {
  if (kind === "native") return `^pickforge-viewer-${launchId}$`;
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

/** Run hyprctl against one instance, as an argv array without a shell. */
export async function runHyprctl(ctx: HyprlandContext, args: string[]): Promise<string> {
  const result = await runCommand(ctx.hyprctl, ["--instance", ctx.instance, ...args], {
    env: { XDG_RUNTIME_DIR: ctx.xdgRuntimeDir, HYPRLAND_INSTANCE_SIGNATURE: ctx.instance },
    timeoutMs: HYPRCTL_TIMEOUT_MS,
    maxOutputBytes: HYPRCTL_MAX_OUTPUT,
  });
  if (!result.ok || result.stdoutTruncated) {
    throw new Error(`hyprctl ${args[0] ?? ""} failed`);
  }
  return result.stdout;
}

async function hyprctlJson(ctx: HyprlandContext, what: string): Promise<unknown> {
  return JSON.parse(await runHyprctl(ctx, ["-j", what])) as unknown;
}

/** Run one hyprctl request; true only when Hyprland answered `ok`. */
async function hyprctlOk(ctx: HyprlandContext, args: string[]): Promise<boolean> {
  try {
    return (await runHyprctl(ctx, args)).trim() === "ok";
  } catch {
    return false;
  }
}

/** Run Lua through `hyprctl eval`; true only when Hyprland answered `ok`. */
async function hyprctlEval(ctx: HyprlandContext, lua: string): Promise<boolean> {
  return hyprctlOk(ctx, ["eval", lua]);
}

/**
 * The config provider: `status` reports it from Hyprland 0.55. Hyprland 0.53
 * and 0.54 have no `status` request and only hyprlang, with named rules.
 */
async function configProvider(ctx: HyprlandContext): Promise<"lua" | "hyprlang" | undefined> {
  const status = await hyprctlJson(ctx, "status").catch(() => undefined);
  if (isRecord(status) && "configProvider" in status) {
    const provider = status.configProvider;
    return provider === "lua" || provider === "hyprlang" ? provider : undefined;
  }
  const version = await hyprctlJson(ctx, "version").catch(() => undefined);
  if (isRecord(version) && typeof version.version === "string" && /^0\.5[34]\./.test(version.version)) {
    return "hyprlang";
  }
  return undefined;
}

/**
 * The Hyprland instance this process runs under, when the adapter applies:
 * `HYPRLAND_INSTANCE_SIGNATURE` and `XDG_RUNTIME_DIR` are set, an absolute
 * hyprctl is on PATH, and the instance uses the Lua or the hyprlang config
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
  const provider = await configProvider(ctx);
  if (provider === undefined) return undefined;
  return provider === "hyprlang" ? { ...ctx, provider } : ctx;
}

function isHyprlang(ctx: HyprlandContext): boolean {
  return ctx.provider === "hyprlang";
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

function assertAddress(address: string): void {
  if (!ADDRESS_PATTERN.test(address)) {
    throw new Error("Refusing an invalid Hyprland client address");
  }
}

/** Lua that moves exactly one client, by address, without a resize. */
export function buildMoveLua(address: string, point: Pick<Rect, "x" | "y">): string {
  assertAddress(address);
  return `hl.dispatch(hl.dsp.window.move({x=${luaInt(point.x)},y=${luaInt(point.y)},window=${windowSelector(address)}}))`;
}

/** Lua that puts exactly one client above the other floating windows, without focus. */
export function buildRaiseLua(address: string): string {
  assertAddress(address);
  return `hl.dispatch(hl.dsp.window.alter_zorder({mode="top",window=${windowSelector(address)}}))`;
}

/** The hyprlang dispatcher for {@link buildRaiseLua}. */
export function buildRaiseDispatch(address: string): [string, string] {
  assertAddress(address);
  return ["alterzorder", `top,address:${address}`];
}

/** Lua that resizes and then moves exactly one client, by address. */
export function buildPlacementLua(address: string, rect: Rect): string {
  assertAddress(address);
  return (
    `hl.dispatch(hl.dsp.window.resize({x=${luaInt(rect.width)},y=${luaInt(rect.height)},window=${windowSelector(address)}})); ` +
    buildMoveLua(address, rect)
  );
}

/** The focused monitor when the rule is built, and its right and bottom reserved space. */
export interface RuleMonitor {
  name?: string;
  right: number;
  bottom: number;
}

/**
 * Lua for the launch rule: float, pin, no initial focus, the thumbnail size,
 * and the bottom-right corner of one monitor. The rule pins the window to the
 * monitor whose reserved space it uses, so focus that moves before the window
 * maps cannot put it on a monitor with other reserved space. `move` uses
 * Hyprland's monitor-relative expressions for that monitor.
 */
export function buildRuleInstallLua(
  ruleName: string,
  classPattern: string,
  size: ViewerWindowSize,
  monitor: RuleMonitor = { right: 0, bottom: 0 },
): string {
  const width = luaInt(size.width);
  const height = luaInt(size.height);
  const right = luaInt(THUMBNAIL_MARGIN + monitor.right);
  const bottom = luaInt(THUMBNAIL_MARGIN + monitor.bottom);
  const pinned = monitor.name === undefined ? "" : `monitor=${luaString(monitor.name)}, `;
  return (
    `hl.window_rule({name=${luaString(ruleName)}, match={class=${luaString(classPattern)}}, ` +
    `float=true, pin=true, no_initial_focus=true, ${pinned}size={${width},${height}}, ` +
    `move={${luaString(`(monitor_w-${width}-${right})`)},${luaString(`(monitor_h-${height}-${bottom})`)}}})`
  );
}

export function buildRuleDisableLua(ruleName: string): string {
  return `hl.window_rule({name=${luaString(ruleName)}, enabled=false})`;
}

/**
 * A hyprlang value for a `keyword` or `dispatch` request. Rejects control
 * characters, and `#`, which hyprlang reads as a comment.
 */
export function hyprlangValue(value: string): string {
  if (/[\u0000-\u001f\u007f#]/.test(value)) {
    throw new Error("Refusing a hyprlang value with control characters or #");
  }
  return value;
}

/** One `hyprctl keyword` request, as argv: the key, then the value. */
export type HyprlangKeyword = [key: string, value: string];

function ruleKey(ruleName: string, field: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(ruleName)) {
    throw new Error("Refusing an invalid Hyprland rule name");
  }
  return `windowrule[${ruleName}]:${field}`;
}

/**
 * Keywords for the hyprlang launch rule, with the same fields as the Lua
 * rule. Hyprland rebuilds its rules after every keyword, so the rule is
 * disabled first and enabled last: a window that maps in between never
 * meets a partial rule.
 */
export function buildRuleInstallKeywords(
  ruleName: string,
  classPattern: string,
  size: ViewerWindowSize,
  monitor: RuleMonitor = { right: 0, bottom: 0 },
): HyprlangKeyword[] {
  const width = luaInt(size.width);
  const height = luaInt(size.height);
  const right = luaInt(THUMBNAIL_MARGIN + monitor.right);
  const bottom = luaInt(THUMBNAIL_MARGIN + monitor.bottom);
  const fields: Array<[string, string]> = [
    ["enable", "false"],
    ["match:class", classPattern],
    ["float", "on"],
    ["pin", "on"],
    ["no_initial_focus", "on"],
    ...(monitor.name === undefined ? [] : [["monitor", monitor.name] as [string, string]]),
    ["size", `${width} ${height}`],
    ["move", `(monitor_w-${width}-${right}) (monitor_h-${height}-${bottom})`],
    ["enable", "true"],
  ];
  return fields.map(([field, value]) => [ruleKey(ruleName, field), hyprlangValue(value)]);
}

export function buildRuleDisableKeyword(ruleName: string): HyprlangKeyword {
  return [ruleKey(ruleName, "enable"), "false"];
}

/** Keywords for the hyprlang opacity rule, disabled first and enabled last. */
export function buildOpacityRuleKeywords(ruleName: string, classPattern: string): HyprlangKeyword[] {
  const name = opacityRuleName(ruleName);
  return [
    buildRuleDisableKeyword(name),
    [ruleKey(name, "match:class"), hyprlangValue(classPattern)],
    [ruleKey(name, "opacity"), "1 override 1 override"],
    [ruleKey(name, "enable"), "true"],
  ];
}

/** The dispatcher argument that moves exactly one client, by address, without a resize. */
export function buildMoveDispatch(address: string, point: Pick<Rect, "x" | "y">): [string, string] {
  assertAddress(address);
  return ["movewindowpixel", `exact ${luaInt(point.x)} ${luaInt(point.y)},address:${address}`];
}

/** Dispatcher arguments that resize and then move exactly one client, by address. */
export function buildPlacementDispatches(address: string, rect: Rect): Array<[string, string]> {
  assertAddress(address);
  return [
    ["resizewindowpixel", `exact ${luaInt(rect.width)} ${luaInt(rect.height)},address:${address}`],
    buildMoveDispatch(address, rect),
  ];
}

/**
 * Apply hyprlang rule keywords in order. When one is refused, the rule is
 * disabled again, so a failed install leaves no enabled rule.
 */
async function applyKeywords(ctx: HyprlandContext, ruleName: string, keywords: HyprlangKeyword[]): Promise<boolean> {
  for (const keyword of keywords) {
    if (!await hyprctlOk(ctx, ["keyword", ...keyword])) {
      await hyprctlOk(ctx, ["keyword", ...buildRuleDisableKeyword(ruleName)]);
      return false;
    }
  }
  return true;
}

function opacityRuleName(ruleName: string): string {
  return `${ruleName}-opacity`;
}

/**
 * Lua for a rule that keeps the viewer fully opaque when the config dims
 * other windows. Hyprland re-evaluates opacity while the window lives, so this
 * rule stays enabled after the launch rule is disabled.
 */
export function buildOpacityRuleLua(ruleName: string, classPattern: string): string {
  return (
    `hl.window_rule({name=${luaString(opacityRuleName(ruleName))}, match={class=${luaString(classPattern)}}, ` +
    `opacity="1 override 1 override"})`
  );
}

async function focusedMonitor(ctx: HyprlandContext): Promise<RuleMonitor> {
  try {
    const monitors = await hyprctlJson(ctx, "monitors");
    const focused = Array.isArray(monitors)
      ? monitors.find((entry) => isRecord(entry) && entry.focused === true)
      : undefined;
    if (!isRecord(focused)) return { right: 0, bottom: 0 };
    const [, , right, bottom] = parseReserved(focused.reserved);
    const name = typeof focused.name === "string" && focused.name !== "" ? focused.name : undefined;
    return { name, right: Math.max(0, Math.round(right)), bottom: Math.max(0, Math.round(bottom)) };
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
  const monitor = await focusedMonitor(ctx);
  if (isHyprlang(ctx)) {
    let keywords: HyprlangKeyword[];
    try {
      keywords = buildRuleInstallKeywords(ruleName, classPattern, size, monitor);
    } catch {
      return false;
    }
    if (!await applyKeywords(ctx, ruleName, keywords)) return false;
    // Opacity is cosmetic, so a refused opacity rule does not fail placement.
    await applyKeywords(ctx, opacityRuleName(ruleName), buildOpacityRuleKeywords(ruleName, classPattern));
    return true;
  }
  if (!await hyprctlEval(ctx, buildRuleInstallLua(ruleName, classPattern, size, monitor))) return false;
  // Opacity is cosmetic, so a refused opacity rule does not fail placement.
  await hyprctlEval(ctx, buildOpacityRuleLua(ruleName, classPattern));
  return true;
}

async function disableRule(ctx: HyprlandContext, ruleName: string): Promise<boolean> {
  if (isHyprlang(ctx)) return hyprctlOk(ctx, ["keyword", ...buildRuleDisableKeyword(ruleName)]);
  return hyprctlEval(ctx, buildRuleDisableLua(ruleName));
}

/** Disable the named launch rule. It stays registered until a config reload. */
export async function disableViewerRule(ctx: HyprlandContext, ruleName: string): Promise<boolean> {
  return disableRule(ctx, ruleName);
}

/** Disable the opacity rule once the viewer window is gone. */
export async function disableViewerOpacityRule(ctx: HyprlandContext, ruleName: string): Promise<boolean> {
  return disableRule(ctx, opacityRuleName(ruleName));
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

async function dispatchAll(ctx: HyprlandContext, dispatches: Array<[string, string]>): Promise<boolean> {
  for (const dispatch of dispatches) {
    if (!await hyprctlOk(ctx, ["dispatch", ...dispatch])) return false;
  }
  return true;
}

async function readMonitor(ctx: HyprlandContext, id: number): Promise<HyprlandMonitor | undefined> {
  const monitors = parseList(await hyprctlJson(ctx, "monitors"), parseMonitor);
  return monitors.find((monitor) => monitor.id === id);
}

/**
 * This launch's window when it is safe to dispatch to: it matches the launch
 * class pattern and the recorded process pid, and it is floating (the launch
 * rule floated it), so a dispatch never reaches another window or rearranges
 * a tiled layout. Also returns the work area of the client's monitor.
 */
async function verifiedViewerWindow(
  ctx: HyprlandContext & Pick<ViewerHyprlandLaunch, "classPattern">,
  pid: number | undefined,
): Promise<{ client: HyprlandClient; area: Rect } | undefined> {
  const client = await findViewerWindow(ctx, ctx.classPattern, pid);
  if (client === undefined || !client.floating) return undefined;
  const monitor = await readMonitor(ctx, client.monitor);
  return monitor === undefined ? undefined : { client, area: monitorWorkArea(monitor) };
}

/**
 * Resize and place this launch's window for `mode` through the compositor.
 * Resolves true when applied, false when the launch has no Hyprland context
 * or the window cannot be verified. Never throws for an absent window.
 * `onPlaced` gets the applied rect and the client's monitor id.
 */
export async function applyHyprlandWindowMode(
  launch: ViewerLaunchRecord,
  mode: ViewerWindowMode,
  onPlaced?: (rect: Rect, monitor: number) => void,
): Promise<boolean> {
  const ctx = launch.hyprland;
  if (ctx === undefined) return false;
  try {
    const found = await verifiedViewerWindow(ctx, launch.pid);
    if (found === undefined) return false;
    const rect = placeViewerWindow(launch, mode, found.area);
    const applied = isHyprlang(ctx)
      ? await dispatchAll(ctx, buildPlacementDispatches(found.client.address, rect))
      : await hyprctlEval(ctx, buildPlacementLua(found.client.address, rect));
    if (!applied) return false;
    // A placed window goes on top, so a collapsed card is the visible front
    // card. The raise is cosmetic, so its failure never fails the placement.
    await raiseClient(ctx, found.client.address);
    onPlaced?.(rect, found.client.monitor);
    return true;
  } catch {
    return false;
  }
}

function raiseClient(ctx: HyprlandContext, address: string): Promise<boolean> {
  return isHyprlang(ctx)
    ? dispatchAll(ctx, [buildRaiseDispatch(address)])
    : hyprctlEval(ctx, buildRaiseLua(address));
}

/** Raise this launch's own verified window without focus. True when applied. */
export async function raiseHyprlandViewerWindow(launch: ViewerLaunchRecord): Promise<boolean> {
  const ctx = launch.hyprland;
  if (ctx === undefined) return false;
  try {
    const found = await verifiedViewerWindow(ctx, launch.pid);
    return found !== undefined && await raiseClient(ctx, found.client.address);
  } catch {
    return false;
  }
}

/**
 * Move this launch's own window without a resize. The window is verified like
 * in {@link applyHyprlandWindowMode}. `place` gets the work area and the
 * monitor id of the client and returns the target position, or undefined to
 * leave the window where it is. Resolves true only when a move was applied.
 */
export async function moveHyprlandViewerWindow(
  launch: ViewerLaunchRecord,
  place: (area: Rect, monitor: number) => Pick<Rect, "x" | "y"> | undefined,
): Promise<boolean> {
  const ctx = launch.hyprland;
  if (ctx === undefined) return false;
  try {
    const found = await verifiedViewerWindow(ctx, launch.pid);
    if (found === undefined) return false;
    const point = place(found.area, found.client.monitor);
    if (point === undefined) return false;
    return isHyprlang(ctx)
      ? await dispatchAll(ctx, [buildMoveDispatch(found.client.address, point)])
      : await hyprctlEval(ctx, buildMoveLua(found.client.address, point));
  } catch {
    return false;
  }
}
