import { runCommand, withAgentPermit, type EnvLike } from "@pickforge/lab-core";
import { parseDisplayNumber } from "./display.js";

const TYPE_DELAY_MS = 50;
const SCROLL_STEP_DELAY_MS = 25;
const DEFAULT_DOUBLE_CLICK_INTERVAL_MS = 100;
const DEFAULT_DRAG_DURATION_MS = 300;
const INPUT_TIMEOUT_MS = 10_000;
const TYPE_TIMEOUT_MS = 60_000;

export const MAX_SCROLL_STEPS = 100;
export const MAX_DRAG_DURATION_MS = 10_000;
export const MAX_DOUBLE_CLICK_INTERVAL_MS = 2_000;

const SCROLL_BUTTON_UP = 4;
const SCROLL_BUTTON_DOWN = 5;
const SCROLL_BUTTON_LEFT = 6;
const SCROLL_BUTTON_RIGHT = 7;

export interface ClickArgsOptions {
  x: number;
  y: number;
  button?: number;
}

export interface ClickOptions extends ClickArgsOptions {
  display: string;
  sessionId: string;
  env?: EnvLike;
}

export interface MoveArgsOptions {
  x: number;
  y: number;
}

export interface MoveOptions extends MoveArgsOptions {
  display: string;
  sessionId: string;
  env?: EnvLike;
}

export interface ScrollArgsOptions {
  deltaX: number;
  deltaY: number;
  x?: number;
  y?: number;
}

export interface ScrollOptions extends ScrollArgsOptions {
  display: string;
  sessionId: string;
  env?: EnvLike;
}

export interface DragArgsOptions {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  button?: number;
  durationMs?: number;
}

export interface DragOptions extends DragArgsOptions {
  display: string;
  sessionId: string;
  env?: EnvLike;
}

export interface DoubleClickArgsOptions {
  x: number;
  y: number;
  button?: number;
  intervalMs?: number;
}

export interface DoubleClickOptions extends DoubleClickArgsOptions {
  display: string;
  sessionId: string;
  env?: EnvLike;
}

export interface TypeTextOptions {
  display: string;
  text: string;
  sessionId: string;
  env?: EnvLike;
}

export interface PressKeyOptions {
  display: string;
  key: string;
  sessionId: string;
  env?: EnvLike;
}

function assertCoordinate(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `Invalid ${label} coordinate ${value}: expected a non-negative integer`,
    );
  }
}

function assertButton(button: number): void {
  if (!Number.isInteger(button) || button < 1 || button > 9) {
    throw new Error(`Invalid button ${button}: expected an integer in 1-9`);
  }
}

function assertScrollDelta(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new Error(`Invalid ${label} ${value}: expected an integer`);
  }
  if (Math.abs(value) > MAX_SCROLL_STEPS) {
    throw new Error(
      `Invalid ${label} ${value}: expected at most ${MAX_SCROLL_STEPS} wheel steps per call`,
    );
  }
}

function msToSeconds(ms: number): string {
  return String(ms / 1000);
}

export function buildClickArgs(opts: ClickArgsOptions): string[] {
  assertCoordinate(opts.x, "x");
  assertCoordinate(opts.y, "y");
  const button = opts.button ?? 1;
  assertButton(button);
  return [
    "mousemove",
    "--sync",
    String(opts.x),
    String(opts.y),
    "click",
    String(button),
  ];
}

export function buildMoveArgs(opts: MoveArgsOptions): string[] {
  assertCoordinate(opts.x, "x");
  assertCoordinate(opts.y, "y");
  return ["mousemove", "--sync", String(opts.x), String(opts.y)];
}

function scrollClickArgs(steps: number, button: number): string[] {
  const args = ["click"];
  if (steps > 1) {
    args.push("--repeat", String(steps), "--delay", String(SCROLL_STEP_DELAY_MS));
  }
  args.push(String(button));
  return args;
}

export function buildScrollArgs(opts: ScrollArgsOptions): string[] {
  assertScrollDelta(opts.deltaX, "deltaX");
  assertScrollDelta(opts.deltaY, "deltaY");
  if (opts.deltaX === 0 && opts.deltaY === 0) {
    throw new Error(
      "Invalid scroll deltas: expected a non-zero deltaX and/or deltaY",
    );
  }
  if ((opts.x === undefined) !== (opts.y === undefined)) {
    throw new Error(
      "Invalid scroll position: expected both x and y, or neither",
    );
  }
  const args: string[] = [];
  if (opts.x !== undefined && opts.y !== undefined) {
    assertCoordinate(opts.x, "x");
    assertCoordinate(opts.y, "y");
    args.push("mousemove", "--sync", String(opts.x), String(opts.y));
  }
  if (opts.deltaX !== 0) {
    args.push(
      ...scrollClickArgs(
        Math.abs(opts.deltaX),
        opts.deltaX > 0 ? SCROLL_BUTTON_RIGHT : SCROLL_BUTTON_LEFT,
      ),
    );
  }
  if (opts.deltaY !== 0) {
    args.push(
      ...scrollClickArgs(
        Math.abs(opts.deltaY),
        opts.deltaY > 0 ? SCROLL_BUTTON_DOWN : SCROLL_BUTTON_UP,
      ),
    );
  }
  return args;
}

export function buildDragArgs(opts: DragArgsOptions): string[] {
  assertCoordinate(opts.fromX, "fromX");
  assertCoordinate(opts.fromY, "fromY");
  assertCoordinate(opts.toX, "toX");
  assertCoordinate(opts.toY, "toY");
  const button = opts.button ?? 1;
  assertButton(button);
  const durationMs = opts.durationMs ?? DEFAULT_DRAG_DURATION_MS;
  if (
    !Number.isInteger(durationMs) ||
    durationMs < 0 ||
    durationMs > MAX_DRAG_DURATION_MS
  ) {
    throw new Error(
      `Invalid durationMs ${durationMs}: expected an integer in 0-${MAX_DRAG_DURATION_MS}`,
    );
  }
  const halfSleep = msToSeconds(durationMs / 2);
  return [
    "mousemove",
    "--sync",
    String(opts.fromX),
    String(opts.fromY),
    "mousedown",
    String(button),
    "sleep",
    halfSleep,
    "mousemove",
    "--sync",
    String(opts.toX),
    String(opts.toY),
    "sleep",
    halfSleep,
    "mouseup",
    String(button),
  ];
}

export function buildDoubleClickArgs(opts: DoubleClickArgsOptions): string[] {
  assertCoordinate(opts.x, "x");
  assertCoordinate(opts.y, "y");
  const button = opts.button ?? 1;
  assertButton(button);
  const intervalMs = opts.intervalMs ?? DEFAULT_DOUBLE_CLICK_INTERVAL_MS;
  if (
    !Number.isInteger(intervalMs) ||
    intervalMs < 0 ||
    intervalMs > MAX_DOUBLE_CLICK_INTERVAL_MS
  ) {
    throw new Error(
      `Invalid intervalMs ${intervalMs}: expected an integer in ` +
        `0-${MAX_DOUBLE_CLICK_INTERVAL_MS}`,
    );
  }
  return [
    "mousemove",
    "--sync",
    String(opts.x),
    String(opts.y),
    "click",
    "--repeat",
    "2",
    "--delay",
    String(intervalMs),
    String(button),
  ];
}

export function buildTypeArgs(text: string): string[] {
  if (text === "") {
    throw new Error("Invalid text: expected a non-empty string");
  }
  return ["type", "--delay", String(TYPE_DELAY_MS), "--", text];
}

export function buildKeyArgs(key: string): string[] {
  if (key === "") {
    throw new Error("Invalid key: expected a non-empty string");
  }
  return ["key", "--", key];
}

async function runXdotool(
  display: string,
  args: string[],
  timeoutMs: number,
): Promise<void> {
  parseDisplayNumber(display);
  await runCommand("xdotool", args, {
    env: { DISPLAY: display },
    timeoutMs,
    check: true,
  });
}

/**
 * Every desktop input call below is gated by `withAgentPermit`: it acquires
 * a short-lived agent permit, rechecks for a live human lease, delivers the
 * input only if none is found, and releases the permit in `finally` —
 * fail-closed, per pickforge/pickforge#21. No permit fitness (or a lease
 * appearing before the recheck) means no input delivery.
 */

export async function click(opts: ClickOptions): Promise<void> {
  await withAgentPermit(opts.sessionId, opts.env ?? process.env, () =>
    runXdotool(
      opts.display,
      buildClickArgs({ x: opts.x, y: opts.y, button: opts.button }),
      INPUT_TIMEOUT_MS,
    ),
  );
}

export async function move(opts: MoveOptions): Promise<void> {
  await withAgentPermit(opts.sessionId, opts.env ?? process.env, () =>
    runXdotool(
      opts.display,
      buildMoveArgs({ x: opts.x, y: opts.y }),
      INPUT_TIMEOUT_MS,
    ),
  );
}

export async function scroll(opts: ScrollOptions): Promise<void> {
  await withAgentPermit(opts.sessionId, opts.env ?? process.env, () =>
    runXdotool(
      opts.display,
      buildScrollArgs({
        deltaX: opts.deltaX,
        deltaY: opts.deltaY,
        x: opts.x,
        y: opts.y,
      }),
      INPUT_TIMEOUT_MS,
    ),
  );
}

export async function drag(opts: DragOptions): Promise<void> {
  await withAgentPermit(opts.sessionId, opts.env ?? process.env, () =>
    runXdotool(
      opts.display,
      buildDragArgs({
        fromX: opts.fromX,
        fromY: opts.fromY,
        toX: opts.toX,
        toY: opts.toY,
        button: opts.button,
        durationMs: opts.durationMs,
      }),
      INPUT_TIMEOUT_MS + MAX_DRAG_DURATION_MS,
    ),
  );
}

export async function doubleClick(opts: DoubleClickOptions): Promise<void> {
  await withAgentPermit(opts.sessionId, opts.env ?? process.env, () =>
    runXdotool(
      opts.display,
      buildDoubleClickArgs({
        x: opts.x,
        y: opts.y,
        button: opts.button,
        intervalMs: opts.intervalMs,
      }),
      INPUT_TIMEOUT_MS + MAX_DOUBLE_CLICK_INTERVAL_MS,
    ),
  );
}

export async function typeText(opts: TypeTextOptions): Promise<void> {
  await withAgentPermit(opts.sessionId, opts.env ?? process.env, () =>
    runXdotool(opts.display, buildTypeArgs(opts.text), TYPE_TIMEOUT_MS),
  );
}

export async function pressKey(opts: PressKeyOptions): Promise<void> {
  await withAgentPermit(opts.sessionId, opts.env ?? process.env, () =>
    runXdotool(opts.display, buildKeyArgs(opts.key), INPUT_TIMEOUT_MS),
  );
}
