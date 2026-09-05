import type { EnvLike } from "@pickforge/lab-core";
import { runAdb } from "./adb.js";
import { sleep } from "./util.js";

/** lowmemorykiller must have killed nothing for this long before a wait succeeds. */
export const DEFAULT_LMK_QUIET_S = 30;
export const DEFAULT_READY_POLL_MS = 2_000;
export const GUEST_NOT_READY = "guest-not-ready";

const LOGCAT_TAIL_LINES = 2_000;
const KILL_MARK = "lowmemorykiller: Kill";

export interface GuestReadinessProbe {
  kind: "guest-ready" | typeof GUEST_NOT_READY;
  serial: string;
  /** Seconds since the last kill; null when the buffer has none. */
  lmkQuietS: number | null;
  quietNeedS: number;
  waitedMs: number;
  boundMs: number;
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
}

export class GuestReadinessError extends Error {
  readonly kind = GUEST_NOT_READY;
  readonly probe: GuestReadinessProbe;

  constructor(probe: GuestReadinessProbe) {
    super(formatNotReady(probe));
    this.name = "GuestReadinessError";
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

function isLmkQuiet(quietS: number | null, needS: number): boolean {
  return quietS === null || quietS >= needS;
}

function formatQuiet(seconds: number | null): string {
  return seconds === null ? "never" : `${seconds}s`;
}

function formatWaiting(probe: GuestReadinessProbe): string {
  return (
    `waiting for guest ready on ${probe.serial}: lowmemorykiller quiet ` +
    `${formatQuiet(probe.lmkQuietS)} (need ${probe.quietNeedS}s), ` +
    `${Math.round(probe.waitedMs / 1000)}s of ${Math.round(probe.boundMs / 1000)}s elapsed`
  );
}

function formatReady(probe: GuestReadinessProbe): string {
  return (
    `guest ready on ${probe.serial}: lowmemorykiller quiet ` +
    `${formatQuiet(probe.lmkQuietS)} after ${Math.round(probe.waitedMs / 1000)}s`
  );
}

function formatNotReady(probe: GuestReadinessProbe): string {
  return (
    `guest not ready on ${probe.serial} [${GUEST_NOT_READY}]; ` +
    `lowmemorykiller quiet ${formatQuiet(probe.lmkQuietS)} ` +
    `(need ${probe.quietNeedS}s) after waiting ` +
    `${Math.round(probe.waitedMs / 1000)}s of ${Math.round(probe.boundMs / 1000)}s; ` +
    "the guest is still killing processes, so this action was not started"
  );
}

function makeProbe(
  opts: WaitForGuestReadyOptions,
  kind: GuestReadinessProbe["kind"],
  lmkQuietS: number | null,
  quietNeedS: number,
  startedAt: number,
): GuestReadinessProbe {
  return {
    kind,
    serial: opts.serial,
    lmkQuietS,
    quietNeedS,
    waitedMs: Date.now() - startedAt,
    boundMs: opts.boundSeconds * 1000,
  };
}

function assertPositiveSeconds(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `Invalid ${label} ${value}: expected a positive integer number of seconds`,
    );
  }
}

async function readLmkQuietSeconds(
  opts: WaitForGuestReadyOptions,
): Promise<number | null> {
  const [nowResult, logResult] = await Promise.all([
    runAdb({
      serial: opts.serial,
      sdk: opts.sdk,
      env: opts.env,
      args: ["shell", "date", "+%s"],
    }),
    runAdb({
      serial: opts.serial,
      sdk: opts.sdk,
      env: opts.env,
      args: ["logcat", "-d", "-v", "epoch", "-t", String(LOGCAT_TAIL_LINES)],
    }),
  ]);
  const guestNow = parseGuestNowSeconds(nowResult.stdout);
  if (!nowResult.ok || guestNow === undefined || !logResult.ok) {
    return 0;
  }
  return parseLmkQuietSeconds(logResult.stdout, guestNow);
}

/**
 * Block until lowmemorykiller has been quiet for `quietSeconds` (default 30),
 * or throw `GuestReadinessError` when `boundSeconds` elapses first. Does not
 * launch or install anything.
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

  for (;;) {
    const lmkQuietS = await readLmkQuietSeconds(opts);
    if (isLmkQuiet(lmkQuietS, quietNeedS)) {
      const probe = makeProbe(opts, "guest-ready", lmkQuietS, quietNeedS, startedAt);
      opts.onProgress?.(formatReady(probe));
      return probe;
    }
    const probe = makeProbe(opts, GUEST_NOT_READY, lmkQuietS, quietNeedS, startedAt);
    opts.onProgress?.(formatWaiting(probe));
    if (Date.now() + pollMs > deadline) {
      throw new GuestReadinessError(probe);
    }
    await sleep(pollMs);
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
  });
}
