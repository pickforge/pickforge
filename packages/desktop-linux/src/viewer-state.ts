import type net from "node:net";
import type { DesktopSessionInfo, EnvLike } from "@pickforge/lab-core";

/**
 * Private per-session state of the passive browser viewer
 * (pickforge/pickforge#207): the viewer directory, the bridge capability
 * token, one record per viewer launch, the only way the bridge reaches the
 * session's VNC server, and teardown. The directory is
 * `<session data dir>/viewer/` (0700); files in it are 0600.
 *
 * SKELETON: signatures are the contract between workers. Bodies are owned by
 * the security-core worker.
 */

/** 32 lowercase hex characters (16 random bytes). */
export const VIEWER_LAUNCH_ID_PATTERN = /^[0-9a-f]{32}$/;

export type ViewerBrowserKind = "chromium" | "firefox";

export interface ViewerWindowSize {
  width: number;
  height: number;
}

export interface ViewerHyprlandLaunch {
  /** Absolute path of the hyprctl binary the launcher used. */
  hyprctl: string;
  /** `HYPRLAND_INSTANCE_SIGNATURE` of the compositor that owns the window. */
  instance: string;
  /** `XDG_RUNTIME_DIR` that holds that instance's socket. */
  xdgRuntimeDir: string;
  /** Name of the runtime window rule, disabled once the window has mapped. */
  ruleName: string;
  /** Anchored regex that matches only this launch's window class. */
  classPattern: string;
}

export interface ViewerLaunchRecord {
  launchId: string;
  sessionId: string;
  createdAt: string;
  browser: { kind: ViewerBrowserKind; binary: string };
  /** `<viewer dir>/launches/<launchId>/profile`, a fresh private browser profile. */
  profileDir: string;
  /** Browser main process, recorded right after spawn. */
  pid?: number;
  startTicks?: number;
  thumbnail: ViewerWindowSize;
  expanded: ViewerWindowSize;
  /** Present only when the Hyprland adapter placed the window. */
  hyprland?: ViewerHyprlandLaunch;
}

export interface PreparedViewerLaunch {
  launchId: string;
  launchDir: string;
  profileDir: string;
}

export type ViewerVncUnavailableReason = "unavailable" | "writable" | "session-ended";

/** Why the bridge could not reach a read-only VNC server for the session. */
export class ViewerVncUnavailableError extends Error {
  readonly reason: ViewerVncUnavailableReason;

  constructor(reason: ViewerVncUnavailableReason, message: string) {
    super(message);
    this.name = "ViewerVncUnavailableError";
    this.reason = reason;
  }
}

function notImplemented(name: string): never {
  throw new Error(`${name} is not implemented yet`);
}

/** `<session data dir>/viewer`. */
export function sessionViewerDir(id: string, registryEnv: EnvLike = process.env): string {
  void id;
  void registryEnv;
  return notImplemented("sessionViewerDir");
}

/**
 * Create a fresh launch: a random launch id and its private profile directory
 * under `<viewer dir>/launches/<launchId>/`, every level 0700 and owned by the
 * caller. Also prunes earlier launches whose browser is confirmed gone.
 */
export async function prepareViewerLaunch(
  id: string,
  registryEnv: EnvLike = process.env,
): Promise<PreparedViewerLaunch> {
  void id;
  void registryEnv;
  return notImplemented("prepareViewerLaunch");
}

/** Atomically write `launch.json` (0600) for a prepared launch. */
export async function writeViewerLaunchRecord(
  record: ViewerLaunchRecord,
  registryEnv: EnvLike = process.env,
): Promise<void> {
  void record;
  void registryEnv;
  return notImplemented("writeViewerLaunchRecord");
}

/** Read and validate one launch record; undefined when absent or invalid. */
export async function readViewerLaunchRecord(
  id: string,
  launchId: string,
  registryEnv: EnvLike = process.env,
): Promise<ViewerLaunchRecord | undefined> {
  void id;
  void launchId;
  void registryEnv;
  return notImplemented("readViewerLaunchRecord");
}

/**
 * Remove one launch directory (its profile included). Refuses while the
 * recorded browser process is still alive.
 */
export async function removeViewerLaunch(
  id: string,
  launchId: string,
  registryEnv: EnvLike = process.env,
): Promise<void> {
  void id;
  void launchId;
  void registryEnv;
  return notImplemented("removeViewerLaunch");
}

/**
 * Connect to the session's recorded VNC endpoint on 127.0.0.1, only when the
 * session is running and its x11vnc is the recorded, identity-verified,
 * server-enforced read-only process. Resolves with a connected socket.
 * Throws `ViewerVncUnavailableError` otherwise.
 */
export async function connectSessionVncReadOnly(
  id: string,
  registryEnv: EnvLike = process.env,
): Promise<net.Socket> {
  void id;
  void registryEnv;
  return notImplemented("connectSessionVncReadOnly");
}

/**
 * Session teardown: stop owned viewer browsers and the viewer bridge (both by
 * verified process identity), then remove the viewer directory. Returns the
 * failures; an empty array means everything is confirmed gone.
 */
export async function stopSessionViewer(
  id: string,
  desktop: DesktopSessionInfo | undefined,
  registryEnv: EnvLike = process.env,
): Promise<Error[]> {
  void id;
  void desktop;
  void registryEnv;
  return notImplemented("stopSessionViewer");
}
