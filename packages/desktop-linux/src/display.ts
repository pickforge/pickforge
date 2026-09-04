import fs from "node:fs";
import {
  isDisplaySocketAlive,
  isPidAlive,
  processIdentityMatches,
  readProcessIdentity,
  startDaemon,
  stopOwnedDaemonGroup,
  stopProcessGroupVerified,
  type EnvLike,
  type OwnedDaemonHandle,
  type ProcessIdentity,
} from "@pickforge/lab-core";
import { sleep } from "./util.js";

const DISPLAY_PATTERN = /^:\d+$/;
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const DEFAULT_DEPTH = 24;
const DEFAULT_START_DISPLAY = 90;
const DEFAULT_MAX_ATTEMPTS = 200;
const SOCKET_POLL_INTERVAL_MS = 100;
const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const ALLOCATION_RETRY_LIMIT = 5;
const IDENTITY_WAIT_TIMEOUT_MS = 1_000;

export interface XvfbArgsOptions {
  display: string;
  width?: number;
  height?: number;
  depth?: number;
}

export interface StartXvfbOptions extends Partial<XvfbArgsOptions> {
  logDir: string;
  waitTimeoutMs?: number;
  env?: EnvLike;
  signal?: AbortSignal;
  onSpawn?: (partial: XvfbPartialStart) => void | Promise<void>;
  /**
   * First display number to try when no explicit `display` is given. Lets
   * different session kinds carve out separate display ranges so they never
   * contend for the same numbers (e.g. browser sessions vs. desktop sessions).
   */
  displayStart?: number;
}

export interface XvfbHandle {
  display: string;
  pid: number;
  startTimeTicks: number;
  logPath: string;
  width: number;
  height: number;
}

export function parseDisplayNumber(display: string): number {
  if (!DISPLAY_PATTERN.test(display)) {
    throw new Error(
      `Invalid display "${display}": expected the form ":<number>"`,
    );
  }
  return Number.parseInt(display.slice(1), 10);
}

function displaySocketPath(displayNumber: number): string {
  return `/tmp/.X11-unix/X${displayNumber}`;
}

function displayLockPath(displayNumber: number): string {
  return `/tmp/.X${displayNumber}-lock`;
}

function readLockPid(displayNumber: number): number | null {
  let raw: string;
  try {
    raw = fs.readFileSync(displayLockPath(displayNumber), "utf8");
  } catch {
    return null;
  }
  const pid = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${label} ${value}: expected a positive integer`);
  }
}

export function buildXvfbArgs(opts: XvfbArgsOptions): string[] {
  parseDisplayNumber(opts.display);
  const width = opts.width ?? DEFAULT_WIDTH;
  const height = opts.height ?? DEFAULT_HEIGHT;
  const depth = opts.depth ?? DEFAULT_DEPTH;
  assertPositiveInteger(width, "width");
  assertPositiveInteger(height, "height");
  assertPositiveInteger(depth, "depth");
  return [
    opts.display,
    "-screen",
    "0",
    `${width}x${height}x${depth}`,
    "-nolisten",
    "tcp",
  ];
}

export interface AllocateDisplayOptions {
  start?: number;
  maxAttempts?: number;
}

export function allocateDisplay(opts: AllocateDisplayOptions = {}): string {
  const start = opts.start ?? DEFAULT_START_DISPLAY;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  for (let n = start; n < start + maxAttempts; n += 1) {
    if (
      !fs.existsSync(displayLockPath(n)) &&
      !fs.existsSync(displaySocketPath(n))
    ) {
      return `:${n}`;
    }
  }
  throw new Error(
    `No free X display found between :${start} and :${start + maxAttempts - 1}`,
  );
}

export function isDisplayAlive(display: string): boolean {
  parseDisplayNumber(display);
  return isDisplaySocketAlive(display);
}

export type XvfbStartFailureReason =
  | "aborted"
  | "exited"
  | "handoff"
  | "identity"
  | "startup"
  | "lost-race"
  | "timeout";

export interface XvfbPartialStart {
  display: string;
  pid: number;
  startTimeTicks: number;
  logPath: string;
  width: number;
  height: number;
  cleanupConfirmed: boolean;
}

export class XvfbStartError extends Error {
  readonly reason: XvfbStartFailureReason;
  readonly partial?: XvfbPartialStart;

  constructor(
    reason: XvfbStartFailureReason,
    message: string,
    partial?: XvfbPartialStart,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "XvfbStartError";
    this.reason = reason;
    this.partial = partial;
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function abortedBeforeSpawn(): XvfbStartError {
  return new XvfbStartError(
    "aborted",
    "Xvfb startup aborted by the client",
  );
}

function childHasExited(daemon: OwnedDaemonHandle): boolean {
  return daemon.child.exitCode !== null || daemon.child.signalCode !== null;
}

/**
 * Stop an Xvfb we started but have not yet verified an identity for. Xvfb does
 * not fork a child tree, so an individual kill nearly always suffices — but
 * "nearly always" is not a cleanup guarantee, and reporting a display as gone
 * while a group member survives is exactly the failure #29 fixed for the
 * browser supervisor. This applies the same discipline: signal the group by
 * pgid and confirm no member remains (pickforge/pickforge#57).
 *
 * Returns whether the group is confirmed empty. The caller must treat false as
 * unconfirmed cleanup, not as success.
 */
async function stopOwnedDaemon(daemon: OwnedDaemonHandle): Promise<boolean> {
  return stopOwnedDaemonGroup(daemon);
}

async function waitForOwnedIdentity(
  daemon: OwnedDaemonHandle,
): Promise<{ pid: number; startTicks: number } | undefined> {
  const deadline = Date.now() + IDENTITY_WAIT_TIMEOUT_MS;
  for (;;) {
    const identity = readProcessIdentity(daemon.pid);
    if (identity !== undefined) return identity;
    if (childHasExited(daemon) || Date.now() >= deadline) return undefined;
    await sleep(10);
  }
}

async function cleanupPartialStart(
  partial: XvfbPartialStart,
  daemon: OwnedDaemonHandle,
): Promise<XvfbPartialStart> {
  let cleanupConfirmed = false;
  try {
    const result = await stopProcessGroupVerified({
      pid: partial.pid,
      startTicks: partial.startTimeTicks,
    });
    cleanupConfirmed =
      result.outcome === "terminated" || result.outcome === "already-dead";
  } catch {
    cleanupConfirmed = false;
  }
  if (!cleanupConfirmed) {
    cleanupConfirmed = await stopOwnedDaemon(daemon);
  } else {
    daemon.release();
  }
  return { ...partial, cleanupConfirmed };
}

function failureMessage(
  reason: XvfbStartFailureReason,
  display: string,
  logPath: string,
  timeoutMs: number,
  cleanupConfirmed: boolean,
): string {
  const cleanup = cleanupConfirmed
    ? ""
    : `; spawned Xvfb cleanup could not be verified`;
  switch (reason) {
    case "aborted":
      return `Xvfb startup aborted by the client${cleanup}`;
    case "exited":
      return (
        `Xvfb exited during startup on ${display}; ` +
        `check the log at ${logPath}${cleanup}`
      );
    case "handoff":
      return `Xvfb ownership handoff failed on ${display}${cleanup}`;
    case "identity":
      return `Xvfb identity could not be verified on ${display}${cleanup}`;
    case "lost-race":
      return (
        `Xvfb could not claim ${display}: another X server owns it; ` +
        `check the log at ${logPath}${cleanup}`
      );
    case "startup":
      return `Xvfb startup failed on ${display}; check the log at ${logPath}${cleanup}`;
    case "timeout":
      return (
        `Xvfb did not come up on ${display} within ${timeoutMs}ms; ` +
        `check the log at ${logPath}${cleanup}`
      );
  }
}

type XvfbAttempt =
  | { outcome: "ready"; handle: XvfbHandle }
  | { outcome: "failed"; error: XvfbStartError };

async function failedAttempt(
  reason: XvfbStartFailureReason,
  partial: XvfbPartialStart,
  daemon: OwnedDaemonHandle,
  timeoutMs: number,
  cause?: unknown,
): Promise<XvfbAttempt> {
  const cleaned = await cleanupPartialStart(partial, daemon);
  return {
    outcome: "failed",
    error: new XvfbStartError(
      reason,
      failureMessage(
        reason,
        partial.display,
        partial.logPath,
        timeoutMs,
        cleaned.cleanupConfirmed,
      ),
      cleaned,
      cause,
    ),
  };
}

interface XvfbSpawn {
  daemon: OwnedDaemonHandle;
  identity: ProcessIdentity;
  partial: XvfbPartialStart;
}

/** Spawn Xvfb and capture the identity every later signal is verified against. */
async function spawnXvfb(
  display: string,
  opts: StartXvfbOptions,
  timeoutMs: number,
): Promise<XvfbSpawn | XvfbAttempt> {
  const width = opts.width ?? DEFAULT_WIDTH;
  const height = opts.height ?? DEFAULT_HEIGHT;
  const args = buildXvfbArgs({
    display,
    width: opts.width,
    height: opts.height,
    depth: opts.depth,
  });
  const daemon = await startDaemon("Xvfb", args, {
    logDir: opts.logDir,
    name: "xvfb",
    env: opts.env,
    owned: true,
  });
  const identity = await waitForOwnedIdentity(daemon);
  if (identity === undefined) {
    const cleanupConfirmed = await stopOwnedDaemon(daemon);
    return {
      outcome: "failed",
      error: new XvfbStartError(
        "identity",
        failureMessage(
          "identity",
          display,
          daemon.logPath,
          timeoutMs,
          cleanupConfirmed,
        ),
      ),
    };
  }
  return {
    daemon,
    identity,
    partial: {
      display,
      pid: daemon.pid,
      startTimeTicks: identity.startTicks,
      logPath: daemon.logPath,
      width,
      height,
      cleanupConfirmed: false,
    },
  };
}

type DisplayClaim = "ready" | "lost-race" | "pending";

/**
 * Decide who owns the display socket: us, a foreign X server that won the
 * race, or nobody yet.
 */
function readDisplayClaim(displayNumber: number, ownPid: number): DisplayClaim {
  if (!fs.existsSync(displaySocketPath(displayNumber))) return "pending";
  const lockPid = readLockPid(displayNumber);
  if (lockPid !== null && lockPid !== ownPid && isPidAlive(lockPid)) {
    return "lost-race";
  }
  return lockPid === null || lockPid === ownPid ? "ready" : "pending";
}

/** Poll until the display is claimed, Xvfb dies, or the deadline passes. */
async function waitForDisplayClaim(
  displayNumber: number,
  spawn: XvfbSpawn,
  opts: StartXvfbOptions,
  timeoutMs: number,
): Promise<XvfbStartFailureReason | "ready"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alive = processIdentityMatches(spawn.identity);
    const claim = readDisplayClaim(displayNumber, spawn.daemon.pid);
    if (claim === "lost-race") return "lost-race";
    if (claim === "ready" && alive) {
      return isAborted(opts.signal) ? "aborted" : "ready";
    }
    if (!alive) return "exited";
    try {
      await sleep(SOCKET_POLL_INTERVAL_MS, opts.signal);
    } catch (error) {
      if (isAborted(opts.signal)) return "aborted";
      throw error;
    }
  }
  return "timeout";
}

async function attemptStartXvfb(
  display: string,
  opts: StartXvfbOptions,
): Promise<XvfbAttempt> {
  if (isAborted(opts.signal)) throw abortedBeforeSpawn();
  const displayNumber = parseDisplayNumber(display);
  const timeoutMs = opts.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const spawned = await spawnXvfb(display, opts, timeoutMs);
  if ("outcome" in spawned) return spawned;
  const { daemon, identity, partial } = spawned;

  try {
    await opts.onSpawn?.(partial);
  } catch (error) {
    return failedAttempt("handoff", partial, daemon, timeoutMs, error);
  }
  daemon.release();
  if (isAborted(opts.signal)) {
    return failedAttempt("aborted", partial, daemon, timeoutMs);
  }

  let reason: XvfbStartFailureReason | "ready";
  try {
    reason = await waitForDisplayClaim(displayNumber, spawned, opts, timeoutMs);
  } catch (error) {
    return failedAttempt("startup", partial, daemon, timeoutMs, error);
  }
  if (reason !== "ready") {
    return failedAttempt(reason, partial, daemon, timeoutMs);
  }
  return {
    outcome: "ready",
    handle: {
      display,
      pid: daemon.pid,
      startTimeTicks: identity.startTicks,
      logPath: daemon.logPath,
      width: partial.width,
      height: partial.height,
    },
  };
}

export async function startXvfb(opts: StartXvfbOptions): Promise<XvfbHandle> {
  if (isAborted(opts.signal)) throw abortedBeforeSpawn();
  if (opts.display !== undefined) {
    const attempt = await attemptStartXvfb(opts.display, opts);
    if (attempt.outcome === "ready") return attempt.handle;
    throw attempt.error;
  }

  let searchFrom = opts.displayStart ?? DEFAULT_START_DISPLAY;
  let lastError: XvfbStartError | undefined;
  for (let retry = 0; retry < ALLOCATION_RETRY_LIMIT; retry += 1) {
    if (isAborted(opts.signal)) throw abortedBeforeSpawn();
    const display = allocateDisplay({ start: searchFrom });
    const attempt = await attemptStartXvfb(display, opts);
    if (attempt.outcome === "ready") return attempt.handle;
    lastError = attempt.error;
    if (
      attempt.error.partial?.cleanupConfirmed !== true ||
      attempt.error.reason === "aborted" ||
      attempt.error.reason === "timeout"
    ) {
      throw attempt.error;
    }
    searchFrom = parseDisplayNumber(display) + 1;
  }
  throw (
    lastError ??
    new XvfbStartError(
      "exited",
      `Xvfb failed to claim a free display after ${ALLOCATION_RETRY_LIMIT} attempts`,
    )
  );
}

/**
 * Stop an Xvfb by pid, with the group discipline of #57: the recorded process
 * must still be the leader of its own group with its recorded start identity,
 * or the signal is refused rather than aimed at a recycled pid.
 *
 * `startTicks` is what makes that guarantee possible, so without it a *live*
 * pid is refused (returns false) instead of being verified against a snapshot
 * taken now — which would prove nothing about the Xvfb the caller meant and
 * would happily kill whatever unrelated process-group leader inherited the
 * number. A pid that is already gone still reports success: there is nothing
 * left to confuse it with. Session teardown passes the recorded ticks.
 */
export async function stopXvfb(
  pid: number,
  startTicks?: number,
): Promise<boolean> {
  if (startTicks === undefined) return !isPidAlive(pid);
  const result = await stopProcessGroupVerified({ pid, startTicks });
  return result.outcome === "terminated" || result.outcome === "already-dead";
}
