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
  listSessions,
  redactSecrets,
  sanitizeErrorText,
  type EnvLike,
  type SessionRecord,
} from "@pickforge/lab-core";
import { createDeferred } from "./deferred.js";
import {
  createDevtoolsEvidenceRecorder,
  type DevtoolsEvidenceRecorder,
} from "./devtools-evidence.js";
import { getBrowserSessionStatus, type BrowserSessionStatus } from "./session.js";
import {
  JsonRpcProtocolError,
  createJsonRpcWriteQueue,
  pumpJsonRpcNdjson,
  writeWithBackpressure,
  type JsonRpcHook,
  type JsonRpcIntercept,
  type JsonRpcMessage,
} from "./ndjson.js";

/** JSON-RPC error code for the stable "human control is active" busy response. */
export const TAKEOVER_BUSY_ERROR_CODE = -32050;
const TAKEOVER_BUSY_MESSAGE =
  "PickLab: human control is active; agent input is paused until control returns";

function jsonRpcRequestId(message: JsonRpcMessage): string | number | undefined {
  return typeof message.id === "string" || typeof message.id === "number"
    ? message.id
    : undefined;
}

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
    return {
      jsonrpc: "2.0",
      id,
      error: { code: TAKEOVER_BUSY_ERROR_CODE, message: TAKEOVER_BUSY_MESSAGE },
    };
  };
}

export const CHROME_DEVTOOLS_MCP_PACKAGE = "chrome-devtools-mcp";
export const CHROME_DEVTOOLS_MCP_VERSION = "1.5.0";
export const CHROME_DEVTOOLS_MCP_BIN = "./build/src/bin/chrome-devtools-mcp.js";

/** Maximum bytes retained for one unterminated upstream diagnostic line. */
export const DEFAULT_MAX_DIAGNOSTIC_LINE_BYTES = 64 * 1024;

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
type RelaySignal = (typeof SIGNALS)[number];

export interface DevtoolsMcpExecutable {
  packageJsonPath: string;
  packageRoot: string;
  binPath: string;
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
  return {
    packageJsonPath: resolvedManifest,
    packageRoot,
    binPath,
    version: CHROME_DEVTOOLS_MCP_VERSION,
  };
}

export interface LiveBrowserSession {
  record: SessionRecord;
  cdpPort: number;
  browserUrl: string;
}

export interface ResolveLiveBrowserSessionOptions {
  projectDir: string;
  env?: EnvLike;
  list?: (env: EnvLike) => Promise<SessionRecord[]>;
  status?: (id: string, env: EnvLike) => Promise<BrowserSessionStatus>;
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
  for (const record of projectBrowsers) {
    let status: BrowserSessionStatus;
    try {
      status = await (opts.status ?? getBrowserSessionStatus)(record.id, env);
    } catch {
      continue;
    }
    const cdpPort = status.cdpPort;
    if (
      !status.alive ||
      cdpPort === undefined ||
      !Number.isInteger(cdpPort) ||
      cdpPort < 1 ||
      cdpPort > 65_535
    ) {
      continue;
    }
    live.push({
      record,
      cdpPort,
      browserUrl: `http://127.0.0.1:${cdpPort}`,
    });
  }
  if (live.length === 0) {
    throw new Error(
      "No live browser session for this project; create one with: pickforge-lab session create --type browser",
    );
  }
  if (live.length > 1) {
    throw new Error(
      `Multiple live browser sessions for this project (${live.map(({ record }) => record.id).join(", ")}); destroy all but one`,
    );
  }
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

// eslint-disable-next-line max-lines-per-function, complexity -- Legacy gate debt: pickforge/pickforge#60
export async function runDevtoolsMcpRelay(
  opts: RunDevtoolsMcpRelayOptions,
): Promise<RelayExit> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const diagnostics = opts.diagnostics ?? process.stderr;
  const timeoutMs = opts.shutdownTimeoutMs ?? 1_000;
  const childEnv: NodeJS.ProcessEnv = {
    ...(opts.env ?? process.env),
    CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "true",
    CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "true",
  };
  const child = (opts.spawnProcess ?? spawn)(
    process.execPath,
    [
      opts.executable.binPath,
      "--browser-url",
      opts.session.browserUrl,
    ],
    {
      cwd: opts.cwd,
      env: childEnv,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  assertRelayChild(child);
  const { outcome: exit, exited } = observeChildExit(child);
  const inputAbort = new AbortController();
  let terminationRequested = false;
  // The intercept path (inputPump, answering directly on `output`) and the
  // normal child-response forward path (outputPump, also writing to `output`)
  // are two independent concurrent pumps that can both target the same
  // client-facing stream. A shared write queue fully orders every write
  // issued to `output` across both of them, so a busy-rejection response
  // interleaved with an in-flight child response can never produce a torn or
  // out-of-order frame on the wire (pickforge/pickforge#21 P1-D).
  const outputWriteQueue = createJsonRpcWriteQueue();
  const inputPump = pumpJsonRpcNdjson(input, child.stdin, {
    hook: opts.hooks?.beforeForward,
    intercept: opts.hooks?.intercept,
    interceptDestination: opts.hooks?.intercept === undefined ? undefined : output,
    interceptWriteSerializer: opts.hooks?.intercept === undefined ? undefined : outputWriteQueue,
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

  let eofTimer: NodeJS.Timeout | undefined;
  void inputPump.then(
    () => {
      eofTimer = setTimeout(() => {
        terminationRequested = true;
        void stopChild(child, exited, timeoutMs).catch(() => {});
      }, timeoutMs);
      eofTimer.unref();
    },
    () => {},
  );

  let signalKillTimer: NodeJS.Timeout | undefined;
  const signalSource = opts.signalSource ?? process;
  const handlers = new Map<RelaySignal, () => void>();
  for (const signal of SIGNALS) {
    const handler = (): void => {
      terminationRequested = true;
      child.kill(signal);
      if (signalKillTimer === undefined) {
        signalKillTimer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
        signalKillTimer.unref();
      }
    };
    handlers.set(signal, handler);
    signalSource.on(signal, handler);
  }

  try {
    const failedPump = Promise.race([
      pendingAfterSuccess(inputPump),
      pendingAfterSuccess(outputPump),
      pendingAfterSuccess(diagnosticsPump),
    ]);
    const outcome = await Promise.race([
      exit.then(
        (value) => ({ kind: "exit" as const, value }),
        (error: unknown) => ({ kind: "child-error" as const, error }),
      ),
      failedPump.catch((error: unknown) => ({ kind: "error" as const, error })),
    ]);
    if (outcome.kind === "child-error") {
      terminationRequested = true;
      inputAbort.abort();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      const stopping = stopChild(child, exited, timeoutMs);
      const pumpCleanup = Promise.allSettled([
        inputPump,
        outputPump,
        diagnosticsPump,
      ]);
      const stopped = await stopping;
      await pumpCleanup;
      throw new Error(
        `Chrome DevTools MCP relay failed: child process error: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)} (upstream exit ${stopped.code ?? stopped.signal ?? "unknown"})`,
      );
    }
    if (outcome.kind === "error") {
      if (terminationRequested) {
        const observed = await exited;
        inputAbort.abort();
        await Promise.allSettled([inputPump, outputPump, diagnosticsPump]);
        return observed;
      }
      terminationRequested = true;
      inputAbort.abort();
      const stopped = await stopChild(child, exited, timeoutMs);
      await Promise.allSettled([inputPump, outputPump, diagnosticsPump]);
      throw new Error(
        `Chrome DevTools MCP relay failed: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)} (upstream exit ${stopped.code ?? stopped.signal ?? "unknown"})`,
      );
    }
    inputAbort.abort();
    const [inputResult, outputResult] = await Promise.allSettled([
      inputPump,
      outputPump,
      diagnosticsPump,
    ]);
    if (!terminationRequested && outcome.value.signal === null) {
      if (
        inputResult.status === "rejected" &&
        inputResult.reason instanceof JsonRpcProtocolError
      ) {
        throw new Error(
          `Chrome DevTools MCP relay failed: ${inputResult.reason.message} (upstream exit ${outcome.value.code ?? "unknown"})`,
        );
      }
      if (outputResult.status === "rejected") {
        const reason = outputResult.reason;
        throw new Error(
          `Chrome DevTools MCP relay failed: ${reason instanceof Error ? reason.message : String(reason)} (upstream exit ${outcome.value.code ?? "unknown"})`,
        );
      }
    }
    return outcome.value;
  } finally {
    clearTimeout(eofTimer);
    clearTimeout(signalKillTimer);
    for (const [signal, handler] of handlers) {
      signalSource.off(signal, handler);
    }
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

export async function runProjectDevtoolsMcp(
  opts: RunProjectDevtoolsMcpOptions,
): Promise<RelayExit> {
  const [session, executable] = await Promise.all([
    resolveLiveBrowserSession({ projectDir: opts.projectDir, env: opts.env }),
    resolveDevtoolsMcpExecutable(),
  ]);
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
  const takeoverIntercept = createTakeoverBusyIntercept(session.record.id, opts.env);
  const hooksWithTakeoverGate: RelayHooks = {
    ...opts.hooks,
    intercept: async (message) => {
      const busy = await takeoverIntercept(message);
      return busy ?? (await opts.hooks?.intercept?.(message));
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
      shutdownTimeoutMs: opts.shutdownTimeoutMs,
      maxRecordBytes: opts.maxRecordBytes,
      maxDiagnosticLineBytes: opts.maxDiagnosticLineBytes,
    });
  } finally {
    await evidence?.flushPending();
  }
}
