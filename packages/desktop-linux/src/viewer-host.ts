import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import {
  getSession, startDaemon, stopOwnedDaemonGroup, processIdentityMatches,
  readProcessIdentity, sessionDataDir, type EnvLike, type ProcessIdentity,
} from "@pickforge/lab-core";
import { withSessionVncLock, SESSION_VNC_LOCK_TIMEOUT_MS } from "./session.js";
import { verifyOwnedDisplayTarget } from "./x11-target.js";
import {
  withViewerDir, readViewerPrivateFile, sessionViewerDir, readViewerLaunchRecord,
  stopNativeViewerProcesses,
} from "./viewer-state.js";
import {
  VIEWER_MESSAGE_MAX_BYTES, type NativeViewerHostIdentity, type ViewerHostRequest,
  type ViewerHostResponse,
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
  return Number.isSafeInteger(host.socketDev) && host.socket === path.join(sessionViewerDir(sessionId, env), "host.sock");
}

function sameHost(actual: NativeViewerHostIdentity, expected: NativeViewerHostIdentity): boolean {
  if (typeof actual !== "object" || actual === null) return false;
  const keys: (keyof NativeViewerHostIdentity)[] = ["version", "sessionId", "launchId", "pid", "startTicks", "viewerPid", "viewerStartTicks", "socket", "socketIno", "socketDev"];
  return keys.every((key) => actual[key] === expected[key]);
}

export async function requestNativeViewerHost(host: NativeViewerHostIdentity, request: ViewerHostRequest): Promise<ViewerHostResponse> {
  if (!processIdentityMatches({ pid: host.pid, startTicks: host.startTicks }) ||
      !processIdentityMatches({ pid: host.viewerPid, startTicks: host.viewerStartTicks })) {
    throw new Error("Native viewer identity changed");
  }
  const stats = await fs.promises.lstat(host.socket);
  if (!stats.isSocket() || stats.uid !== process.getuid?.() || (stats.mode & 0o777) !== 0o600) {
    throw new Error("Unsafe viewer socket");
  }
  if (stats.ino !== host.socketIno || stats.dev !== host.socketDev) throw new Error("Unsafe viewer socket");
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

export async function findNativeViewerHost(sessionId: string, env: EnvLike = process.env): Promise<NativeViewerHostIdentity | undefined> {
  try {
    return await withViewerDir(sessionId, env, false, async (directory) => {
      const json = await readViewerPrivateFile(directory, "host.json");
      if (json === undefined) return undefined;
      const host: unknown = JSON.parse(json);
      if (!validNativeViewerHost(host, sessionId, env)) return undefined;
      await requestNativeViewerHost(host, { op: "status" });
      return host;
    });
  } catch { return undefined; }
}

export async function stopNativeViewerHost(sessionId: string, env: EnvLike = process.env): Promise<void> {
  await withViewerDir(sessionId, env, false, async (directory) => {
    const json = await readViewerPrivateFile(directory, "host.json");
    if (json === undefined) return;
    const host: unknown = JSON.parse(json);
    if (!validNativeViewerHost(host, sessionId, env)) throw new Error("Invalid viewer host readiness");
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

/** Start one detached host per session, using the caller's graphical environment. */
export async function startNativeViewerHost(options: {
  sessionId: string; cliEntry: string; binary: string; version: string;
  env?: NodeJS.ProcessEnv; readyMs?: number;
}): Promise<NativeViewerHostIdentity> {
  const env = options.env ?? process.env;
  sessionViewerDir(options.sessionId, env);
  return withSessionVncLock(options.sessionId, env, async () => {
    const record = await getSession(options.sessionId, env);
    if (record?.status !== "running" || record.desktop === undefined ||
        await verifyOwnedDisplayTarget(record.id, record.desktop.display, env) === undefined) {
      throw new Error("Native viewer requires a verified running desktop display");
    }
    const previous = await findNativeViewerHost(options.sessionId, env);
    if (previous?.version === options.version) return previous;
    await withViewerDir(options.sessionId, env, true, async (directory) => {
      // A stale readiness file still identifies an unresponsive owned host.
      if (await readViewerPrivateFile(directory, "host.json") !== undefined) {
        await stopNativeViewerHost(options.sessionId, env);
        await directory.unlinkChild("host.json");
      }
      const socket = await directory.lstatChild("host.sock");
      if (socket !== undefined) {
        if (!socket.isSocket() || socket.uid !== process.getuid?.()) throw new Error("Unsafe stale viewer socket");
        await directory.unlinkChild("host.sock");
      }
    });
    const daemon = await startDaemon(process.execPath, [options.cliEntry, "internal", "viewer-host",
      "--session", options.sessionId, "--binary", options.binary, "--viewer-version", options.version], {
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
