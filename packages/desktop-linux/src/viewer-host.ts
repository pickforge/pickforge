import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import {
  getSession, startDaemon, stopOwnedDaemonGroup, processIdentityMatches, checkHumanLeaseBusy,
  HumanLeaseHeldError, readProcessIdentity, sessionDataDir, type EnvLike, type ProcessIdentity,
} from "@pickforge/lab-core";
import { withSessionVncLock, recoverStaleTakeoverLocked, SESSION_VNC_LOCK_TIMEOUT_MS } from "./session.js";
import { verifyOwnedDisplayTarget, type OwnedDisplayIdentity } from "./x11-target.js";
import {
  withViewerDir, readViewerPrivateFile, sessionViewerDir, readViewerLaunchRecord,
  stopNativeViewerProcesses, lstatViewerSocket, sameViewerSocket, removeDeadViewerReadiness,
} from "./viewer-state.js";
import {
  VIEWER_MESSAGE_MAX_BYTES, type NativeViewerHostIdentity, type ViewerHostRequest,
  type ViewerHostResponse, type ViewerControlEvent, type ViewerRequestOutcome,
} from "./viewer-host-protocol.js";

function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/** Validate readiness before connecting or signaling any recorded process. */
export function validNativeViewerHost(value: unknown, sessionId: string, env: EnvLike): value is NativeViewerHostIdentity {
  if (typeof value !== "object" || value === null) return false;
  const host = value as NativeViewerHostIdentity;
  if (typeof host.version !== "string" || !/^[0-9A-Za-z.+-]+$/.test(host.version)) return false;
  if (host.sessionId !== sessionId || !/^[a-f0-9]{32}$/.test(host.launchId)) return false;
  if (![host.pid, host.startTicks, host.viewerPid, host.viewerStartTicks, host.socketIno].every(positive)) return false;
  if (host.socketCtimeNs !== undefined && (typeof host.socketCtimeNs !== "string" || !/^[0-9]+$/.test(host.socketCtimeNs))) return false;
  return Number.isSafeInteger(host.socketDev) && host.socket === path.join(sessionViewerDir(sessionId, env), "host.sock");
}

function sameHost(actual: NativeViewerHostIdentity, expected: NativeViewerHostIdentity): boolean {
  if (typeof actual !== "object" || actual === null) return false;
  const keys: (keyof NativeViewerHostIdentity)[] = ["version", "sessionId", "launchId", "pid", "startTicks", "viewerPid", "viewerStartTicks", "socket", "socketIno", "socketDev", "socketCtimeNs"];
  return keys.every((key) => actual[key] === expected[key]);
}

async function assertHostSocket(host: NativeViewerHostIdentity): Promise<void> {
  if (!processIdentityMatches({ pid: host.pid, startTicks: host.startTicks }) ||
      !processIdentityMatches({ pid: host.viewerPid, startTicks: host.viewerStartTicks })) {
    throw new Error("Native viewer identity changed");
  }
  const stats = await lstatViewerSocket(host.socket);
  if (stats === undefined) throw new Error("Viewer socket unavailable");
  // Readiness without a ctime came from a host before #404 and cannot prove its socket.
  if (!sameViewerSocket(stats, { ...host }) || (stats.mode & 0o777n) !== 0o600n) throw new Error("Unsafe viewer socket");
}

export async function requestNativeViewerHost(host: NativeViewerHostIdentity, request: ViewerHostRequest): Promise<ViewerHostResponse> {
  await assertHostSocket(host);
  return new Promise((resolve, reject) => {
    const socket = net.connect(host.socket);
    let pending = Buffer.alloc(0);
    const timer = setTimeout(() => socket.destroy(new Error("Viewer host request timed out")), 2_000);
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > VIEWER_MESSAGE_MAX_BYTES) return socket.destroy(new Error("Viewer response too large"));
      const end = pending.indexOf(10);
      if (end < 0) return;
      try {
        const response = JSON.parse(pending.subarray(0, end).toString("utf8")) as ViewerHostResponse;
        if (response.ok !== true || !sameHost(response.host, host)) {
          throw new Error("Viewer host refused request or identity changed");
        }
        resolve(response);
        socket.destroy();
      } catch (error) { socket.destroy(error as Error); }
    });
    socket.once("error", reject);
    socket.once("close", () => { clearTimeout(timer); reject(new Error("Viewer host disconnected")); });
  });
}

/** Subscribe to one request or global control events. The host replays request state. */
export async function followNativeViewerRequest(host: NativeViewerHostIdentity, requestId: string | undefined, options: {
  signal: AbortSignal; timeoutMs: number; onTaken?: () => void; onReturned?: () => void; onReady?: () => void;
}): Promise<ViewerRequestOutcome> {
  await assertHostSocket(host);
  return new Promise((resolve) => {
    const socket = net.connect(host.socket);
    let settled = false;
    let cancellation: "cancelled" | "timeout" | undefined;
    let ready = false;
    let pending = Buffer.alloc(0);
    const finish = (outcome: ViewerRequestOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", cancel);
      socket.destroy();
      resolve(outcome);
    };
    const cancelWith = (outcome: "cancelled" | "timeout"): void => {
      if (settled || cancellation !== undefined) return;
      cancellation = outcome;
      if (requestId === undefined) { finish(outcome); return; }
      void requestNativeViewerHost(host, { op: "cancelRequest", requestId }).catch(() => {}).finally(() => finish(outcome));
    };
    const cancel = (): void => cancelWith("cancelled");
    const timer = setTimeout(() => cancelWith("timeout"), options.timeoutMs + 2_000);
    const apply = (event: ViewerControlEvent | undefined): void => {
      if (event === undefined || event.requestId !== requestId) return;
      if (event.event === "controlTaken") options.onTaken?.();
      if (event.event === "controlReturned") options.onReturned?.();
      if ("outcome" in event) finish(cancellation ?? event.outcome);
    };
    socket.once("connect", () => socket.write(`${JSON.stringify({ op: "subscribe", requestId })}\n`));
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.includes(10)) {
        const end = pending.indexOf(10);
        if (end > VIEWER_MESSAGE_MAX_BYTES) { socket.destroy(new Error("Viewer response too large")); return; }
        try {
          const value = JSON.parse(pending.subarray(0, end).toString("utf8"));
          pending = pending.subarray(end + 1);
          if (!ready) {
            if (value.ok !== true || !sameHost(value.host, host)) throw new Error("Viewer subscription refused");
            ready = true;
            apply(value.requestState);
            options.onReady?.();
          } else apply(value);
        } catch { socket.destroy(new Error("Invalid viewer subscription")); return; }
      }
      if (pending.length > VIEWER_MESSAGE_MAX_BYTES) socket.destroy(new Error("Viewer response too large"));
    });
    socket.once("error", () => finish(cancellation ?? "viewer_closed"));
    socket.once("close", () => finish(cancellation ?? "viewer_closed"));
    options.signal.addEventListener("abort", cancel, { once: true });
    if (options.signal.aborted) cancel();
  });
}

async function readNativeViewerHost(sessionId: string, env: EnvLike): Promise<NativeViewerHostIdentity | undefined> {
  return withViewerDir(sessionId, env, false, async (directory) => {
    const json = await readViewerPrivateFile(directory, "host.json");
    if (json === undefined) return undefined;
    const host: unknown = JSON.parse(json);
    return validNativeViewerHost(host, sessionId, env) ? host : undefined;
  });
}

export async function findNativeViewerHost(sessionId: string, env: EnvLike = process.env): Promise<NativeViewerHostIdentity | undefined> {
  try {
    const host = await readNativeViewerHost(sessionId, env);
    if (host !== undefined) await requestNativeViewerHost(host, { op: "status" });
    return host;
  } catch { return undefined; }
}

/** The longest a pulse socket stays open when its write cannot finish. */
const VIEWER_PULSE_TIMEOUT_MS = 300;

/**
 * Asks the session's native viewer to show a click at a point on the Xvfb that
 * verified for that click. It returns once the request is written and never
 * waits for a reply, so a stuck host cannot delay the click. Best effort: no
 * viewer, a dead host or any error is ignored.
 */
export async function pulseNativeViewer(
  sessionId: string, target: OwnedDisplayIdentity, point: { x: number; y: number }, env: EnvLike = process.env,
): Promise<void> {
  const request: ViewerHostRequest = { op: "pulse", x: point.x, y: point.y, xvfbPid: target.pid, xvfbStartTicks: target.startTicks };
  try {
    const host = await readNativeViewerHost(sessionId, env);
    if (host === undefined) return;
    await assertHostSocket(host);
    await new Promise<void>((resolve) => {
      const socket = net.connect(host.socket);
      const done = (): void => { socket.destroy(); resolve(); };
      socket.setTimeout(VIEWER_PULSE_TIMEOUT_MS, done);
      socket.once("error", done);
      socket.once("connect", () => socket.end(`${JSON.stringify(request)}\n`, done));
    });
  } catch { /* A pulse never changes the click result. */ }
}

export async function stopNativeViewerHost(sessionId: string, env: EnvLike = process.env): Promise<void> {
  const host = await findNativeViewerHost(sessionId, env);
  if (host !== undefined) {
    await requestNativeViewerHost(host, { op: "shutdown" }).catch(() => {});
    const deadline = Date.now() + 3_000;
    while (processIdentityMatches({ pid: host.pid, startTicks: host.startTicks }) && Date.now() < deadline) await sleep(25);
  }
  await withSessionVncLock(sessionId, env, () => stopNativeViewerHostLocked(sessionId, env));
}

/** Caller holds the session lock, so a concurrent start cannot publish readiness mid-stop. */
async function stopNativeViewerHostLocked(sessionId: string, env: EnvLike): Promise<void> {
  await withViewerDir(sessionId, env, false, async (directory) => {
    const json = await readViewerPrivateFile(directory, "host.json");
    if (json === undefined) return;
    const host: unknown = JSON.parse(json);
    if (!validNativeViewerHost(host, sessionId, env)) throw new Error("Invalid viewer host readiness");
    const hostAlive = processIdentityMatches({ pid: host.pid, startTicks: host.startTicks });
    const viewerAlive = processIdentityMatches({ pid: host.viewerPid, startTicks: host.viewerStartTicks });
    if (!hostAlive && !viewerAlive) {
      await removeDeadViewerReadiness(directory, { ...host });
      return;
    }
    const record = await readViewerLaunchRecord(sessionId, host.launchId, env);
    if (record?.kind !== "native" || record.hostPid !== host.pid || record.hostStartTicks !== host.startTicks) {
      throw new Error("Viewer launch identity differs from readiness");
    }
    if (record.viewerPid !== host.viewerPid || record.viewerStartTicks !== host.viewerStartTicks) {
      throw new Error("Viewer launch identity differs from readiness");
    }
    await stopNativeViewerProcesses(record);
  });
}

function cpuWaitMs(pid: number): number {
  try {
    const ns = Number(fs.readFileSync(`/proc/${pid}/schedstat`, "utf8").trim().split(/\s+/)[1]);
    return Number.isFinite(ns) && ns > 0 ? ns / 1e6 : 0;
  } catch { return 0; }
}

function assertStartedHost(host: NativeViewerHostIdentity, identity: ProcessIdentity, version: string): void {
  if (host.pid !== identity.pid || host.startTicks !== identity.startTicks || host.version !== version) {
    throw new Error("Native viewer host readiness identity differs");
  }
  if (!processIdentityMatches(identity) ||
      !processIdentityMatches({ pid: host.viewerPid, startTicks: host.viewerStartTicks })) {
    throw new Error("Native viewer host readiness identity differs");
  }
}

async function requireViewerDisplay(sessionId: string, env: EnvLike): Promise<void> {
  const record = await getSession(sessionId, env);
  if (record?.status !== "running" || record.desktop === undefined ||
      await verifyOwnedDisplayTarget(record.id, record.desktop.display, env) === undefined) {
    throw new Error("Native viewer requires a verified running desktop display");
  }
}

/**
 * A `--control` host takes the lease before it publishes readiness, while the
 * caller still holds the session lock. Recovering a stale lease needs that
 * lock, so it happens here first. A live lease refuses the start before the
 * previous host stops, so another human's control and the open viewer stay.
 */
async function requireFreeLeaseLocked(sessionId: string, env: EnvLike): Promise<void> {
  const record = await getSession(sessionId, env);
  if (record !== undefined) await recoverStaleTakeoverLocked(sessionId, record, env);
  const lease = await checkHumanLeaseBusy(sessionId, env);
  if (lease !== undefined) throw new HumanLeaseHeldError(lease);
}

/** Start one detached host per session, using the caller's graphical environment. */
export async function startNativeViewerHost(options: {
  sessionId: string; cliEntry: string; binary: string; version: string;
  env?: NodeJS.ProcessEnv; readyMs?: number; control?: boolean;
}): Promise<NativeViewerHostIdentity> {
  const env = options.env ?? process.env;
  sessionViewerDir(options.sessionId, env);
  return withSessionVncLock(options.sessionId, env, async () => {
    await requireViewerDisplay(options.sessionId, env);
    if (options.control === true) await requireFreeLeaseLocked(options.sessionId, env);
    const previous = await findNativeViewerHost(options.sessionId, env);
    if (options.control !== true) {
      if (previous?.version === options.version) return previous;
    }
    await withViewerDir(options.sessionId, env, true, async (directory) => {
      // A stale readiness file still identifies an unresponsive owned host.
      if (await readViewerPrivateFile(directory, "host.json") !== undefined) {
        await stopNativeViewerHostLocked(options.sessionId, env);
        await directory.unlinkChild("host.json");
      }
      const socket = await directory.lstatChild("host.sock");
      if (socket !== undefined) {
        if (!socket.isSocket() || socket.uid !== process.getuid?.()) throw new Error("Unsafe stale viewer socket");
        await directory.unlinkChild("host.sock");
      }
    });
    const daemon = await startDaemon(process.execPath, [options.cliEntry, "internal", "viewer-host",
      "--session", options.sessionId, "--binary", options.binary, "--viewer-version", options.version,
      ...(options.control === true ? ["--control"] : [])], {
      logDir: sessionDataDir(options.sessionId, env), name: "viewer-host", env, cleanEnv: true, owned: true,
    });
    const started = Date.now();
    const budget = options.readyMs ?? 12_000;
    const wallCap = Math.min(budget * 8, SESSION_VNC_LOCK_TIMEOUT_MS - 20_000);
    try {
      while (Date.now() - started < wallCap && Date.now() - started - cpuWaitMs(daemon.pid) < budget) {
        const identity = readProcessIdentity(daemon.pid);
        if (identity === undefined) throw new Error("Native viewer host exited during startup");
        const host = await findNativeViewerHost(options.sessionId, env);
        if (host !== undefined) {
          assertStartedHost(host, identity, options.version);
          daemon.release();
          return host;
        }
        await sleep(25);
      }
      throw new Error(`Native viewer host did not report readiness; see ${daemon.logPath}`);
    } catch (error) {
      if (!await stopOwnedDaemonGroup(daemon)) throw new Error("Native viewer startup cleanup failed");
      throw error;
    }
  });
}
