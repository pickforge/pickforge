import type { EnvLike } from "@pickforge/lab-core";
import { runAdb } from "./adb.js";
import { sleep } from "./util.js";

/** lowmemorykiller must have killed nothing for this long before a wait succeeds. */
export const DEFAULT_LMK_QUIET_S = 30;
export const DEFAULT_READY_POLL_MS = 2_000;
export const GUEST_NOT_READY = "guest-not-ready";
export const GUEST_ABORTED = "aborted";

const PROBE_ADB_TIMEOUT_MS = 30_000;
const KILL_MARK = "lowmemorykiller: Kill";
const LMK_LOGCAT_ARGS = [
  "logcat",
  "-d",
  "-v",
  "epoch",
  "-s",
  "lowmemorykiller:I",
] as const;

export type GuestReadinessKind =
  | "guest-ready"
  | typeof GUEST_NOT_READY
  | typeof GUEST_ABORTED;

export interface GuestReadinessProbe {
  kind: GuestReadinessKind;
  serial: string;
  /** Seconds since the last kill; null when the buffer has none. */
  lmkQuietS: number | null;
  quietNeedS: number;
  waitedMs: number;
  boundMs: number;
  /** Set when the guest clock or logcat could not be read. */
  probeError?: string;
}

export interface WaitForGuestReadyOptions {
  serial: string;
  sdk?: string | null;
  env?: EnvLike;
  /** Wall-clock bound in seconds. Must be a positive integer. */
  boundSeconds: number;
  /** Seconds of lowmemorykiller quiet required. Default 30. */
  quietSeconds?: number;
  pollIntervalMs?: number;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}

interface LmkReading {
  quietS: number | null;
  probeError?: string;
}

export class GuestReadinessError extends Error {
  readonly kind: typeof GUEST_NOT_READY | typeof GUEST_ABORTED;
  readonly probe: GuestReadinessProbe;

  constructor(probe: GuestReadinessProbe) {
    super(formatFailure(probe));
    this.name = probe.kind === GUEST_ABORTED ? "AbortError" : "GuestReadinessError";
    this.kind = probe.kind === GUEST_ABORTED ? GUEST_ABORTED : GUEST_NOT_READY;
    this.probe = probe;
  }
}

export function isGuestReadinessError(
  error: unknown,
): error is GuestReadinessError {
  return error instanceof GuestReadinessError;
}

export function parseGuestNowSeconds(output: string): number | undefined {
  const value = Number.parseInt(output.trim(), 10);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Seconds since the last `lowmemorykiller: Kill` line in `logcat -v epoch`
 * output, using the guest clock. Null when the buffer has no kill.
 */
export function parseLmkQuietSeconds(
  logcatEpoch: string,
  guestNowS: number,
): number | null {
  let lastKillS: number | undefined;
  for (const line of logcatEpoch.split("\n")) {
    if (!line.includes(KILL_MARK)) {
      continue;
    }
    const stamp = Number.parseFloat(line.trim().split(/\s+/, 1)[0] ?? "");
    if (!Number.isFinite(stamp)) {
      continue;
    }
    lastKillS = Math.trunc(stamp);
  }
  if (lastKillS === undefined) {
    return null;
  }
  return Math.max(0, guestNowS - lastKillS);
}

function isLmkQuiet(reading: LmkReading, needS: number): boolean {
  if (reading.probeError !== undefined) {
    return false;
  }
  return reading.quietS === null || reading.quietS >= needS;
}

function formatQuiet(seconds: number | null): string {
  return seconds === null ? "never" : `${seconds}s`;
}

function formatLmkState(probe: GuestReadinessProbe): string {
  if (probe.probeError !== undefined) {
    return `guest clock or logcat unreadable (${probe.probeError})`;
  }
  return `lowmemorykiller quiet ${formatQuiet(probe.lmkQuietS)}`;
}

function formatWaiting(probe: GuestReadinessProbe): string {
  return (
    `waiting for guest ready on ${probe.serial}: ${formatLmkState(probe)} ` +
    `(need ${probe.quietNeedS}s), ` +
    `${Math.round(probe.waitedMs / 1000)}s of ${Math.round(probe.boundMs / 1000)}s elapsed`
  );
}

function formatReady(probe: GuestReadinessProbe): string {
  return (
    `guest ready on ${probe.serial}: ${formatLmkState(probe)} ` +
    `after ${Math.round(probe.waitedMs / 1000)}s`
  );
}

function formatFailure(probe: GuestReadinessProbe): string {
  if (probe.kind === GUEST_ABORTED) {
    return (
      `guest ready wait aborted on ${probe.serial} [${GUEST_ABORTED}]; ` +
      "this action was not started"
    );
  }
  const waited =
    `${Math.round(probe.waitedMs / 1000)}s of ${Math.round(probe.boundMs / 1000)}s`;
  if (probe.probeError !== undefined) {
    return (
      `guest not ready on ${probe.serial} [${GUEST_NOT_READY}]; ` +
      `${formatLmkState(probe)} after waiting ${waited}; ` +
      "this action was not started"
    );
  }
  return (
    `guest not ready on ${probe.serial} [${GUEST_NOT_READY}]; ` +
    `${formatLmkState(probe)} (need ${probe.quietNeedS}s) after waiting ${waited}; ` +
    "the guest is still killing processes, so this action was not started"
  );
}

function makeProbe(
  opts: WaitForGuestReadyOptions,
  kind: GuestReadinessKind,
  reading: LmkReading,
  quietNeedS: number,
  startedAt: number,
): GuestReadinessProbe {
  const boundMs = opts.boundSeconds * 1000;
  const probe: GuestReadinessProbe = {
    kind,
    serial: opts.serial,
    lmkQuietS: reading.quietS,
    quietNeedS,
    waitedMs: Math.min(Math.max(0, Date.now() - startedAt), boundMs),
    boundMs,
  };
  if (reading.probeError !== undefined) {
    probe.probeError = reading.probeError;
  }
  return probe;
}

function assertPositiveSeconds(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `Invalid ${label} ${value}: expected a positive integer number of seconds`,
    );
  }
}

function remainingMs(deadline: number): number {
  return deadline - Date.now();
}

function probeTimeoutMs(deadline: number): number {
  return Math.max(1, Math.min(PROBE_ADB_TIMEOUT_MS, remainingMs(deadline)));
}

function throwIfAborted(
  opts: WaitForGuestReadyOptions,
  reading: LmkReading,
  quietNeedS: number,
  startedAt: number,
): void {
  if (opts.signal?.aborted !== true) {
    return;
  }
  throw new GuestReadinessError(
    makeProbe(opts, GUEST_ABORTED, reading, quietNeedS, startedAt),
  );
}

function describeProbeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("adb not found")) {
    return "adb not found";
  }
  return "probe failed";
}

async function sleepOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) {
    await sleep(ms);
    return;
  }
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function readLmkQuietSeconds(
  opts: WaitForGuestReadyOptions,
  deadline: number,
): Promise<LmkReading> {
  const timeoutMs = probeTimeoutMs(deadline);
  try {
    const [nowResult, logResult] = await Promise.all([
      runAdb({
        serial: opts.serial,
        sdk: opts.sdk,
        env: opts.env,
        args: ["shell", "date", "+%s"],
        timeoutMs,
        killGraceMs: 0,
      }),
      runAdb({
        serial: opts.serial,
        sdk: opts.sdk,
        env: opts.env,
        args: [...LMK_LOGCAT_ARGS],
        timeoutMs,
        killGraceMs: 0,
      }),
    ]);
    const guestNow = parseGuestNowSeconds(nowResult.stdout);
    if (!nowResult.ok || guestNow === undefined) {
      return { quietS: 0, probeError: "guest clock unreadable" };
    }
    if (!logResult.ok) {
      return { quietS: 0, probeError: "logcat unreadable" };
    }
    return { quietS: parseLmkQuietSeconds(logResult.stdout, guestNow) };
  } catch (error) {
    return { quietS: 0, probeError: describeProbeFailure(error) };
  }
}

/**
 * Block until lowmemorykiller has been quiet for `quietSeconds` (default 30),
 * or throw `GuestReadinessError` when `boundSeconds` elapses first. Does not
 * launch or install anything. Honours `signal` so a cancelled wait never
 * reports ready.
 */
export async function waitForGuestReady(
  opts: WaitForGuestReadyOptions,
): Promise<GuestReadinessProbe> {
  assertPositiveSeconds(opts.boundSeconds, "waitReadySeconds");
  const quietNeedS = opts.quietSeconds ?? DEFAULT_LMK_QUIET_S;
  assertPositiveSeconds(quietNeedS, "quietSeconds");
  const pollMs = opts.pollIntervalMs ?? DEFAULT_READY_POLL_MS;
  const startedAt = Date.now();
  const deadline = startedAt + opts.boundSeconds * 1000;
  let reading: LmkReading = { quietS: null };
  throwIfAborted(opts, reading, quietNeedS, startedAt);

  for (;;) {
    if (remainingMs(deadline) <= 0) {
      throw new GuestReadinessError(
        makeProbe(opts, GUEST_NOT_READY, reading, quietNeedS, startedAt),
      );
    }
    reading = await readLmkQuietSeconds(opts, deadline);
    throwIfAborted(opts, reading, quietNeedS, startedAt);
    if (isLmkQuiet(reading, quietNeedS)) {
      throwIfAborted(opts, reading, quietNeedS, startedAt);
      const probe = makeProbe(opts, "guest-ready", reading, quietNeedS, startedAt);
      opts.onProgress?.(formatReady(probe));
      return probe;
    }
    const probe = makeProbe(opts, GUEST_NOT_READY, reading, quietNeedS, startedAt);
    opts.onProgress?.(formatWaiting(probe));
    const remaining = remainingMs(deadline);
    if (remaining <= 0) {
      throw new GuestReadinessError(probe);
    }
    await sleepOrAbort(Math.min(pollMs, remaining), opts.signal);
    throwIfAborted(opts, reading, quietNeedS, startedAt);
  }
}

/**
 * No-op when `waitReadySeconds` is omitted or 0 (the product default).
 * Otherwise waits, and does not start the caller's action on failure.
 */
export async function maybeWaitForGuestReady(
  opts: {
    serial: string;
    sdk?: string | null;
    env?: EnvLike;
    waitReadySeconds?: number;
    onProgress?: (message: string) => void;
    quietSeconds?: number;
    pollIntervalMs?: number;
    signal?: AbortSignal;
  },
): Promise<GuestReadinessProbe | undefined> {
  const bound = opts.waitReadySeconds;
  if (bound === undefined || bound === 0) {
    return undefined;
  }
  return waitForGuestReady({
    serial: opts.serial,
    sdk: opts.sdk,
    env: opts.env,
    boundSeconds: bound,
    quietSeconds: opts.quietSeconds,
    pollIntervalMs: opts.pollIntervalMs,
    onProgress: opts.onProgress,
    signal: opts.signal,
  });
}
