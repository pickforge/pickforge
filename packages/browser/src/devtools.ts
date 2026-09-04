import fs from "node:fs";
import path from "node:path";
import { formatChromeStartupDiagnostics } from "./startup-diagnostics.js";
import { sleep } from "./util.js";

const DEFAULT_POLL_INTERVAL_MS = 100;

/**
 * Parse the CDP port from a `DevToolsActivePort` file. Chrome writes the port
 * on the first line and the browser websocket path (a per-launch GUID) on the
 * second. We read only the port; the GUID is a capability URL and must never be
 * persisted, so this function never returns or exposes the second line.
 */
export function parseDevToolsActivePort(content: string): number | undefined {
  const firstLine = content.split("\n", 1)[0]?.trim();
  if (firstLine === undefined || firstLine === "") {
    return undefined;
  }
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
  | { ok: false; reason: "aborted" | "exited" | "timeout" };

function reportStartupFailure(
  reason: "exited" | "timeout",
  profileDir: string,
  port?: number,
): DevToolsPortResult {
  console.error(
    `Chrome startup ${reason}.\n${formatChromeStartupDiagnostics(profileDir, port)}`,
  );
  return { ok: false, reason };
}

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
  timeoutMs: number;
  /** Liveness probe for the Chrome process; a dead process ends the wait. */
  isAlive: () => boolean;
  signal?: AbortSignal;
  /** Endpoint readiness probe; injectable for deterministic unit tests. */
  isReady?: (port: number) => boolean | Promise<boolean>;
  probeTimeoutMs?: number;
  pollIntervalMs?: number;
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
  const isReady =
    opts.isReady ??
    ((port: number) =>
      probeDevToolsHttp(
        port,
        opts.probeTimeoutMs ?? Math.max(poll, 100),
        opts.signal,
      ));
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
        return reportStartupFailure("exited", opts.profileDir, port);
      }
      const ready = await isReady(port);
      if (creationAborted()) {
        return { ok: false, reason: "aborted" };
      }
      if (ready && opts.isAlive()) {
        return { ok: true, port };
      }
    } else if (!opts.isAlive()) {
      return reportStartupFailure("exited", opts.profileDir);
    }
    if (Date.now() >= deadline) {
      return reportStartupFailure("timeout", opts.profileDir, port);
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
