import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolveDesktopCapableSession, type DesktopSessionInfo } from "@pickforge/lab-core";
import {
  endHumanTakeover,
  ensureSessionVnc,
  openVncViewer,
  renewHumanTakeover,
  startHumanTakeover,
  type HumanTakeoverHandle,
  type TakeoverEndReason,
} from "@pickforge/lab-desktop-linux";
import { ensureViewerBridge, type EnsuredViewerBridge } from "../viewer/bridge-daemon.js";
import { buildViewerUrl } from "../viewer/contract.js";
import {
  detectViewerBrowser,
  hasGraphicalSession,
  launchViewerWindow,
  type LaunchedViewerWindow,
} from "../viewer/launch.js";
import {
  resolveProjectDir,
  runReported,
  type BaseCliOptions,
  type CommandResult,
} from "./shared.js";

export interface WatchOptions extends BaseCliOptions {
  session?: string;
  waitForViewerExit?: boolean;
  control?: boolean;
  /** @internal test hook: override how the crash-recovery watchdog is spawned. */
  _spawnWatchdog?: SpawnWatchdogFn;
}

const TAKEOVER_SIGNALS = ["SIGINT", "SIGTERM"] as const;

export interface TakeoverWatchdogHandle {
  /** Best-effort, idempotent: stop the watchdog now (clean end). */
  kill(): void;
}

export type SpawnWatchdogFn = (handle: HumanTakeoverHandle) => TakeoverWatchdogHandle;

/**
 * Spawn the crash-recovery watchdog (pickforge/pickforge#21 P0-A) as a
 * **detached** sibling process — its own process group, `stdio: "ignore"`,
 * `unref()`'d — so a `SIGKILL` of *this* process (a crash of
 * `watch --control` itself) does not kill it too. It re-invokes the same
 * entry point currently running (`process.argv[1]`) with the hidden
 * `internal takeover-watchdog` command, which polls the lease independently
 * and actively reclaims a stale writable VNC on its own; see
 * `runTakeoverWatchdogLoop` for why a detached process was chosen over
 * OS-level parent-death coupling. If there is no known entry point to
 * re-invoke (unexpected outside a real CLI process), spawning is skipped —
 * the immediate-end-on-renew-failure and hard-deadline-timer mechanisms in
 * *this* process still hold the invariant; only the crash-of-this-process
 * backstop is unavailable in that case.
 */
function defaultSpawnWatchdog(handle: HumanTakeoverHandle): TakeoverWatchdogHandle {
  const cliEntry = process.argv[1];
  if (cliEntry === undefined) {
    return { kill(): void {} };
  }
  const child = spawn(
    process.execPath,
    [
      cliEntry,
      "internal",
      "takeover-watchdog",
      "--session",
      handle.sessionId,
      "--lease",
      handle.leaseId,
      "--interval",
      String(handle.heartbeatMs),
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  let killed = false;
  return {
    kill(): void {
      if (killed) return;
      killed = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
    },
  };
}

/**
 * Hold a human lease for the duration of the viewer wait, heartbeating it
 * every `heartbeatMs`. Three mechanisms together keep writable VNC from
 * outliving the lease in wall-clock terms (pickforge/pickforge#21 P0-A),
 * never only "the next time something happens to touch the session":
 *
 * 1. The first failed renewal ends the takeover *immediately* — it does not
 *    wait for the viewer to close, since a renewal failure means the lease
 *    is already gone (see `renewHumanTakeover`/#21 P0-B).
 * 2. A hard deadline timer, rescheduled to the fresh `expiresAt` on every
 *    successful renewal, force-ends the takeover if wall-clock time ever
 *    passes the lease's expiry regardless of what the heartbeat interval
 *    itself observed — belt-and-suspenders against e.g. a stalled interval
 *    callback.
 * 3. A detached watchdog process (`defaultSpawnWatchdog`) covers the case
 *    where *this* process itself crashes and neither of the above can run
 *    at all.
 *
 * A terminal-wide SIGINT (the common interactive-cancel path) reaches the
 * viewer child too, since `openVncViewer` spawns it in our process group —
 * the signal handler here exists so *our* process does not exit before
 * running cleanup, not to itself interrupt the viewer.
 * `runControlledViewer` always ends the takeover (VNC reverted, lease
 * released, watchdog stopped) before returning or throwing.
 */
async function runControlledViewer(
  handle: HumanTakeoverHandle,
  port: number,
  registryEnv: NodeJS.ProcessEnv,
  spawnWatchdog: SpawnWatchdogFn,
): Promise<{
  viewer: Awaited<ReturnType<typeof openVncViewer>>;
  reason: TakeoverEndReason;
  screenshotPath?: string;
}> {
  let cancelled = false;
  let leaseLost = false;
  const onSignal = (): void => {
    cancelled = true;
  };
  for (const signal of TAKEOVER_SIGNALS) {
    process.on(signal, onSignal);
  }

  let ending: Promise<{ screenshotPath?: string }> | undefined;
  const endOnce = (reason: TakeoverEndReason): Promise<{ screenshotPath?: string }> => {
    if (ending === undefined) {
      ending = endHumanTakeover(handle, { registryEnv, reason });
    }
    return ending;
  };

  let deadlineTimer: NodeJS.Timeout | undefined;
  const scheduleDeadline = (expiresAt: string): void => {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    const delayMs = Math.max(0, Date.parse(expiresAt) - Date.now());
    deadlineTimer = setTimeout(() => {
      leaseLost = true;
      void endOnce("timeout");
    }, delayMs);
    deadlineTimer.unref();
  };
  scheduleDeadline(handle.expiresAt);

  const heartbeat = setInterval(() => {
    void renewHumanTakeover(handle, registryEnv).then((renewed) => {
      if (renewed === undefined) {
        leaseLost = true;
        clearInterval(heartbeat);
        // P0-A item 1: end immediately on the first failed renewal — never
        // wait for the viewer to close.
        void endOnce("timeout");
      } else {
        scheduleDeadline(renewed.expiresAt);
      }
    });
  }, handle.heartbeatMs);
  heartbeat.unref();

  const watchdog = spawnWatchdog(handle);

  try {
    const viewer = await openVncViewer({ port, waitForExit: true });
    const reason: TakeoverEndReason = leaseLost
      ? "timeout"
      : cancelled
        ? "cancelled"
        : "return";
    const result = await endOnce(reason);
    return { viewer, reason, screenshotPath: result.screenshotPath };
  } catch (error) {
    await endOnce(leaseLost ? "timeout" : "cancelled").catch(() => {});
    throw error;
  } finally {
    clearInterval(heartbeat);
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    watchdog.kill();
    for (const signal of TAKEOVER_SIGNALS) {
      process.off(signal, onSignal);
    }
  }
}

async function watchWithControl(
  sessionId: string,
  registryEnv: NodeJS.ProcessEnv,
  spawnWatchdog: SpawnWatchdogFn,
): Promise<CommandResult> {
  const handle = await startHumanTakeover(sessionId, { registryEnv });
  const data: Record<string, unknown> = {
    sessionId,
    leaseId: handle.leaseId,
    vncPid: handle.vncPid,
    vncPort: handle.vncPort,
  };

  let controlled: Awaited<ReturnType<typeof runControlledViewer>>;
  try {
    controlled = await runControlledViewer(handle, handle.vncPort, registryEnv, spawnWatchdog);
  } catch (error) {
    throw error instanceof Error
      ? new Error(`Human takeover for session ${sessionId} ended abnormally: ${error.message}`)
      : error;
  }
  const { viewer, reason, screenshotPath } = controlled;
  data.opened = viewer.opened;
  data.endpoint = viewer.endpoint;
  data.controlReason = reason;
  if (viewer.viewer !== undefined) data.viewer = viewer.viewer;
  if (viewer.exitCode !== undefined) data.viewerExitCode = viewer.exitCode;
  if (viewer.signal !== undefined) data.viewerSignal = viewer.signal;
  if (viewer.guidance !== undefined) data.guidance = viewer.guidance;
  if (screenshotPath !== undefined) data.resumeScreenshot = screenshotPath;

  if (!viewer.opened) {
    return {
      data,
      errors: [
        `No writable VNC viewer could be opened for session ${sessionId}; ` +
          "control was granted and immediately returned. " +
          String(viewer.guidance ?? ""),
      ],
    };
  }
  const lines = [
    reason === "timeout"
      ? `human control lease for session ${sessionId} could not be renewed and was ended`
      : `human control for session ${sessionId} returned (${reason}); VNC is read-only again`,
  ];
  if (screenshotPath !== undefined) {
    lines.push(`resume screenshot recorded: ${screenshotPath}`);
  }
  return { data, lines };
}

function remoteViewerResult(
  sessionId: string,
  bridge: EnsuredViewerBridge,
  data: Record<string, unknown>,
  reason: string,
): CommandResult {
  // Not a launch: no profile and no record. The page still loads and shows
  // the live view; it simply has no window to resize.
  const url = buildViewerUrl(bridge.port, randomBytes(16).toString("hex"), bridge.token);
  const guidance =
    `${reason} Install Chromium or Google Chrome, or connect remotely with ` +
    `ssh -N -L ${bridge.port}:127.0.0.1:${bridge.port} <host> and open the URL ` +
    "in a browser on that machine. The URL holds a capability token; keep it private.";
  return {
    data: { sessionId, opened: false, ...data, url, guidance },
    lines: [`viewer not opened for session ${sessionId}`, `viewer URL: ${url}`, guidance],
  };
}

function assertCleanExit(sessionId: string, launched: LaunchedViewerWindow): void {
  const remain = "the session, VNC server and viewer bridge remain running";
  if (launched.signal !== undefined && launched.signal !== null) {
    throw new Error(
      `Viewer browser for session ${sessionId} exited on signal ${launched.signal}; ${remain}`,
    );
  }
  if (launched.exitCode !== undefined && launched.exitCode !== 0) {
    throw new Error(
      `Viewer browser for session ${sessionId} exited with code ${String(launched.exitCode)}; ${remain}`,
    );
  }
}

/**
 * Passive watch (pickforge/pickforge#207): the read-only VNC server, the
 * loopback viewer bridge, and a browser window on the bundled noVNC page.
 * The token never appears in the result once a window opened.
 */
async function watchWithBrowser(
  record: { id: string; desktop?: DesktopSessionInfo },
  waitForExit: boolean,
): Promise<CommandResult> {
  const vnc = await ensureSessionVnc(record.id);
  const bridge = await ensureViewerBridge(record.id);
  const endpoints = {
    bridgePort: bridge.port,
    bridgeReused: bridge.reused,
    vncPid: vnc.pid,
    vncPort: vnc.port,
    vncReused: vnc.reused,
  };
  if (!hasGraphicalSession()) {
    return remoteViewerResult(record.id, bridge, endpoints, "No graphical host session is available.");
  }
  const browser = detectViewerBrowser();
  if (browser === null) {
    return remoteViewerResult(record.id, bridge, endpoints, "No supported browser was found on PATH.");
  }
  const launched = await launchViewerWindow({
    sessionId: record.id,
    desktop: record.desktop,
    bridgePort: bridge.port,
    token: bridge.token,
    browser,
    waitForExit,
  });
  const data: Record<string, unknown> = {
    sessionId: record.id,
    opened: true,
    browser: launched.browser,
    launchId: launched.launchId,
    adapter: launched.adapter,
    ...endpoints,
  };
  if (launched.exitCode !== undefined) data.exitCode = launched.exitCode;
  if (launched.signal !== undefined && launched.signal !== null) data.signal = launched.signal;
  if (!waitForExit) {
    return {
      data,
      lines: [
        `viewer opened for session ${record.id} (${launched.browser}, adapter ${launched.adapter}); ` +
          "the session and VNC server remain independent",
      ],
    };
  }
  assertCleanExit(record.id, launched);
  return {
    data,
    lines: [`viewer closed for session ${record.id}; the session and VNC server remain running`],
  };
}

export async function watchDesktopSession(
  opts: WatchOptions,
): Promise<CommandResult> {
  const record = await resolveDesktopCapableSession(opts.session, {
    projectDir: resolveProjectDir(opts),
  });
  if (opts.control === true) {
    if (opts.waitForViewerExit === false) {
      throw new Error(
        "--control requires waiting for the viewer to exit, to know when to end human control",
      );
    }
    return watchWithControl(record.id, process.env, opts._spawnWatchdog ?? defaultSpawnWatchdog);
  }
  return watchWithBrowser(record, opts.waitForViewerExit !== false);
}

export async function runWatch(opts: WatchOptions): Promise<number> {
  return runReported(opts, () => watchDesktopSession(opts));
}
