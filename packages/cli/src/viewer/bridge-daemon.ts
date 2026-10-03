import { randomBytes } from "node:crypto";
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
  withSessionVncLock,
  withViewerDir,
  readViewerPrivateFile,
  writeViewerPrivateFile,
  sessionViewerDir,
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
  return (
    port !== undefined && Number.isInteger(port) && port > 0 && port <= 65_535
  );
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
          return {
            pid: pid!,
            port: recordedDesktop.viewerBridgePort,
            token: previousToken,
            reused: true,
          };
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
  try {
    const deadline = Date.now() + (options._readyMs ?? 8_000);
    while (Date.now() < deadline) {
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
    }
    throw new Error("Viewer bridge readiness timed out");
  } catch (error) {
    if (!(await stopOwnedDaemonGroup(daemon))) {
      throw new Error("Viewer bridge startup cleanup failed");
    }
    throw error;
  }
}
