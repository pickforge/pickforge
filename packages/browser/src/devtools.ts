import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { formatChromeStartupDiagnostics } from "./startup-diagnostics.js";
import { sleep } from "./util.js";

const DEFAULT_POLL_INTERVAL_MS = 100;
/**
 * Readiness-probe budget. A cold browser on a loaded host answers
 * `/json/version` well after the poll interval, so the probe gets a full second
 * rather than the poll interval.
 */
const DEFAULT_PROBE_TIMEOUT_MS = 1_000;
const MAX_ENDPOINT_FILE_BYTES = 4 * 1024;
const MAX_CDP_HTTP_BODY_BYTES = 64 * 1024;
const BROWSER_PATH_PATTERN = /^\/devtools\/browser\/[0-9a-f-]{36}$/;

/**
 * The CDP endpoint the browser supervisor publishes in `cdp-endpoint` once
 * Chrome answers on its pipe. Chrome itself listens on no port.
 */
export interface CdpEndpoint {
  /** The supervisor's 0600 Unix socket. */
  socketPath: string;
  /** This launch's browser websocket path. It is a capability; never log it. */
  browserPath: string;
}

/** Parse the supervisor's endpoint file; anything malformed is `undefined`. */
export function parseCdpEndpoint(content: string): CdpEndpoint | undefined {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { socketPath, browserPath } = value as Record<string, unknown>;
  if (
    typeof socketPath !== "string" ||
    !path.isAbsolute(socketPath) ||
    typeof browserPath !== "string" ||
    !BROWSER_PATH_PATTERN.test(browserPath)
  ) {
    return undefined;
  }
  return { socketPath, browserPath };
}

function hasErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/**
 * Read the endpoint file without following a link. It must be a regular file
 * of this user with no group or other access. A missing file is `undefined`;
 * an unsafe or malformed one is an error.
 */
export async function readCdpEndpoint(file: string): Promise<CdpEndpoint | undefined> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) return undefined;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
      throw new Error(`Refusing unsafe CDP endpoint file ${file}: must be a regular file of this user with mode 0600`);
    }
    if (stat.size > MAX_ENDPOINT_FILE_BYTES) {
      throw new Error(`Refusing oversized CDP endpoint file ${file}`);
    }
    const endpoint = parseCdpEndpoint(await handle.readFile("utf8"));
    if (endpoint === undefined) throw new Error(`Invalid CDP endpoint file ${file}`);
    return endpoint;
  } finally {
    await handle.close();
  }
}

/** The `ws` URL of a path on the supervisor's socket. */
export function cdpWebSocketUrl(socketPath: string, browserPath: string): string {
  return `ws+unix:${socketPath}:${browserPath}`;
}

interface CdpHttpResponse {
  status: number;
  body: string;
}

/** One bounded HTTP request to the supervisor's Unix socket. */
function cdpHttpRequest(
  socketPath: string,
  method: "GET" | "POST",
  requestPath: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CdpHttpResponse> {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal !== undefined) signals.push(signal);
  return new Promise((resolve, reject) => {
    const request = http.request(
      { socketPath, method, path: requestPath, signal: AbortSignal.any(signals) },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_CDP_HTTP_BODY_BYTES) {
            request.destroy(new Error("CDP socket reply is too large"));
            return;
          }
          chunks.push(chunk);
        });
        response.once("end", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
        response.once("error", reject);
      },
    );
    request.once("error", reject);
    request.end();
  });
}

/** Verify that the supervisor's socket answers `/json/version`. */
export async function probeCdpEndpoint(
  socketPath: string,
  timeoutMs = 500,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const response = await cdpHttpRequest(socketPath, "GET", "/json/version", timeoutMs, signal);
    return response.status === 200;
  } catch {
    return false;
  }
}

/** Longest browser build string we persist; real values are far shorter. */
const MAX_BROWSER_VERSION_LENGTH = 120;
/** Conservative shape for a build string such as `Chrome/131.0.6778.85`. */
const BROWSER_VERSION_PATTERN = /^[\w.+/() -]+$/;

/**
 * Read the browser build string (the `Browser` field of `/json/version`, e.g.
 * `Chrome/131.0.6778.85`) from the supervisor's socket. Advisory: any
 * failure, or a value that does not look like a build string, returns
 * `undefined` so the caller records no browser rather than failing.
 */
export async function readDevToolsBrowserVersion(
  socketPath: string,
  timeoutMs = 500,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const response = await cdpHttpRequest(socketPath, "GET", "/json/version", timeoutMs, signal);
    if (response.status !== 200) return undefined;
    return browserVersionOf(JSON.parse(response.body));
  } catch {
    return undefined;
  }
}

function browserVersionOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const raw = (body as { Browser?: unknown }).Browser;
  if (typeof raw !== "string") return undefined;
  const version = raw.trim();
  if (
    version === "" ||
    version.length > MAX_BROWSER_VERSION_LENGTH ||
    !BROWSER_VERSION_PATTERN.test(version)
  ) {
    return undefined;
  }
  return version;
}

/**
 * Ask the supervisor to send `Browser.close` down the pipe. Chrome then shuts
 * down cleanly and flushes the profile. Returns whether the request was taken.
 */
export async function requestCdpBrowserClose(
  socketPath: string,
  timeoutMs = 3_000,
  signal?: AbortSignal,
): Promise<boolean> {
  const response = await cdpHttpRequest(socketPath, "POST", "/close", timeoutMs, signal);
  return response.status === 202;
}

/** The supervisor refused a second client: one relay per session. */
export class CdpAlreadyAttachedError extends Error {
  constructor() {
    super("A DevTools relay is already attached to this browser session");
    this.name = "CdpAlreadyAttachedError";
  }
}

export interface CdpClientLease {
  /** The `ws+unix:` endpoint for this lease's one websocket client. */
  browserEndpoint: string;
  /** End the lease; the supervisor then detaches its client and resets it. */
  release(): void;
}

function readLeasePath(response: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const onData = (chunk: string): void => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline === -1 && buffered.length <= MAX_ENDPOINT_FILE_BYTES) return;
      response.off("data", onData);
      // Keep reading so the held response never stalls the connection.
      response.resume();
      const browserPath = parseLeasePath(buffered.slice(0, Math.max(newline, 0)));
      if (browserPath === undefined) reject(new Error("Invalid CDP client lease"));
      else resolve(browserPath);
    };
    response.setEncoding("utf8");
    response.on("data", onData);
    // Stays attached: a held lease that the supervisor drops ends in an error.
    response.on("error", reject);
    response.once("end", () => reject(new Error("The CDP socket ended the client lease")));
  });
}

function parseLeasePath(line: string): string | undefined {
  try {
    const value = JSON.parse(line) as { browserPath?: unknown };
    return typeof value.browserPath === "string" && BROWSER_PATH_PATTERN.test(value.browserPath)
      ? value.browserPath
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Take the session's one CDP client slot for a relay. The supervisor holds it
 * while this connection stays open, so the relay must call `release` when it
 * ends; a crashed relay releases it when the kernel closes the socket.
 */
export function attachCdpClient(
  endpoint: CdpEndpoint,
  timeoutMs = 3_000,
): Promise<CdpClientLease> {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: endpoint.socketPath, method: "POST", path: "/attach" });
    const timer = setTimeout(() => request.destroy(new Error("Timed out attaching to the CDP socket")), timeoutMs);
    const fail = (error: Error): void => {
      clearTimeout(timer);
      request.destroy();
      reject(error);
    };
    request.once("error", fail);
    request.once("response", (response) => {
      if (response.statusCode === 409) {
        response.resume();
        fail(new CdpAlreadyAttachedError());
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        fail(new Error(`The CDP socket refused the client lease with HTTP ${response.statusCode}`));
        return;
      }
      readLeasePath(response).then((browserPath) => {
        clearTimeout(timer);
        // Once the lease is held, a later socket error just ends it.
        request.off("error", fail);
        request.on("error", () => {});
        resolve({
          browserEndpoint: cdpWebSocketUrl(endpoint.socketPath, browserPath),
          release: () => request.destroy(),
        });
      }, fail);
    });
    request.end();
  });
}

export type CdpEndpointResult =
  | { ok: true; endpoint: CdpEndpoint }
  | { ok: false; reason: "aborted" }
  | {
      ok: false;
      reason: "exited" | "timeout";
      diagnostics: string;
    };

export interface WaitForCdpEndpointOptions {
  /** The supervisor's `cdp-endpoint` file. */
  endpointFile: string;
  /** Authoritative Chrome daemon log path used for durable diagnostics. */
  logPath?: string;
  timeoutMs: number;
  /** Liveness probe for the Chrome process; a dead process ends the wait. */
  isAlive: () => boolean;
  signal?: AbortSignal;
  /** Endpoint readiness probe; injectable for deterministic unit tests. */
  isReady?: (endpoint: CdpEndpoint) => boolean | Promise<boolean>;
  probeTimeoutMs?: number;
  pollIntervalMs?: number;
}

function startupFailure(
  reason: "exited" | "timeout",
  opts: WaitForCdpEndpointOptions,
  published: boolean,
  endpointError?: string,
): CdpEndpointResult {
  return {
    ok: false,
    reason,
    diagnostics: formatChromeStartupDiagnostics({
      endpointFile: opts.endpointFile,
      reason,
      published,
      ...(opts.logPath === undefined ? {} : { logPath: opts.logPath }),
      ...(endpointError === undefined ? {} : { endpointError }),
    }),
  };
}

/**
 * Poll for a published endpoint file, a live recorded browser identity, and a
 * socket that answers `/json/version`. Fails fast if Chrome exits and returns
 * `timeout` if the complete readiness contract is not met in time.
 */
export async function waitForCdpEndpoint(
  opts: WaitForCdpEndpointOptions,
): Promise<CdpEndpointResult> {
  const poll = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + opts.timeoutMs;
  // Give each probe real time, but never more than the wait has left.
  const probeBudget =
    opts.probeTimeoutMs ?? Math.max(poll, DEFAULT_PROBE_TIMEOUT_MS);
  const probeTimeout = (): number =>
    Math.max(poll, Math.min(probeBudget, deadline - Date.now()));
  const isReady =
    opts.isReady ??
    ((endpoint: CdpEndpoint) =>
      probeCdpEndpoint(endpoint.socketPath, probeTimeout(), opts.signal));
  // Read through a function so cancellation that occurs during the awaited
  // probe is observed instead of being hidden by TypeScript's prior narrowing.
  const creationAborted = (): boolean => opts.signal?.aborted === true;
  for (;;) {
    if (creationAborted()) {
      return { ok: false, reason: "aborted" };
    }
    // The supervisor replaces an unsafe file when it publishes, so keep
    // polling, but report why the last read refused it.
    let endpointError: string | undefined;
    const endpoint = await readCdpEndpoint(opts.endpointFile).catch((error: unknown) => {
      endpointError = error instanceof Error ? error.message : String(error);
      return undefined;
    });
    if (endpoint !== undefined) {
      if (!opts.isAlive()) {
        return startupFailure("exited", opts, true);
      }
      const ready = await isReady(endpoint);
      if (creationAborted()) {
        return { ok: false, reason: "aborted" };
      }
      if (ready && opts.isAlive()) {
        return { ok: true, endpoint };
      }
    } else if (!opts.isAlive()) {
      return startupFailure("exited", opts, false, endpointError);
    }
    if (Date.now() >= deadline) {
      return startupFailure("timeout", opts, endpoint !== undefined, endpointError);
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
