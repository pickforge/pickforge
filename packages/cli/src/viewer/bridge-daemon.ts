import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import {
  getSession,
  updateSession,
  sessionDataDir,
  startDaemon,
  stopOwnedDaemonGroup,
  processIdentityMatches,
  readProcessIdentity,
  stopProcessGroupVerified,
  type DesktopSessionInfo,
  type DirHandle,
  type ProcessIdentity,
} from "@pickforge/lab-core";
import {
  SESSION_VNC_LOCK_TIMEOUT_MS,
  withSessionVncLock,
  withViewerDir,
  readViewerPrivateFile,
  writeViewerPrivateFile,
  sessionViewerDir,
} from "@pickforge/lab-desktop-linux";
import { VIEWER_HOST, VIEWER_STATUS_API_PATH } from "./contract.js";

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

// The bridge spends most of its startup loading the CLI: about 0.4 s of CPU
// on an idle host. With 16 busy loops on 2 CPUs it reported ready after up to
// 8 s, but under 1 s of that was its own time; the rest was spent waiting for
// a CPU (#301). The budget counts only the bridge's own time, so a hung bridge
// still fails within 8 s on an idle host. The wall cap ends a bridge that never
// gets a CPU. A bridge that exits fails at once.
const READY_BUDGET_MS = 8_000;
const READY_WALL_CAP_FACTOR = 8;
// Startup holds the session VNC lock. The wall cap leaves room for the
// probe, the old bridge stop and the cleanup, so other callers of the lock
// do not time out while a startup is still allowed to run.
const READY_LOCK_MARGIN_MS = 20_000;
const READY_WALL_CAP_MAX_MS = SESSION_VNC_LOCK_TIMEOUT_MS - READY_LOCK_MARGIN_MS;

/** Time the process's main thread spent runnable but waiting for a CPU. */
function cpuWaitMs(pid: number): number {
  try {
    const fields = fs
      .readFileSync(`/proc/${pid}/schedstat`, "utf8")
      .trim()
      .split(/\s+/);
    const waitNs = Number(fields[1]);
    return Number.isFinite(waitNs) && waitNs > 0 ? waitNs / 1e6 : 0;
  } catch {
    return 0;
  }
}

function seconds(ms: number): string {
  return (ms / 1_000).toFixed(1);
}

function validPort(port: number | undefined): port is number {
  return (
    port !== undefined && Number.isInteger(port) && port > 0 && port <= 65_535
  );
}

function probeViewerBridge(port: number, token: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const request = http.get(
      {
        hostname: VIEWER_HOST,
        port,
        path: VIEWER_STATUS_API_PATH,
        headers: { Authorization: `Bearer ${token}` },
        agent: false,
      },
      (response) => {
        response.resume();
        resolve(response.statusCode === 204);
      },
    );
    const deadline = setTimeout(
      () => request.destroy(new Error("Viewer status deadline")),
      750,
    );
    request.once("error", () => resolve(false));
    request.once("close", () => clearTimeout(deadline));
  });
}

/** Reuse a verified bridge or start and record a detached daemon under the VNC lock. */
export async function ensureViewerBridge(
  sessionId: string,
  options: EnsureViewerBridgeOptions = {},
): Promise<EnsuredViewerBridge> {
  const registryEnv = options.registryEnv ?? process.env;
  // Validate before the VNC lock creates its sentinel file.
  sessionViewerDir(sessionId, registryEnv);
  return withSessionVncLock(sessionId, registryEnv, async () => {
    const record = await getSession(sessionId, registryEnv);
    if (record?.status !== "running" || record.desktop === undefined) {
      throw new Error("Running desktop session required");
    }
    return withViewerDir(
      sessionId,
      registryEnv,
      true,
      async (viewerDirectory) => {
        const recordedDesktop = record.desktop!;
        const pid = recordedDesktop.viewerBridgePid;
        const startTicks = recordedDesktop.viewerBridgeStartTimeTicks;
        const alive =
          pid !== undefined &&
          startTicks !== undefined &&
          processIdentityMatches({ pid, startTicks });
        const previousToken = await readViewerPrivateFile(
          viewerDirectory,
          "token",
        );
        if (
          alive &&
          validPort(recordedDesktop.viewerBridgePort) &&
          previousToken !== undefined &&
          /^[A-Za-z0-9_-]{43}$/.test(previousToken)
        ) {
          if (
            await probeViewerBridge(
              recordedDesktop.viewerBridgePort,
              previousToken,
            )
          ) {
            return {
              pid: pid!,
              port: recordedDesktop.viewerBridgePort,
              token: previousToken,
              reused: true,
            };
          }
        }
        if (alive) {
          const stopResult = await stopProcessGroupVerified({
            pid: pid!,
            startTicks: startTicks!,
          });
          if (
            stopResult.outcome !== "terminated" &&
            stopResult.outcome !== "already-dead"
          ) {
            throw new Error("Old viewer bridge could not be stopped");
          }
        }
        const cliEntry = options._cliEntry ?? process.argv[1];
        if (cliEntry === undefined) {
          throw new Error("CLI entry point unavailable");
        }
        const desktop = {
          ...recordedDesktop,
          viewerBridgePid: undefined,
          viewerBridgeStartTimeTicks: undefined,
          viewerBridgePort: undefined,
        };
        await updateSession(sessionId, { desktop }, registryEnv);
        const token = randomBytes(32).toString("base64url");
        await writeViewerPrivateFile(viewerDirectory, "token", token);
        return startBridge(sessionId, {
          options,
          registryEnv,
          viewerDirectory,
          desktop,
          cliEntry,
          token,
        });
      },
    );
  });
}

interface BridgeStartup {
  options: EnsureViewerBridgeOptions;
  registryEnv: NodeJS.ProcessEnv;
  viewerDirectory: DirHandle;
  desktop: DesktopSessionInfo;
  cliEntry: string;
  token: string;
}

interface BridgeReadiness {
  pid?: number;
  startTicks?: number;
  port?: number;
}

async function readBridgeReadiness(
  viewerDirectory: DirHandle,
): Promise<BridgeReadiness | null> {
  const readinessJson = await readViewerPrivateFile(
    viewerDirectory,
    "bridge.json",
  );
  try {
    return readinessJson === undefined ? {} : JSON.parse(readinessJson);
  } catch {
    return {};
  }
}

function bridgeIsReady(
  readiness: BridgeReadiness | null,
  identity: ProcessIdentity,
): readiness is BridgeReadiness & { port: number } {
  return (
    readiness !== null &&
    readiness.pid === identity.pid &&
    readiness.startTicks === identity.startTicks &&
    validPort(readiness.port)
  );
}

async function startBridge(
  sessionId: string,
  startup: BridgeStartup,
): Promise<EnsuredViewerBridge> {
  const { options, registryEnv, viewerDirectory, desktop, cliEntry, token } =
    startup;
  const daemon = await startDaemon(
    process.execPath,
    [cliEntry, "internal", "viewer-bridge", "--session", sessionId],
    {
      logDir: sessionDataDir(sessionId, registryEnv),
      name: "viewer-bridge",
      env: registryEnv,
      owned: true,
    },
  );
  const startedAt = Date.now();
  const budgetMs = options._readyMs ?? READY_BUDGET_MS;
  const wallCapMs = Math.min(
    budgetMs * READY_WALL_CAP_FACTOR,
    READY_WALL_CAP_MAX_MS,
  );
  let elapsedMs = 0;
  let waitMs = 0;
  try {
    while (elapsedMs - waitMs < budgetMs && elapsedMs < wallCapMs) {
      const identity = readProcessIdentity(daemon.pid);
      if (identity === undefined) {
        throw new Error("Viewer bridge exited during startup");
      }
      const readiness = await readBridgeReadiness(viewerDirectory);
      if (bridgeIsReady(readiness, identity)) {
        if (!processIdentityMatches(identity)) {
          throw new Error("Viewer bridge identity changed");
        }
        await updateSession(
          sessionId,
          {
            desktop: {
              ...desktop,
              viewerBridgePid: identity.pid,
              viewerBridgeStartTimeTicks: identity.startTicks,
              viewerBridgePort: readiness.port,
            },
          },
          registryEnv,
        );
        daemon.release();
        return {
          pid: identity.pid,
          port: readiness.port,
          token,
          reused: false,
        };
      }
      await sleep(25);
      elapsedMs = Date.now() - startedAt;
      waitMs = cpuWaitMs(daemon.pid);
    }
    throw new Error(
      `Viewer bridge did not report readiness after ${seconds(elapsedMs)} s, ` +
        `${seconds(waitMs)} s of it waiting for a CPU. ` +
        `If the host is busy, retry when the load drops. ` +
        `Otherwise see ${daemon.logPath}.`,
    );
  } catch (error) {
    if (!(await stopOwnedDaemonGroup(daemon))) {
      throw new Error("Viewer bridge startup cleanup failed");
    }
    throw error;
  }
}
