import { spawn } from "node:child_process";
import { resolveDesktopCapableSession } from "@pickforge/lab-core";
import {
  endHumanTakeover,
  ensureSessionVnc,
  openVncViewer,
  renewHumanTakeover,
  startHumanTakeover,
  type HumanTakeoverHandle,
  type TakeoverEndReason,
} from "@pickforge/lab-desktop-linux";
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
  const vnc = await ensureSessionVnc(record.id);
  const viewer = await openVncViewer({
    port: vnc.port,
    waitForExit: opts.waitForViewerExit !== false,
  });
  const data: Record<string, unknown> = {
    sessionId: record.id,
    opened: viewer.opened,
    endpoint: viewer.endpoint,
    vncPid: vnc.pid,
    vncPort: vnc.port,
    vncReused: vnc.reused,
  };
  if (viewer.viewer !== undefined) data.viewer = viewer.viewer;
  if (viewer.exitCode !== undefined) data.viewerExitCode = viewer.exitCode;
  if (viewer.signal !== undefined) data.viewerSignal = viewer.signal;
  if (viewer.guidance !== undefined) data.guidance = viewer.guidance;

  if (!viewer.opened) {
    return {
      data,
      lines: [
        `viewer not opened for session ${record.id}`,
        `VNC endpoint: ${viewer.endpoint}`,
        viewer.guidance as string,
      ],
    };
  }
  if (opts.waitForViewerExit !== false) {
    if (viewer.signal !== undefined && viewer.signal !== null) {
      throw new Error(
        `VNC viewer for session ${record.id} exited on signal ${viewer.signal}; the session and VNC server remain running`,
      );
    }
    if (viewer.exitCode !== undefined && viewer.exitCode !== 0) {
      throw new Error(
        `VNC viewer for session ${record.id} exited with code ${String(viewer.exitCode)}; the session and VNC server remain running`,
      );
    }
  }
  return {
    data,
    lines: [
      opts.waitForViewerExit === false
        ? `viewer opened for session ${record.id}; the session and VNC server remain independent`
        : `viewer closed for session ${record.id}; the session and VNC server remain running`,
    ],
  };
}

export async function runWatch(opts: WatchOptions): Promise<number> {
  return runReported(opts, () => watchDesktopSession(opts));
}
