import { holdHumanLease, defaultSpawnWatchdog, type SpawnWatchdogFn } from "./takeover-hold.js";
export type { SpawnWatchdogFn, TakeoverWatchdogHandle } from "./takeover-hold.js";
import { randomBytes } from "node:crypto";
import { getSession, resolveDesktopCapableSession, type DesktopSessionInfo } from "@pickforge/lab-core";
import {
  startNativeViewerHost,
  findNativeViewerHost,
  stopNativeViewerHost,
  endHumanTakeover,
  ensureSessionVnc,
  openVncViewer,
  startHumanTakeover,
  type HumanTakeoverHandle,
  type NativeViewerHostIdentity,
  type TakeoverEndReason,
  withSessionVncLock,
} from "@pickforge/lab-desktop-linux";
import { ensureViewerBridge, type EnsuredViewerBridge } from "../viewer/bridge-daemon.js";
import { detectNativeViewer, nativeViewerVersion } from "../viewer/native.js";
import { setTimeout as sleep } from "node:timers/promises";
import { processIdentityMatches } from "@pickforge/lab-core";
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

  const held = holdHumanLease(handle, {
    registryEnv, spawnWatchdog,
    onLost: () => { leaseLost = true; void endOnce("timeout"); },
  });

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
    held.stop();
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
  reason: "no-graphical-session" | "no-browser",
): CommandResult {
  // Not a launch: no profile and no record. The page still loads and shows
  // the live view; it simply has no window to resize.
  const url = buildViewerUrl(bridge.port, randomBytes(16).toString("hex"), bridge.token);
  const tunnel =
    `ssh -N -L ${bridge.port}:127.0.0.1:${bridge.port} <host> and open the URL ` +
    "in a browser on that machine. The URL holds a capability token; keep it private.";
  const guidance =
    reason === "no-graphical-session"
      ? `No graphical host session is available. Connect remotely with ${tunnel}`
      : "No supported browser was found on PATH. Install Chromium or Google Chrome, " +
        `or connect remotely with ${tunnel}`;
  return {
    data: { sessionId, opened: false, ...data, url, guidance },
    lines: [`viewer not opened for session ${sessionId}`, `viewer URL: ${url}`, guidance],
  };
}

/**
 * Whether the session ended. Teardown holds the VNC lock until the record
 * is final, so wait for that lock before reading it.
 */
async function sessionEnded(sessionId: string): Promise<boolean> {
  const read = (): ReturnType<typeof getSession> => getSession(sessionId);
  const record = await withSessionVncLock(sessionId, process.env, read).catch(read);
  return record?.status !== "running";
}

async function assertCleanExit(sessionId: string, launched: LaunchedViewerWindow): Promise<void> {
  let failure: string | undefined;
  if (launched.signal !== undefined && launched.signal !== null) {
    failure = `exited on signal ${launched.signal}`;
  } else if (launched.exitCode !== undefined && launched.exitCode !== 0) {
    failure = `exited with code ${String(launched.exitCode)}`;
  }
  if (failure === undefined) return;
  const outcome = (await sessionEnded(sessionId))
    ? "the session ended"
    : "the session, VNC server and viewer bridge remain running";
  throw new Error(`Viewer browser for session ${sessionId} ${failure}; ${outcome}`);
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
    return remoteViewerResult(record.id, bridge, endpoints, "no-graphical-session");
  }
  const browser = detectViewerBrowser();
  if (browser === null) {
    return remoteViewerResult(record.id, bridge, endpoints, "no-browser");
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
  // An automatic launch reports an exit only when it saw one during placement.
  await assertCleanExit(record.id, launched);
  if (!waitForExit) {
    return {
      data,
      lines: [
        `viewer opened for session ${record.id} (${launched.browser}, adapter ${launched.adapter}); ` +
          "the session and VNC server remain independent",
      ],
    };
  }
  return {
    data,
    lines: [`viewer closed for session ${record.id}; the session and VNC server remain running`],
  };
}

async function waitForNativeViewer(sessionId: string, host: NativeViewerHostIdentity): Promise<void> {
  let interrupted = false;
  let stopping: Promise<void> | undefined;
  let stopFailure: unknown;
  const stop = (): void => { interrupted = true; stopping ??= stopNativeViewerHost(sessionId).catch((error: unknown) => { stopFailure = error; }); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    while (!interrupted && processIdentityMatches({ pid: host.pid, startTicks: host.startTicks })) await sleep(100);
    await stopping;
    if (stopFailure !== undefined) throw stopFailure;
  } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}

async function tryNativeViewer(sessionId: string, binary: string, control = false): Promise<NativeViewerHostIdentity | undefined> {
  try {
    const cliEntry = process.argv[1];
    if (cliEntry === undefined) throw new Error("CLI entry point unavailable");
    return await startNativeViewerHost({ sessionId, cliEntry, binary, version: nativeViewerVersion, control });
  } catch (error) {
    console.error(`Native viewer unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return findNativeViewerHost(sessionId);
  }
}

export async function watchDesktopSession(
  opts: WatchOptions,
): Promise<CommandResult> {
  const record = await resolveDesktopCapableSession(opts.session, {
    projectDir: resolveProjectDir(opts),
  });
  if (opts.control === true && opts.waitForViewerExit === false) {
    throw new Error("--control requires waiting for the viewer to exit, to know when to end human control");
  }
  const binary = await detectNativeViewer();
  const host = binary === null ? undefined : await tryNativeViewer(record.id, binary, opts.control === true);
  if (host !== undefined) {
    const data = { sessionId: record.id, opened: true, viewer: "native", launchId: host.launchId,
      hostPid: host.pid, viewerPid: host.viewerPid };
    if (opts.waitForViewerExit !== false) {
      await waitForNativeViewer(record.id, host);
    }
    return { data, lines: [`native viewer ${opts.waitForViewerExit === false ? "opened" : "closed"} for session ${record.id}`] };
  }
  if (opts.control === true) {
    return watchWithControl(record.id, process.env, opts._spawnWatchdog ?? defaultSpawnWatchdog);
  }
  return watchWithBrowser(record, opts.waitForViewerExit !== false);
}

export async function runWatch(opts: WatchOptions): Promise<number> {
  return runReported(opts, () => watchDesktopSession(opts));
}
