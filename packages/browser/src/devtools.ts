import fs from "node:fs";
import path from "node:path";
import { formatChromeStartupDiagnostics } from "./startup-diagnostics.js";
import { sleep } from "./util.js";

const DEFAULT_POLL_INTERVAL_MS = 100;
/**
 * Readiness-probe budget. A cold DevTools endpoint on a loaded host answers
 * `/json/version` well after the poll interval, so the probe gets a full second
 * rather than the poll interval.
 */
const DEFAULT_PROBE_TIMEOUT_MS = 1_000;

/**
 * Parse the CDP port from a `DevToolsActivePort` file. Chrome writes the port
 * on the first line and the browser websocket path (a per-launch GUID) on the
 * second. We read only the port; the GUID is a capability URL and must never be
 * persisted, so this function never returns or exposes the second line.
 */
export function parseDevToolsActivePort(content: string): number | undefined {
  const firstLineEnd = content.indexOf("\n");
  if (firstLineEnd === -1) return undefined;
  const firstLine = content.slice(0, firstLineEnd).trim();
  if (firstLine === "") return undefined;
  const port = Number(firstLine);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return undefined;
  }
  return port;
}

/** Read the CDP port from `<profileDir>/DevToolsActivePort`, if present. */
export function readDevToolsActivePort(profileDir: string): number | undefined {
  let content: string;
  try {
    content = fs.readFileSync(
      path.join(profileDir, "DevToolsActivePort"),
      "utf8",
    );
  } catch {
    return undefined;
  }
  return parseDevToolsActivePort(content);
}

export type DevToolsPortResult =
  | { ok: true; port: number }
  | { ok: false; reason: "aborted" }
  | {
      ok: false;
      reason: "exited" | "timeout";
      diagnostics: string;
    };

/** Verify that the loopback DevTools HTTP endpoint is accepting requests. */
export async function probeDevToolsHttp(
  port: number,
  timeoutMs = 500,
  signal?: AbortSignal,
): Promise<boolean> {
  const controller = new AbortController();
  const abortFromCaller = (): void => controller.abort(signal?.reason);
  let listeningForCaller = false;
  if (signal?.aborted === true) {
    abortFromCaller();
  } else if (signal !== undefined) {
    signal.addEventListener("abort", abortFromCaller, { once: true });
    listeningForCaller = true;
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: controller.signal,
      redirect: "manual",
    });
    await response.body?.cancel();
    return response.status === 200;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    if (listeningForCaller) {
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}

export interface WaitForDevToolsPortOptions {
  profileDir: string;
  /** Authoritative Chrome daemon log path used for durable diagnostics. */
  logPath?: string;
  timeoutMs: number;
  /** Liveness probe for the Chrome process; a dead process ends the wait. */
  isAlive: () => boolean;
  signal?: AbortSignal;
  /** Endpoint readiness probe; injectable for deterministic unit tests. */
  isReady?: (port: number) => boolean | Promise<boolean>;
  probeTimeoutMs?: number;
  pollIntervalMs?: number;
}

function startupFailure(
  reason: "exited" | "timeout",
  opts: WaitForDevToolsPortOptions,
  port?: number,
): DevToolsPortResult {
  return {
    ok: false,
    reason,
    diagnostics: formatChromeStartupDiagnostics({
      profileDir: opts.profileDir,
      reason,
      ...(opts.logPath === undefined ? {} : { logPath: opts.logPath }),
      ...(port === undefined ? {} : { port }),
    }),
  };
}

/**
 * Poll for a published CDP port, a live recorded browser identity, and a
 * responding loopback DevTools HTTP endpoint. Fails fast if Chrome exits and
 * returns `timeout` if the complete readiness contract is not met in time.
 */
export async function waitForDevToolsPort(
  opts: WaitForDevToolsPortOptions,
): Promise<DevToolsPortResult> {
  const poll = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + opts.timeoutMs;
  // Aborting a probe resets the DevTools connection, so an over-eager budget
  // makes a live-but-slow endpoint look unready on every poll and can bury a
  // loaded host under connection churn until the overall deadline expires.
  // Give each probe real time, but never more than the wait has left.
  const probeBudget =
    opts.probeTimeoutMs ?? Math.max(poll, DEFAULT_PROBE_TIMEOUT_MS);
  const probeTimeout = (): number =>
    Math.max(poll, Math.min(probeBudget, deadline - Date.now()));
  const isReady =
    opts.isReady ??
    ((port: number) =>
      probeDevToolsHttp(port, probeTimeout(), opts.signal));
  // Read through a function so cancellation that occurs during the awaited
  // probe is observed instead of being hidden by TypeScript's prior narrowing.
  const creationAborted = (): boolean => opts.signal?.aborted === true;
  for (;;) {
    if (creationAborted()) {
      return { ok: false, reason: "aborted" };
    }
    const port = readDevToolsActivePort(opts.profileDir);
    if (port !== undefined) {
      if (!opts.isAlive()) {
        return startupFailure("exited", opts, port);
      }
      const ready = await isReady(port);
      if (creationAborted()) {
        return { ok: false, reason: "aborted" };
      }
      if (ready && opts.isAlive()) {
        return { ok: true, port };
      }
    } else if (!opts.isAlive()) {
      return startupFailure("exited", opts);
    }
    if (Date.now() >= deadline) {
      return startupFailure("timeout", opts, port);
    }
    try {
      await sleep(poll, opts.signal);
    } catch (error) {
      if (creationAborted()) {
        return { ok: false, reason: "aborted" };
      }
      throw error;
    }
  }
}
