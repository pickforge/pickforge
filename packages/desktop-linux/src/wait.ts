import {
  MAX_BASELINE_BYTES, ObservationTimeoutError, HumanControlActiveError, checkHumanLeaseBusy, withAgentPermit,
  observationBudget, readBaselineFile, redactSecrets, type EnvLike, type HumanLease,
} from "@pickforge/lab-core";
import { listWindows, type WindowInfo } from "./apps.js";
import { parseDisplayNumber } from "./display.js";
import { pngPixelDigest } from "./png.js";
import { screenshot } from "./screenshot.js";
import { sleep } from "./util.js";
import { WaitScratch } from "./wait-scratch.js";

export const DEFAULT_DESKTOP_WAIT_TIMEOUT_MS = 10_000;
export const MAX_DESKTOP_WAIT_TIMEOUT_MS = 300_000;
export const DEFAULT_STABLE_MS = 500;
export const MAX_STABLE_MS = 60_000;
/** The longest cleanup of a timed-out wait command. A compare gets 2s for SIGTERM-to-SIGKILL
 * escalation and 2s for forced settlement of retained pipes; captures and window queries get
 * CANCEL_KILL_GRACE_MS for each. Filesystem and scheduling delays are additional. */
export const WAIT_SUBPROCESS_KILL_GRACE_MS = 4_000;
const SAMPLE_GAP_MS = 100;
const WINDOW_QUERY_MS = 5_000;
const TAKEOVER_POLL_MS = 100;
// SIGTERM, SIGKILL and forced settlement of a cancelled capture together stay
// far below the human lease drain timeout.
const CANCEL_KILL_GRACE_MS = 500;

export type DesktopWaitReason = "changed" | "stable" | "window" | "timeout";

export type DesktopWaitMode =
  | { type: "changed"; baselinePath: string }
  | { type: "changed"; baseline: Buffer }
  | { type: "stable"; stableMs: number }
  | { type: "window"; name: string };

export interface DesktopWaitOptions {
  display: string;
  sessionId?: string;
  mode: DesktopWaitMode;
  timeoutMs?: number;
  env?: EnvLike;
  /** Recheck before every sample. Session samples also hold a short agent permit. */
  busyCheck?: () => Promise<void>;
  /** Invoked inside the observation deadline and evidence action, only when budget remains. */
  readBaseline?: (path: string, deadline: number) => Promise<Buffer>;
}

export interface DesktopWaitResult {
  reason: DesktopWaitReason;
  elapsedMs: number;
  samples: number;
  sampled: true;
  window?: WindowInfo;
}

export function boundDesktopWaitTimeoutMs(timeoutMs: number | undefined): number {
  const value = timeoutMs ?? DEFAULT_DESKTOP_WAIT_TIMEOUT_MS;
  if (!Number.isInteger(value) || value < 0 || value > MAX_DESKTOP_WAIT_TIMEOUT_MS) {
    throw new Error(
      `Invalid wait timeoutMs: expected an integer between 0 and ${MAX_DESKTOP_WAIT_TIMEOUT_MS}`,
    );
  }
  return value;
}

export function boundStableMs(stableMs: number | undefined): number {
  const value = stableMs ?? DEFAULT_STABLE_MS;
  if (!Number.isInteger(value) || value < 1 || value > MAX_STABLE_MS) {
    throw new Error(
      `Invalid stableMs: expected an integer between 1 and ${MAX_STABLE_MS}`,
    );
  }
  return value;
}

function remainingMs(deadline: number): number {
  return deadline - Date.now();
}

function timedOutError(error: unknown): boolean {
  return error instanceof ObservationTimeoutError;
}

async function digestFile(
  filePath: string,
  deadline: number,
  env: EnvLike | undefined,
): Promise<string> {
  const timeoutMs = remainingMs(deadline);
  observationBudget(deadline);
  return pngPixelDigest(filePath, { env, timeoutMs });
}

/** Captures under the sample permit, then digests the file outside it. */
async function sampleDigest(opts: DesktopWaitOptions, samplePath: string, deadline: number): Promise<string> {
  await withSamplePermit(opts, (signal) => {
    const timeoutMs = remainingMs(deadline);
    observationBudget(deadline);
    return screenshot({
      display: opts.display, outPath: samplePath, env: opts.env, timeoutMs, countWindows: false,
      signal, killGraceMs: CANCEL_KILL_GRACE_MS,
    });
  });
  return digestFile(samplePath, deadline, opts.env);
}

function withSamplePermit<T>(opts: DesktopWaitOptions, sample: (signal?: AbortSignal) => Promise<T>): Promise<T> {
  const { sessionId } = opts;
  if (sessionId === undefined) return sample();
  const env = opts.env ?? process.env;
  return withAgentPermit(sessionId, env, () => stopOnTakeover(sessionId, env, sample));
}

/**
 * A takeover publishes its lease before it drains permits. A sample that sees
 * the lease stops its commands, so its permit drains well before the timeout.
 */
async function stopOnTakeover<T>(
  sessionId: string,
  env: EnvLike,
  sample: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let lease: HumanLease | undefined;
  let checking = false;
  const timer = setInterval(() => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    // A failed read leaves the drain timeout as the bound.
    void checkHumanLeaseBusy(sessionId, env).then((found) => {
      if (found === undefined) return;
      lease = found;
      controller.abort();
    }, () => {}).finally(() => { checking = false; });
  }, TAKEOVER_POLL_MS);
  try {
    return await sample(controller.signal);
  } catch (error) {
    if (lease !== undefined) throw new HumanControlActiveError(lease);
    throw error;
  } finally {
    clearInterval(timer);
  }
}

async function waitGap(deadline: number): Promise<void> {
  const remaining = remainingMs(deadline);
  if (remaining <= 0) return;
  await sleep(Math.min(SAMPLE_GAP_MS, remaining));
}

async function timeoutResult(samples: number): Promise<DesktopWaitResult> {
  return { reason: "timeout", elapsedMs: 0, samples, sampled: true };
}

async function waitForChange(
  opts: DesktopWaitOptions & { mode: Extract<DesktopWaitMode, { type: "changed" }> },
  deadline: number,
  scratch: WaitScratch,
): Promise<DesktopWaitResult> {
  let baseline: string;
  let samplePath: string;
  try {
    observationBudget(deadline);
    const bytes = "baseline" in opts.mode ? opts.mode.baseline :
      await (opts.readBaseline ?? readBaselineFile)(opts.mode.baselinePath, deadline);
    if (bytes.length > MAX_BASELINE_BYTES) throw new Error("Baseline exceeds byte limit");
    observationBudget(deadline);
    const baselinePath = await scratch.write("baseline.png", bytes);
    samplePath = await scratch.file("sample.png");
    baseline = await digestFile(baselinePath, deadline, opts.env);
    await scratch.verify("baseline.png");
  } catch (error) {
    if (timedOutError(error)) return timeoutResult(0);
    throw error;
  }
  let samples = 0;
  for (;;) {
    if (remainingMs(deadline) <= 0) return timeoutResult(samples);
    try {
      await scratch.verify("sample.png");
      await opts.busyCheck?.();
      const digest = await sampleDigest(opts, samplePath, deadline);
      await scratch.verify("sample.png");
      samples += 1;
      if (remainingMs(deadline) <= 0) return timeoutResult(samples);
      if (digest !== baseline) {
        return { reason: "changed", elapsedMs: 0, samples, sampled: true };
      }
    } catch (error) {
      if (timedOutError(error)) return timeoutResult(samples);
      throw error;
    }
    if (remainingMs(deadline) <= 0) return timeoutResult(samples);
    await waitGap(deadline);
  }
}

async function waitForStable(
  opts: DesktopWaitOptions & { mode: Extract<DesktopWaitMode, { type: "stable" }> },
  deadline: number,
  scratch: WaitScratch,
): Promise<DesktopWaitResult> {
  const stableMs = boundStableMs(opts.mode.stableMs);
  const samplePath = await scratch.file("sample.png");
  let samples = 0;
  let lastDigest: string | undefined;
  let unchangedSince: number | undefined;
  for (;;) {
    if (remainingMs(deadline) <= 0) return timeoutResult(samples);
    try {
      await scratch.verify("sample.png");
      await opts.busyCheck?.();
      const digest = await sampleDigest(opts, samplePath, deadline);
      await scratch.verify("sample.png");
      const now = Date.now();
      samples += 1;
      if (remainingMs(deadline) <= 0) return timeoutResult(samples);
      if (digest === lastDigest) {
        if (unchangedSince !== undefined && now - unchangedSince >= stableMs) {
          return { reason: "stable", elapsedMs: 0, samples, sampled: true };
        }
      } else {
        lastDigest = digest;
        unchangedSince = now;
      }
    } catch (error) {
      if (timedOutError(error)) return timeoutResult(samples);
      throw error;
    }
    if (remainingMs(deadline) <= 0) return timeoutResult(samples);
    await waitGap(deadline);
  }
}

async function waitForNamedWindow(
  opts: DesktopWaitOptions & { mode: Extract<DesktopWaitMode, { type: "window" }> },
  deadline: number,
): Promise<DesktopWaitResult> {
  const name = opts.mode.name;
  let samples = 0;
  for (;;) {
    const remaining = remainingMs(deadline);
    if (remaining <= 0) return timeoutResult(samples);
    let lastSeen: WindowInfo[];
    try {
      await opts.busyCheck?.();
      lastSeen = await withSamplePermit(opts, (signal) => listWindows(
        opts.display,
        opts.env,
        Math.min(WINDOW_QUERY_MS, remaining),
        { signal, killGraceMs: CANCEL_KILL_GRACE_MS },
      ));
    } catch (error) {
      if (timedOutError(error)) {
        if (remainingMs(deadline) <= 0) return timeoutResult(samples);
        await waitGap(deadline);
        continue;
      }
      throw error;
    }
    samples += 1;
    if (remainingMs(deadline) <= 0) return timeoutResult(samples);
    const match = lastSeen.find((window) => window.name.includes(name));
    if (match !== undefined) {
      return {
        reason: "window",
        elapsedMs: 0,
        samples,
        sampled: true,
        window: { id: match.id, name: redactSecrets(match.name) },
      };
    }
    if (remainingMs(deadline) <= 0) return timeoutResult(samples);
    await waitGap(deadline);
  }
}

export async function desktopWait(opts: DesktopWaitOptions): Promise<DesktopWaitResult> {
  parseDisplayNumber(opts.display);
  const timeoutMs = boundDesktopWaitTimeoutMs(opts.timeoutMs);
  await opts.busyCheck?.();
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  if (timeoutMs === 0) return { ...await timeoutResult(0), elapsedMs: Date.now() - startedAt };
  if (opts.mode.type === "window") {
    const result = await waitForNamedWindow({ ...opts, mode: opts.mode }, deadline);
    return { ...result, elapsedMs: Date.now() - startedAt };
  }
  const scratch = await WaitScratch.create();
  let result: DesktopWaitResult;
  try {
    if (opts.mode.type === "changed") {
      result = await waitForChange({ ...opts, mode: opts.mode }, deadline, scratch);
    } else {
      result = await waitForStable({ ...opts, mode: opts.mode }, deadline, scratch);
    }
  } finally {
    await scratch.close();
  }
  return { ...result, elapsedMs: Date.now() - startedAt };
}
