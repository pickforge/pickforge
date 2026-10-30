import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { Readable, Writable } from "node:stream";
import {
  checkHumanLeaseBusy,
  getSession,
  isSessionInputClosed,
  listSessions,
  processIdentityMatches,
  redactSecrets,
  sanitizeErrorText,
  type EnvLike,
  type SessionRecord,
} from "@pickforge/lab-core";
import { createDeferred } from "./deferred.js";
import {
  SESSION_CHECK_FAILED_ERROR_CODE,
  SESSION_ENDED_ERROR_CODE,
  TAKEOVER_BUSY_ERROR_CODE,
  jsonRpcRequestId,
  relayErrorResponse,
} from "./devtools-errors.js";
import {
  createDevtoolsEvidenceRecorder,
  type DevtoolsEvidenceRecorder,
} from "./devtools-evidence.js";
import { createDevtoolsPermitGate, type DevtoolsPermitGate } from "./devtools-permits.js";
import {
  CdpAlreadyAttachedError,
  attachCdpClient,
  cdpWebSocketUrl,
  type CdpClientLease,
  type CdpEndpoint,
} from "./devtools.js";
import {
  getBrowserSessionStatus,
  readBrowserSessionCdpEndpoint,
  type BrowserSessionStatus,
} from "./session.js";
import {
  JsonRpcProtocolError,
  createJsonRpcWriteQueue,
  pumpJsonRpcNdjson,
  serializeJsonRpcMessage,
  writeWithBackpressure,
  type JsonRpcHook,
  type JsonRpcIntercept,
} from "./ndjson.js";

export {
  SESSION_CHECK_FAILED_ERROR_CODE,
  SESSION_ENDED_ERROR_CODE,
  TAKEOVER_BUSY_ERROR_CODE,
} from "./devtools-errors.js";

/**
 * Fail-closed human-takeover gate for the DevTools relay
 * (pickforge/pickforge#21): while the session's human lease is active, every
 * `tools/call` request is answered directly with a stable busy error instead
 * of ever reaching the child Chrome DevTools MCP process. Notifications (no
 * `id`) and non-tool-call requests pass through untouched.
 *
 * Evidencing asymmetry, by design: an MCP desktop-input tool blocked by the
 * same lease (`withAgentPermit`, in `@pickforge/lab-desktop-linux`) is
 * evidenced as an `"error"`-status action, because it runs inside
 * `withMcpEvidence`'s existing per-call action lifecycle. A blocked DevTools
 * relay request has no equivalent per-call evidence lifecycle to hook —
 * `beforeForward`/`afterResponse` are never invoked for an intercepted
 * record — so it is not recorded as an evidence action. Both still fail
 * closed identically; only the audit trail differs.
 */
export function createTakeoverBusyIntercept(
  sessionId: string,
  env: EnvLike | undefined,
): JsonRpcIntercept {
  return async (message) => {
    if (message.method !== "tools/call") return undefined;
    const id = jsonRpcRequestId(message);
    if (id === undefined) return undefined;
    const lease = await checkHumanLeaseBusy(sessionId, env);
    if (lease === undefined) return undefined;
    return relayErrorResponse(id, TAKEOVER_BUSY_ERROR_CODE);
  };
}

type BrowserLeg = NonNullable<SessionRecord["browser"]>;

function sameBrowser(browser: BrowserLeg | undefined, pinned: BrowserLeg): boolean {
  return (
    browser?.browserPid === pinned.browserPid &&
    browser.browserStartTimeTicks === pinned.browserStartTimeTicks
  );
}

async function isRelaySessionCurrent(
  session: LiveBrowserSession,
  env: EnvLike,
): Promise<boolean> {
  const pinned = session.record.browser;
  const record = await getSession(session.record.id, env);
  if (pinned === undefined || record?.status !== "running") return false;
  if (!sameBrowser(record.browser, pinned)) return false;
  if (await isSessionInputClosed(record.id, env)) return false;
  return processIdentityMatches({
    pid: pinned.browserPid,
    startTicks: pinned.browserStartTimeTicks,
  });
}

/**
 * Session-end gate for the DevTools relay (pickforge/pickforge#444): before
 * each `tools/call`, recheck that the relay's session is still running with
 * open agent input and the same live Chrome. Once that fails, every later
 * `tools/call` is answered with a stable error and never reaches the child.
 * A call that passes just before teardown cannot reach another browser: the
 * child is pinned to this session's own CDP socket, which teardown removes and
 * no other session uses. A check that cannot read the session refuses that
 * call with a separate error and checks again next time.
 */
export function createSessionEndedIntercept(
  session: LiveBrowserSession,
  env: EnvLike = process.env,
): JsonRpcIntercept {
  let ended = false;
  return async (message) => {
    if (message.method !== "tools/call") return undefined;
    const id = jsonRpcRequestId(message);
    if (id === undefined) return undefined;
    if (!ended) {
      let current: boolean;
      try {
        current = await isRelaySessionCurrent(session, env);
      } catch {
        // A read error refuses only this call; it does not prove the end.
        return relayErrorResponse(id, SESSION_CHECK_FAILED_ERROR_CODE);
      }
      ended = !current;
    }
    if (!ended) return undefined;
    return relayErrorResponse(id, SESSION_ENDED_ERROR_CODE);
  };
}

export const CHROME_DEVTOOLS_MCP_PACKAGE = "chrome-devtools-mcp";
export const CHROME_DEVTOOLS_MCP_VERSION = "1.5.0";
export const CHROME_DEVTOOLS_MCP_BIN = "./build/src/bin/chrome-devtools-mcp.js";
/** The upstream module that holds its CLI option table, next to the bin. */
const CHROME_DEVTOOLS_MCP_CLI_OPTIONS = "chrome-devtools-mcp-cli-options.js";

/**
 * chrome-devtools-mcp 1.5.0 refuses a `--wsEndpoint` that is not `ws:` or
 * `wss:`, although puppeteer and `ws` connect to `ws+unix:` as is. This
 * bootstrap lets that one option also take `ws+unix:` and then runs the
 * upstream entry point unchanged. argv: <cli options module> <bin> [args...]
 */
const DEVTOOLS_MCP_BOOTSTRAP = String.raw`
import { pathToFileURL } from "node:url";
const [optionsPath, binPath, ...args] = process.argv.slice(1);
const { cliOptions } = await import(pathToFileURL(optionsPath).href);
const coerce = cliOptions?.wsEndpoint?.coerce;
if (typeof coerce !== "function") {
  throw new Error("Unsupported chrome-devtools-mcp: --wsEndpoint has no validator to extend");
}
cliOptions.wsEndpoint.coerce = (url) =>
  typeof url === "string" && url.startsWith("ws+unix:") ? url : coerce(url);
process.argv = [process.argv[0], binPath, ...args];
await import(pathToFileURL(binPath).href);
`;

/** Maximum bytes retained for one unterminated upstream diagnostic line. */
export const DEFAULT_MAX_DIAGNOSTIC_LINE_BYTES = 64 * 1024;

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
type RelaySignal = (typeof SIGNALS)[number];

export interface DevtoolsMcpExecutable {
  packageJsonPath: string;
  packageRoot: string;
  binPath: string;
  /** The bin's own CLI option module, which the relay bootstrap extends. */
  cliOptionsPath: string;
  version: typeof CHROME_DEVTOOLS_MCP_VERSION;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function resolveDevtoolsMcpExecutable(
  packageJsonPath = createRequire(import.meta.url).resolve(
    `${CHROME_DEVTOOLS_MCP_PACKAGE}/package.json`,
  ),
): Promise<DevtoolsMcpExecutable> {
  const resolvedManifest = await fs.promises.realpath(packageJsonPath);
  let manifest: unknown;
  try {
    manifest = JSON.parse(await fs.promises.readFile(resolvedManifest, "utf8"));
  } catch (error) {
    throw new Error(
      `Invalid ${CHROME_DEVTOOLS_MCP_PACKAGE} manifest: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isObject(manifest)) {
    throw new Error(`Invalid ${CHROME_DEVTOOLS_MCP_PACKAGE} manifest: expected an object`);
  }
  if (manifest.name !== CHROME_DEVTOOLS_MCP_PACKAGE) {
    throw new Error(
      `Invalid Chrome DevTools MCP package name: expected ${CHROME_DEVTOOLS_MCP_PACKAGE}, got ${String(manifest.name)}`,
    );
  }
  if (manifest.version !== CHROME_DEVTOOLS_MCP_VERSION) {
    throw new Error(
      `Chrome DevTools MCP version mismatch: expected ${CHROME_DEVTOOLS_MCP_VERSION}, got ${String(manifest.version)}`,
    );
  }
  if (!isObject(manifest.bin)) {
    throw new Error("Invalid Chrome DevTools MCP manifest: missing bin map");
  }
  const declaredBin = manifest.bin[CHROME_DEVTOOLS_MCP_PACKAGE];
  if (declaredBin !== CHROME_DEVTOOLS_MCP_BIN) {
    throw new Error(
      `Invalid Chrome DevTools MCP bin: expected ${CHROME_DEVTOOLS_MCP_BIN}, got ${String(declaredBin)}`,
    );
  }

  const packageRoot = await fs.promises.realpath(path.dirname(resolvedManifest));
  const lexicalBin = path.resolve(packageRoot, declaredBin);
  if (!isPathInside(packageRoot, lexicalBin)) {
    throw new Error("Invalid Chrome DevTools MCP bin path: path escapes its package");
  }
  const binPath = await fs.promises.realpath(lexicalBin).catch((error: unknown) => {
    throw new Error(
      `Invalid Chrome DevTools MCP bin path: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  if (!isPathInside(packageRoot, binPath)) {
    throw new Error("Invalid Chrome DevTools MCP bin path: symlink escapes its package");
  }
  if (!(await fs.promises.stat(binPath)).isFile()) {
    throw new Error("Invalid Chrome DevTools MCP bin path: expected a regular file");
  }
  const cliOptionsPath = path.join(path.dirname(binPath), CHROME_DEVTOOLS_MCP_CLI_OPTIONS);
  const cliOptionsStat = await fs.promises.lstat(cliOptionsPath).catch(() => undefined);
  if (cliOptionsStat?.isFile() !== true) {
    throw new Error("Invalid Chrome DevTools MCP package: missing its CLI option module");
  }
  return {
    packageJsonPath: resolvedManifest,
    packageRoot,
    binPath,
    cliOptionsPath,
    version: CHROME_DEVTOOLS_MCP_VERSION,
  };
}

export interface LiveBrowserSession {
  record: SessionRecord;
  /** The endpoint the session's supervisor published. */
  cdpEndpoint: CdpEndpoint;
  /**
   * The `ws+unix:` endpoint the upstream child connects to. It names this
   * session's own CDP socket, which teardown removes, so the child can never
   * reach another browser.
   */
  browserEndpoint: string;
}

export interface ResolveLiveBrowserSessionOptions {
  projectDir: string;
  env?: EnvLike;
  list?: (env: EnvLike) => Promise<SessionRecord[]>;
  status?: (id: string, env: EnvLike) => Promise<BrowserSessionStatus>;
  endpoint?: (record: SessionRecord, env: EnvLike) => Promise<CdpEndpoint | undefined>;
}

/**
 * A session record from before pickforge/pickforge#459 names the TCP port its
 * Chrome served CDP on. It still runs and tears down, but has no CDP socket.
 */
function isLegacyTcpSession(record: SessionRecord): boolean {
  return record.browser !== undefined && "cdpPort" in record.browser;
}

function legacySessionError(record: SessionRecord): Error {
  return new Error(
    `Browser session ${record.id} was created by an older Pickforge that served DevTools on a TCP port, ` +
      `which the relay no longer uses; destroy it with "pickforge-lab session destroy ${record.id}" and create a new one`,
  );
}

export async function resolveLiveBrowserSession(
  opts: ResolveLiveBrowserSessionOptions,
): Promise<LiveBrowserSession> {
  const env = opts.env ?? process.env;
  const projectDir = path.resolve(opts.projectDir);
  const records = await (opts.list ?? listSessions)(env);
  const projectBrowsers = records.filter(
    (record) =>
      record.status === "running" &&
      record.browser !== undefined &&
      path.resolve(record.projectDir) === projectDir,
  );
  const live: LiveBrowserSession[] = [];
  const legacy: SessionRecord[] = [];
  for (const record of projectBrowsers) {
    let status: BrowserSessionStatus;
    try {
      status = await (opts.status ?? getBrowserSessionStatus)(record.id, env);
    } catch {
      continue;
    }
    if (!status.alive) continue;
    if (isLegacyTcpSession(record)) {
      legacy.push(record);
      continue;
    }
    const cdpEndpoint = await (
      opts.endpoint ?? ((own: SessionRecord, ownEnv: EnvLike) => readBrowserSessionCdpEndpoint(own.id, ownEnv))
    )(record, env).catch(() => undefined);
    if (cdpEndpoint === undefined) continue;
    live.push({
      record,
      cdpEndpoint,
      browserEndpoint: cdpWebSocketUrl(cdpEndpoint.socketPath, cdpEndpoint.browserPath),
    });
  }
  const found = [...live.map(({ record }) => record), ...legacy];
  if (found.length === 0) {
    throw new Error(
      "No live browser session for this project; create one with: pickforge-lab session create --type browser",
    );
  }
  if (found.length > 1) {
    throw new Error(
      `Multiple live browser sessions for this project (${found.map(({ id }) => id).join(", ")}); destroy all but one`,
    );
  }
  if (legacy[0] !== undefined) throw legacySessionError(legacy[0]);
  return live[0] as LiveBrowserSession;
}

export interface RelayHooks {
  beforeForward?: JsonRpcHook;
  afterResponse?: JsonRpcHook;
  /**
   * Checked before `beforeForward` on every agent -> child record. Returning
   * a message answers the caller directly on `output` and the record is
   * never forwarded to the child — used for the human-takeover fail-closed
   * busy response (pickforge/pickforge#21). See `JsonRpcIntercept`.
   */
  intercept?: JsonRpcIntercept;
}

/** Hold a permit for each forwarded call: the gate's intercept runs last. */
function composePermitHooks(
  hooks: RelayHooks | undefined,
  permits: DevtoolsPermitGate | undefined,
): RelayHooks | undefined {
  if (permits === undefined) return hooks;
  return {
    beforeForward: hooks?.beforeForward,
    intercept: async (message) =>
      (await hooks?.intercept?.(message)) ?? (await permits.intercept(message)),
    afterResponse: async (message) => {
      await permits.release(message);
      return hooks?.afterResponse?.(message);
    },
  };
}

function composeEvidenceHooks(
  hooks: RelayHooks | undefined,
  evidence: DevtoolsEvidenceRecorder | undefined,
): RelayHooks | undefined {
  if (evidence === undefined) return hooks;
  return {
    beforeForward: async (message) => {
      const transformed = await hooks?.beforeForward?.(message);
      await evidence.beforeForward(transformed ?? message);
      return transformed;
    },
    afterResponse: async (message) => {
      await evidence.afterResponse(message);
      return hooks?.afterResponse?.(message);
    },
    intercept: hooks?.intercept,
  };
}

export interface RelayExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface RelaySignalSource {
  on(signal: RelaySignal, listener: () => void): unknown;
  off(signal: RelaySignal, listener: () => void): unknown;
}

export type DevtoolsSpawn = (
  command: string,
  args: string[],
  opts: SpawnOptions,
) => ChildProcess;

interface RelayChild extends ChildProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
}

function assertRelayChild(child: ChildProcess): asserts child is RelayChild {
  if (child.stdin === null || child.stdout === null || child.stderr === null) {
    throw new Error("Chrome DevTools MCP child did not expose piped stdio");
  }
}

export interface RunDevtoolsMcpRelayOptions {
  session: LiveBrowserSession;
  executable: DevtoolsMcpExecutable;
  input?: Readable;
  output?: Writable;
  diagnostics?: Writable;
  env?: EnvLike;
  cwd?: string;
  hooks?: RelayHooks;
  /** Agent permits for forwarded calls; see `createDevtoolsPermitGate`. */
  permits?: DevtoolsPermitGate;
  spawnProcess?: DevtoolsSpawn;
  signalSource?: RelaySignalSource;
  shutdownTimeoutMs?: number;
  maxRecordBytes?: number;
  maxDiagnosticLineBytes?: number;
}

interface ChildObservation {
  outcome: Promise<RelayExit>;
  exited: Promise<RelayExit>;
}

function observeChildExit(child: ChildProcess): ChildObservation {
  const outcome = createDeferred<RelayExit>();
  const exited = createDeferred<RelayExit>();
  child.once("error", outcome.reject);
  child.once("exit", (code, signal) => {
    const observed = { code, signal };
    outcome.resolve(observed);
    exited.resolve(observed);
  });
  child.once("close", (code, signal) => {
    exited.resolve({ code, signal });
  });
  return { outcome: outcome.promise, exited: exited.promise };
}

async function pumpRedactedDiagnostics(
  source: Readable,
  destination: Writable,
  maxLineBytes: number,
): Promise<void> {
  if (!Number.isInteger(maxLineBytes) || maxLineBytes < 1) {
    throw new Error("maxDiagnosticLineBytes must be a positive integer");
  }
  let buffered = Buffer.alloc(0);
  let droppingLine = false;
  for await (const value of source) {
    const chunk = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
    let offset = 0;
    while (offset < chunk.length) {
      const lf = chunk.indexOf(0x0a, offset);
      const segmentEnd = lf === -1 ? chunk.length : lf + 1;
      const segment = chunk.subarray(offset, segmentEnd);
      if (droppingLine) {
        if (lf !== -1) {
          droppingLine = false;
        }
      } else if (buffered.length + segment.length > maxLineBytes) {
        buffered = Buffer.alloc(0);
        await writeWithBackpressure(
          destination,
          Buffer.from(
            `[pickforge-lab: upstream diagnostic line exceeded ${maxLineBytes} bytes and was dropped]\n`,
          ),
        );
        droppingLine = lf === -1;
      } else if (lf === -1) {
        buffered =
          buffered.length === 0
            ? Buffer.from(segment)
            : Buffer.concat([buffered, segment]);
      } else {
        const line =
          buffered.length === 0
            ? Buffer.from(segment)
            : Buffer.concat([buffered, segment]);
        buffered = Buffer.alloc(0);
        await writeWithBackpressure(
          destination,
          Buffer.from(redactSecrets(line.toString("utf8"))),
        );
      }
      offset = segmentEnd;
    }
  }
  if (!droppingLine && buffered.length > 0) {
    await writeWithBackpressure(
      destination,
      Buffer.from(redactSecrets(buffered.toString("utf8"))),
    );
  }
}

function pendingAfterSuccess(promise: Promise<void>): Promise<never> {
  const pending = createDeferred<never>();
  return promise.then(() => pending.promise);
}

async function stopChild(
  child: ChildProcess,
  exit: Promise<RelayExit>,
  timeoutMs: number,
): Promise<RelayExit> {
  child.kill("SIGTERM");
  const timedOut = Symbol("timed-out");
  const first = await Promise.race([
    exit,
    delay(timeoutMs, timedOut, { ref: false }),
  ]);
  if (first !== timedOut) {
    return first;
  }
  child.kill("SIGKILL");
  return exit;
}

function spawnDevtoolsRelayChild(opts: RunDevtoolsMcpRelayOptions): RelayChild {
  const childEnv: NodeJS.ProcessEnv = {
    ...(opts.env ?? process.env),
    CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "true",
    CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "true",
  };
  const child = (opts.spawnProcess ?? spawn)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      DEVTOOLS_MCP_BOOTSTRAP,
      opts.executable.cliOptionsPath,
      opts.executable.binPath,
      "--wsEndpoint",
      opts.session.browserEndpoint,
    ],
    {
      cwd: opts.cwd,
      env: childEnv,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  assertRelayChild(child);
  return child;
}

interface RelayPumps {
  inputPump: Promise<void>;
  outputPump: Promise<void>;
  diagnosticsPump: Promise<void>;
  inputAbort: AbortController;
}

function startRelayPumps(
  child: RelayChild,
  opts: RunDevtoolsMcpRelayOptions,
  input: Readable,
  output: Writable,
  diagnostics: Writable,
): RelayPumps {
  const inputAbort = new AbortController();
  // The intercept path (inputPump, answering directly on `output`) and the
  // normal child-response forward path (outputPump, also writing to `output`)
  // are two independent concurrent pumps that can both target the same
  // client-facing stream. A shared write queue fully orders every write
  // issued to `output` across both of them, so a busy-rejection response
  // interleaved with an in-flight child response can never produce a torn or
  // out-of-order frame on the wire (pickforge/pickforge#21 P1-D).
  const outputWriteQueue = createJsonRpcWriteQueue();
  const intercept = opts.hooks?.intercept;
  const inputPump = pumpJsonRpcNdjson(input, child.stdin, {
    hook: opts.hooks?.beforeForward,
    intercept,
    interceptDestination: intercept === undefined ? undefined : output,
    interceptWriteSerializer:
      intercept === undefined ? undefined : outputWriteQueue,
    signal: inputAbort.signal,
    endDestination: true,
    maxRecordBytes: opts.maxRecordBytes,
  });
  const outputPump = pumpJsonRpcNdjson(child.stdout, output, {
    hook: opts.hooks?.afterResponse,
    writeSerializer: outputWriteQueue,
    maxRecordBytes: opts.maxRecordBytes,
  });
  const diagnosticsPump = pumpRedactedDiagnostics(
    child.stderr,
    diagnostics,
    opts.maxDiagnosticLineBytes ?? DEFAULT_MAX_DIAGNOSTIC_LINE_BYTES,
  );
  return { inputPump, outputPump, diagnosticsPump, inputAbort };
}

interface RelayTermination {
  requested: boolean;
  eofTimer?: NodeJS.Timeout;
  signalKillTimer?: NodeJS.Timeout;
  handlers: Map<RelaySignal, () => void>;
  signalSource: RelaySignalSource;
}

function armRelayEofShutdown(
  pumps: RelayPumps,
  child: ChildProcess,
  exited: Promise<RelayExit>,
  timeoutMs: number,
  termination: RelayTermination,
): void {
  void pumps.inputPump.then(
    () => {
      termination.eofTimer = setTimeout(() => {
        termination.requested = true;
        void stopChild(child, exited, timeoutMs).catch(() => {});
      }, timeoutMs);
      termination.eofTimer.unref();
    },
    () => {},
  );
}

function attachRelaySignalHandlers(
  child: ChildProcess,
  timeoutMs: number,
  termination: RelayTermination,
): void {
  for (const signal of SIGNALS) {
    const handler = (): void => {
      termination.requested = true;
      child.kill(signal);
      if (termination.signalKillTimer === undefined) {
        termination.signalKillTimer = setTimeout(
          () => child.kill("SIGKILL"),
          timeoutMs,
        );
        termination.signalKillTimer.unref();
      }
    };
    termination.handlers.set(signal, handler);
    termination.signalSource.on(signal, handler);
  }
}

function detachRelaySignalHandlers(termination: RelayTermination): void {
  clearTimeout(termination.eofTimer);
  clearTimeout(termination.signalKillTimer);
  for (const [signal, handler] of termination.handlers) {
    termination.signalSource.off(signal, handler);
  }
}

type RelayRace =
  | { kind: "exit"; value: RelayExit }
  | { kind: "input-closed"; permits: DevtoolsPermitGate }
  | { kind: "child-error"; error: unknown }
  | { kind: "error"; error: unknown };

async function raceRelayOutcome(
  exit: Promise<RelayExit>,
  pumps: RelayPumps,
  permits: DevtoolsPermitGate | undefined,
): Promise<RelayRace> {
  const failedPump = Promise.race([
    pendingAfterSuccess(pumps.inputPump),
    pendingAfterSuccess(pumps.outputPump),
    pendingAfterSuccess(pumps.diagnosticsPump),
  ]);
  return Promise.race([
    exit.then(
      (value) => ({ kind: "exit" as const, value }),
      (error: unknown) => ({ kind: "child-error" as const, error }),
    ),
    failedPump.catch((error: unknown) => ({ kind: "error" as const, error })),
    ...(permits === undefined
      ? []
      : [permits.inputClosed.then(() => ({ kind: "input-closed" as const, permits }))]),
  ]);
}

function relayFailureMessage(prefix: string, error: unknown, upstream: string): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `Chrome DevTools MCP relay failed: ${prefix}${detail} (upstream exit ${upstream})`;
}

async function failOnRelayChildError(
  outcome: Extract<RelayRace, { kind: "child-error" }>,
  child: RelayChild,
  pumps: RelayPumps,
  exited: Promise<RelayExit>,
  timeoutMs: number,
  termination: RelayTermination,
): Promise<never> {
  termination.requested = true;
  pumps.inputAbort.abort();
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
  const stopping = stopChild(child, exited, timeoutMs);
  const pumpCleanup = Promise.allSettled([
    pumps.inputPump,
    pumps.outputPump,
    pumps.diagnosticsPump,
  ]);
  const stopped = await stopping;
  await pumpCleanup;
  throw new Error(
    relayFailureMessage(
      "child process error: ",
      outcome.error,
      String(stopped.code ?? stopped.signal ?? "unknown"),
    ),
  );
}

async function settleRelayPumps(pumps: RelayPumps): Promise<
  [PromiseSettledResult<void>, PromiseSettledResult<void>, PromiseSettledResult<void>]
> {
  return Promise.allSettled([
    pumps.inputPump,
    pumps.outputPump,
    pumps.diagnosticsPump,
  ]);
}

async function failOnRelayPumpError(
  outcome: Extract<RelayRace, { kind: "error" }>,
  child: RelayChild,
  pumps: RelayPumps,
  exited: Promise<RelayExit>,
  timeoutMs: number,
  termination: RelayTermination,
): Promise<RelayExit> {
  if (termination.requested) {
    const observed = await exited;
    pumps.inputAbort.abort();
    await settleRelayPumps(pumps);
    return observed;
  }
  termination.requested = true;
  pumps.inputAbort.abort();
  const stopped = await stopChild(child, exited, timeoutMs);
  await settleRelayPumps(pumps);
  throw new Error(
    relayFailureMessage(
      "",
      outcome.error,
      String(stopped.code ?? stopped.signal ?? "unknown"),
    ),
  );
}

function throwIfRelayPumpsFailed(
  inputResult: PromiseSettledResult<void>,
  outputResult: PromiseSettledResult<void>,
  exit: RelayExit,
): void {
  if (
    inputResult.status === "rejected" &&
    inputResult.reason instanceof JsonRpcProtocolError
  ) {
    throw new Error(
      relayFailureMessage("", inputResult.reason, String(exit.code ?? "unknown")),
    );
  }
  if (outputResult.status === "rejected") {
    throw new Error(
      relayFailureMessage("", outputResult.reason, String(exit.code ?? "unknown")),
    );
  }
}

/**
 * Teardown closed session input while forwarded calls were unanswered: stop
 * the child, release the permits once it exited and so no call can reach
 * Chrome, then answer each unanswered call after the child's output settled,
 * so no late child response can follow that answer.
 */
async function endRelayForClosedInput(
  child: RelayChild,
  pumps: RelayPumps,
  exited: Promise<RelayExit>,
  timeoutMs: number,
  permits: DevtoolsPermitGate,
  output: Writable,
): Promise<RelayExit> {
  pumps.inputAbort.abort();
  const stopped = await stopChild(child, exited, timeoutMs);
  await permits.close();
  await settleRelayPumps(pumps);
  for (const message of permits.takeUnanswered()) {
    await writeWithBackpressure(output, serializeJsonRpcMessage(message)).catch(() => {});
  }
  return stopped;
}

async function finishRelayExit(
  outcome: Extract<RelayRace, { kind: "exit" }>,
  pumps: RelayPumps,
  termination: RelayTermination,
): Promise<RelayExit> {
  pumps.inputAbort.abort();
  const [inputResult, outputResult] = await settleRelayPumps(pumps);
  if (!termination.requested && outcome.value.signal === null) {
    throwIfRelayPumpsFailed(inputResult, outputResult, outcome.value);
  }
  return outcome.value;
}

export async function runDevtoolsMcpRelay(
  opts: RunDevtoolsMcpRelayOptions,
): Promise<RelayExit> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const diagnostics = opts.diagnostics ?? process.stderr;
  const timeoutMs = opts.shutdownTimeoutMs ?? 1_000;
  const child = spawnDevtoolsRelayChild(opts);
  const { outcome: exit, exited } = observeChildExit(child);
  // Once the child is gone, no held call can reach Chrome. Release at once,
  // so an output that cannot drain never holds up a teardown drain.
  void exited.then(() => opts.permits?.close());
  const hooks = composePermitHooks(opts.hooks, opts.permits);
  const pumps = startRelayPumps(child, { ...opts, hooks }, input, output, diagnostics);
  const termination: RelayTermination = {
    requested: false,
    handlers: new Map(),
    signalSource: opts.signalSource ?? process,
  };
  armRelayEofShutdown(pumps, child, exited, timeoutMs, termination);
  attachRelaySignalHandlers(child, timeoutMs, termination);
  try {
    const outcome = await raceRelayOutcome(exit, pumps, opts.permits);
    if (outcome.kind === "input-closed") {
      termination.requested = true;
      return await endRelayForClosedInput(
        child,
        pumps,
        exited,
        timeoutMs,
        outcome.permits,
        output,
      );
    }
    if (outcome.kind === "child-error") {
      return await failOnRelayChildError(
        outcome,
        child,
        pumps,
        exited,
        timeoutMs,
        termination,
      );
    }
    if (outcome.kind === "error") {
      return await failOnRelayPumpError(
        outcome,
        child,
        pumps,
        exited,
        timeoutMs,
        termination,
      );
    }
    return await finishRelayExit(outcome, pumps, termination);
  } finally {
    detachRelaySignalHandlers(termination);
    // Every path settled the input pump, so nothing reads the input any more.
    // An open one, such as the client's stdin, would keep the relay alive.
    input.destroy();
    // Every exit releases the held permits. A relay killed outright leaves
    // files whose dead owner the next drain sweeps.
    await opts.permits?.close();
  }
}

export interface RunProjectDevtoolsMcpOptions {
  projectDir: string;
  env?: EnvLike;
  input?: Readable;
  output?: Writable;
  diagnostics?: Writable;
  hooks?: RelayHooks;
  shutdownTimeoutMs?: number;
  maxRecordBytes?: number;
  maxDiagnosticLineBytes?: number;
}

function reportProjectEvidenceFailure(
  destination: Writable,
  error: unknown,
): void {
  const detail = sanitizeErrorText(
    error instanceof Error ? error.message : String(error),
  );
  void writeWithBackpressure(
    destination,
    Buffer.from(`[pickforge-lab evidence] chrome-devtools: ${detail}\n`),
  ).catch(() => {});
}

/**
 * Take the session's one CDP client slot for this relay. A second relay on the
 * same session fails here, before its upstream child starts.
 */
async function attachRelayClient(session: LiveBrowserSession): Promise<CdpClientLease> {
  try {
    return await attachCdpClient(session.cdpEndpoint);
  } catch (error) {
    if (error instanceof CdpAlreadyAttachedError) {
      throw new Error(
        `Browser session ${session.record.id} is already attached to another DevTools relay; stop that relay first`,
        { cause: error },
      );
    }
    throw error;
  }
}

export async function runProjectDevtoolsMcp(
  opts: RunProjectDevtoolsMcpOptions,
): Promise<RelayExit> {
  const [resolved, executable] = await Promise.all([
    resolveLiveBrowserSession({ projectDir: opts.projectDir, env: opts.env }),
    resolveDevtoolsMcpExecutable(),
  ]);
  const lease = await attachRelayClient(resolved);
  try {
    return await runLeasedProjectRelay(opts, { ...resolved, browserEndpoint: lease.browserEndpoint }, executable);
  } finally {
    lease.release();
  }
}

async function runLeasedProjectRelay(
  opts: RunProjectDevtoolsMcpOptions,
  session: LiveBrowserSession,
  executable: DevtoolsMcpExecutable,
): Promise<RelayExit> {
  const diagnostics = opts.diagnostics ?? process.stderr;
  let evidenceFailureReported = false;
  const reportEvidenceFailure = (error: unknown): void => {
    if (evidenceFailureReported) return;
    evidenceFailureReported = true;
    reportProjectEvidenceFailure(diagnostics, error);
  };
  let evidence: DevtoolsEvidenceRecorder | undefined;
  try {
    evidence = await createDevtoolsEvidenceRecorder({
      projectDir: opts.projectDir,
      sessionId: session.record.id,
      env: opts.env,
      reportFailure: reportEvidenceFailure,
    });
  } catch (error) {
    reportEvidenceFailure(error);
  }
  const sessionEndedIntercept = createSessionEndedIntercept(session, opts.env);
  const takeoverIntercept = createTakeoverBusyIntercept(session.record.id, opts.env);
  const hooksWithTakeoverGate: RelayHooks = {
    ...opts.hooks,
    intercept: async (message) => {
      const blocked =
        (await sessionEndedIntercept(message)) ??
        (await takeoverIntercept(message));
      return blocked ?? (await opts.hooks?.intercept?.(message));
    },
  };
  try {
    return await runDevtoolsMcpRelay({
      session,
      executable,
      input: opts.input,
      output: opts.output,
      diagnostics,
      env: opts.env,
      cwd: path.resolve(opts.projectDir),
      hooks: composeEvidenceHooks(hooksWithTakeoverGate, evidence),
      permits: createDevtoolsPermitGate(session.record.id, opts.env),
      shutdownTimeoutMs: opts.shutdownTimeoutMs,
      maxRecordBytes: opts.maxRecordBytes,
      maxDiagnosticLineBytes: opts.maxDiagnosticLineBytes,
    });
  } finally {
    await evidence?.flushPending();
  }
}
