import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  getSession, updateSession, sessionDataDir, startDaemon, stopOwnedDaemonGroup,
  processIdentityMatches, readProcessIdentity, stopProcessGroupVerified,
  type DesktopSessionInfo, type DirHandle,
} from "@pickforge/lab-core";
import {
  withSessionVncLock, withViewerDir, readViewerPrivateFile, writeViewerPrivateFile, sessionViewerDir,
} from "@pickforge/lab-desktop-linux";

export interface EnsuredViewerBridge {
  pid: number;
  port: number;
  /** Never include this capability in logs or process arguments. */
  token: string;
  reused: boolean;
}

export interface EnsureViewerBridgeOptions {
  registryEnv?: NodeJS.ProcessEnv;
  /** @internal Override the CLI entry point for detached daemon tests. */
  _cliEntry?: string;
  /** @internal Bound readiness waits in failure tests. */
  _readyMs?: number;
}

function validPort(port: number | undefined): port is number {
  return port !== undefined && Number.isInteger(port) && port > 0 && port <= 65535;
}

export async function ensureViewerBridge(sessionId: string, opts: EnsureViewerBridgeOptions = {}): Promise<EnsuredViewerBridge> {
  const env = opts.registryEnv ?? process.env;
  // Validate before the VNC lock creates its sentinel file.
  sessionViewerDir(sessionId, env);
  return withSessionVncLock(sessionId, env, async () => {
    const record = await getSession(sessionId, env);
    if (record?.status !== "running" || record.desktop === undefined) throw new Error("Running desktop session required");
    return withViewerDir(sessionId, env, true, async dir => {
      const d = record.desktop!;
      const pid = d.viewerBridgePid;
      const startTicks = d.viewerBridgeStartTimeTicks;
      const alive = pid !== undefined && startTicks !== undefined && processIdentityMatches({ pid, startTicks });
      const previous = await readViewerPrivateFile(dir, "token");
      if (alive && validPort(d.viewerBridgePort) && previous !== undefined && /^[A-Za-z0-9_-]{43}$/.test(previous)) {
        return { pid: pid!, port: d.viewerBridgePort, token: previous, reused: true };
      }
      if (alive) {
        const stopped = await stopProcessGroupVerified({ pid: pid!, startTicks: startTicks! });
        if (stopped.outcome !== "terminated" && stopped.outcome !== "already-dead") throw new Error("Old viewer bridge could not be stopped");
      }
      const cliEntry = opts._cliEntry ?? process.argv[1];
      if (cliEntry === undefined) throw new Error("CLI entry point unavailable");
      const desktop = { ...d, viewerBridgePid: undefined, viewerBridgeStartTimeTicks: undefined, viewerBridgePort: undefined };
      await updateSession(sessionId, { desktop }, env);
      const token = randomBytes(32).toString("base64url");
      await writeViewerPrivateFile(dir, "token", token);
      return startBridge(sessionId, opts, env, dir, desktop, cliEntry, token);
    });
  });
}

async function startBridge(
  sessionId: string, opts: EnsureViewerBridgeOptions, env: NodeJS.ProcessEnv,
  dir: DirHandle, desktop: DesktopSessionInfo, cliEntry: string, token: string,
): Promise<EnsuredViewerBridge> {
  const daemon = await startDaemon(process.execPath, [cliEntry, "internal", "viewer-bridge", "--session", sessionId], {
    logDir: sessionDataDir(sessionId, env), name: "viewer-bridge", env, owned: true,
  });
  try {
    const deadline = Date.now() + (opts._readyMs ?? 8_000);
    while (Date.now() < deadline) {
      const identity = readProcessIdentity(daemon.pid);
      if (identity === undefined) throw new Error("Viewer bridge exited during startup");
      const raw = await readViewerPrivateFile(dir, "bridge.json");
      let ready: { pid?: number; startTicks?: number; port?: number } = {};
      try { ready = raw === undefined ? {} : JSON.parse(raw); } catch { /* Not ready. */ }
      if (ready !== null && ready.pid === daemon.pid && ready.startTicks === identity.startTicks && validPort(ready.port)) {
        if (!processIdentityMatches(identity)) throw new Error("Viewer bridge identity changed");
        await updateSession(sessionId, { desktop: { ...desktop, viewerBridgePid: identity.pid,
          viewerBridgeStartTimeTicks: identity.startTicks, viewerBridgePort: ready.port } }, env);
        daemon.release();
        return { pid: identity.pid, port: ready.port, token, reused: false };
      }
      await sleep(25);
    }
    throw new Error("Viewer bridge readiness timed out");
  } catch (error) {
    if (!await stopOwnedDaemonGroup(daemon)) throw new Error("Viewer bridge startup cleanup failed");
    throw error;
  }
}
