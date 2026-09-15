import { redactSecrets, runCommand, sanitizeErrorText, withAgentPermit, type EnvLike } from "@pickforge/lab-core";
import { listWindows, type WindowInfo } from "./apps.js";
import { parseDisplayNumber } from "./display.js";

export interface DesktopWindow extends WindowInfo {
  class: string;
  geometry: { x: number; y: number; width: number; height: number };
  focused: boolean;
}

export interface WindowSelector {
  id?: string;
  name?: string;
}

export const MAX_FOCUS_TIMEOUT_MS = 10_000;

async function query(display: string, args: string[], env?: EnvLike, timeoutMs = 2_000, command = "xdotool"): Promise<string> {
  parseDisplayNumber(display);
  try {
    const result = await runCommand(command, args, {
      env: { ...env, DISPLAY: display }, timeoutMs, check: true,
    });
    return result.stdout.replace(/\n$/, "");
  } catch (error) {
    throw new Error(sanitizeErrorText(error instanceof Error ? error.message : String(error)));
  }
}

/** X input focus, not EWMH active-window state. Works without a window manager. */
async function focusedWindow(display: string, env?: EnvLike, timeoutMs = 2_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const raw = await query(display, ["getwindowfocus", "-f"], env, timeoutMs);
  // None and PointerRoot have no WM_CLASS parent to traverse.
  if (raw === "0" || raw === "1") return raw;
  // The default query maps toolkit child focus to its WM_CLASS-bearing client.
  return query(display, ["getwindowfocus"], env, Math.max(1, deadline - Date.now()));
}

function geometryFromShell(output: string): DesktopWindow["geometry"] {
  const values = Object.fromEntries(output.split("\n").map((line) => line.split("=")));
  const geometry = {
    x: Number(values.X), y: Number(values.Y),
    width: Number(values.WIDTH), height: Number(values.HEIGHT),
  };
  if (!Object.values(geometry).every(Number.isSafeInteger) || geometry.width < 0 || geometry.height < 0) {
    throw new Error("Invalid xdotool window geometry");
  }
  return geometry;
}

async function windowClass(display: string, id: string, env?: EnvLike): Promise<string> {
  // Ubuntu's xdotool 3 has no getwindowclassname. Read the standard WM_CLASS
  // resource class (second string) with xprop; C locale makes byte escaping stable.
  const output = await query(display, ["-id", id, "WM_CLASS"], { ...env, LC_ALL: "C" }, 2_000, "xprop");
  const match = /^WM_CLASS\(STRING\) = "(?:[^"\\]|\\(?:[0-7]{3}|["\\nt]))*", "((?:[^"\\]|\\(?:[0-7]{3}|["\\nt]))*)"$/.exec(output);
  if (match === null) throw new Error("Invalid or missing xprop WM_CLASS string pair");
  const escapes: Record<string, string> = { n: "\n", t: "\t", '"': '"', "\\": "\\" };
  const bytes = match[1]!.replace(/\\([0-7]{3}|["\\nt])/g, (_, value: string) =>
    escapes[value] ?? String.fromCharCode(Number.parseInt(value, 8)),
  );
  return Buffer.from(bytes, "latin1").toString("utf8");
}

/** Opt-in details; screenshot and execApp retain the lightweight listWindows API. */
export async function desktopWindows(display: string, env?: EnvLike): Promise<DesktopWindow[]> {
  const windows = await listWindows(display, env);
  if (windows.length === 0) return [];
  const focused = await focusedWindow(display, env);
  const result: DesktopWindow[] = [];
  for (const window of windows) {
    const className = await windowClass(display, window.id, env);
    const geometry = geometryFromShell(await query(display, ["getwindowgeometry", "--shell", window.id], env));
    result.push({ id: window.id, name: redactSecrets(window.name), class: redactSecrets(className), geometry, focused: window.id === focused });
  }
  return result;
}

export async function selectDesktopWindow(display: string, selector: WindowSelector, env?: EnvLike): Promise<WindowInfo> {
  if ((selector.id === undefined) === (selector.name === undefined)) {
    throw new Error("Specify exactly one window id or exact name");
  }
  if (selector.id !== undefined && !/^[1-9]\d*$/.test(selector.id)) {
    throw new Error("Window id must be a positive decimal X11 id");
  }
  if (selector.name === "") throw new Error("Window name must not be empty");
  const matches = (await listWindows(display, env)).filter((window) =>
    selector.id === undefined ? window.name === selector.name : window.id === selector.id,
  );
  if (matches.length === 0) throw new Error("No visible window matches the selector");
  if (matches.length !== 1) throw new Error("Ambiguous window name; select a window id instead");
  return matches[0]!;
}

export interface FocusWindowOptions {
  display: string;
  sessionId: string;
  window: WindowInfo;
  timeoutMs?: number;
  env?: EnvLike;
}

/** Keep the permit through identity recheck, mutation and bounded confirmation. */
export async function focusWindow(opts: FocusWindowOptions): Promise<WindowInfo & { focused: true }> {
  const timeoutMs = opts.timeoutMs ?? 2_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_FOCUS_TIMEOUT_MS) {
    throw new Error(`Focus timeout must be an integer in 1-${MAX_FOCUS_TIMEOUT_MS}ms`);
  }
  return withAgentPermit(opts.sessionId, opts.env ?? process.env, async () => {
    const current = await selectDesktopWindow(opts.display, { id: opts.window.id }, opts.env);
    if (current.name !== opts.window.name) throw new Error("Window identity changed before focus");
    const deadline = Date.now() + timeoutMs;
    await query(opts.display, ["windowfocus", current.id], opts.env, timeoutMs);
    while (Date.now() < deadline) {
      if (await focusedWindow(opts.display, opts.env, Math.max(1, deadline - Date.now())) === current.id) {
        return { id: current.id, name: redactSecrets(current.name), focused: true };
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(0, deadline - Date.now()))));
    }
    throw new Error(`Window focus timed out after ${timeoutMs}ms`);
  });
}
