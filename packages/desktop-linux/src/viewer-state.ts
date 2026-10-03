import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DirHandle, getSession, sessionDataDir, identityIsAlive, processIdentityMatches, stopProcessGroupVerified } from "@pickforge/lab-core";
import { withSessionVncLock } from "./session.js";
import type { DesktopSessionInfo, EnvLike } from "@pickforge/lab-core";

/**
 * Private per-session state of the passive browser viewer
 * (pickforge/pickforge#207): the viewer directory, the bridge capability
 * token, one record per viewer launch, the only way the bridge reaches the
 * session's VNC server, and teardown. The directory is
 * `<session data dir>/viewer/` (0700); files in it are 0600.
 *
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

function assertSessionId(id: string): void {
  if (!/^(desk|andr|duo|brow)-[0-9a-f]{6,}$/.test(id)) throw new Error("Invalid session id");
}

export function sessionViewerDir(id: string, registryEnv: EnvLike = process.env): string {
  assertSessionId(id);
  return path.join(sessionDataDir(id, registryEnv), "viewer");
}

function assertPrivate(stat: fs.Stats, directory: boolean): void {
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== (directory ? 0o700 : 0o600) ||
      (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw new Error("Unsafe viewer state ownership or permissions");
  }
}

async function privateChild(parent: DirHandle, name: string, create: boolean): Promise<DirHandle> {
  const dir = await (create ? parent.ensureChildDir(name, 0o700) : parent.openChild(name));
  try { assertPrivate(dir.stat, true); return dir; }
  catch (error) { await dir.close(); throw error; }
}

/** Bind all state access to verified directory descriptors. */
export async function withViewerDir<T>(
  id: string, env: EnvLike, create: boolean, operation: (dir: DirHandle) => Promise<T>,
): Promise<T> {
  const viewer = sessionViewerDir(id, env);
  const root = await DirHandle.open(path.dirname(path.dirname(viewer)));
  let session: DirHandle | undefined;
  let dir: DirHandle | undefined;
  try {
    if (root.stat.uid !== process.getuid?.()) throw new Error("Wrong session directory owner");
    session = await (create ? root.ensureChildDir(id, 0o700) : root.openChild(id));
    if (session.stat.uid !== process.getuid?.()) throw new Error("Wrong session data owner");
    dir = await privateChild(session, "viewer", create);
    return await operation(dir);
  } finally {
    await dir?.close(); await session?.close(); await root.close();
  }
}

/** Reject special files before open; O_NOFOLLOW also closes the symlink race. */
export async function readViewerPrivateFile(dir: DirHandle, name: string): Promise<string | undefined> {
  const stat = await dir.lstatChild(name);
  if (stat === undefined) return undefined;
  assertPrivate(stat, false);
  const file = await dir.openFile(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const actual = await file.stat();
    assertPrivate(actual, false);
    if (actual.size > 64 * 1024) throw new Error("Viewer state file is too large");
    return await file.readFile("utf8");
  } finally { await file.close(); }
}

export async function writeViewerPrivateFile(dir: DirHandle, name: string, content: string): Promise<void> {
  const existing = await dir.lstatChild(name);
  if (existing !== undefined) assertPrivate(existing, false);
  const tmp = `.tmp-${randomBytes(16).toString("hex")}`;
  const file = await dir.openFile(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    await file.chmod(0o600);
    await file.writeFile(content, "utf8");
    await file.sync();
    const target = await dir.lstatChild(name);
    if (target !== undefined) assertPrivate(target, false);
    await fs.promises.rename(dir.resolve(tmp), dir.resolve(name));
  } finally { await file.close(); await dir.unlinkChild(tmp); }
}

function validSize(value: unknown): value is ViewerWindowSize {
  const v = value as ViewerWindowSize | undefined;
  return v !== null && v !== undefined && Number.isSafeInteger(v.width) && v.width > 0 &&
    Number.isSafeInteger(v.height) && v.height > 0;
}

function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function validHyprland(h: ViewerHyprlandLaunch | undefined, launchId: string): boolean {
  if (h === undefined) return true;
  return h !== null && typeof h.hyprctl === "string" && path.isAbsolute(h.hyprctl) &&
    typeof h.instance === "string" && /^[A-Za-z0-9_]+$/.test(h.instance) &&
    typeof h.xdgRuntimeDir === "string" && path.isAbsolute(h.xdgRuntimeDir) &&
    h.ruleName === `pickforge-viewer-${launchId}` && typeof h.classPattern === "string" &&
    h.classPattern.length <= 512 && !/[\x00-\x1f\x7f-\x9f]/.test(h.classPattern);
}

function validBrowser(r: ViewerLaunchRecord, id: string, launchId: string, env: EnvLike): boolean {
  return (r.browser?.kind === "chromium" || r.browser?.kind === "firefox") &&
    typeof r.browser.binary === "string" && path.isAbsolute(r.browser.binary) &&
    r.profileDir === path.join(sessionViewerDir(id, env), "launches", launchId, "profile") &&
    (r.pid === undefined || positive(r.pid)) && (r.startTicks === undefined || positive(r.startTicks)) &&
    (r.startTicks === undefined || r.pid !== undefined);
}

function validRecord(value: unknown, id: string, launchId: string, env: EnvLike): value is ViewerLaunchRecord {
  const r = value as ViewerLaunchRecord | undefined;
  if (r === null || r === undefined || typeof r !== "object") return false;
  return VIEWER_LAUNCH_ID_PATTERN.test(launchId) && r.launchId === launchId && r.sessionId === id &&
    typeof r.createdAt === "string" && Number.isFinite(Date.parse(r.createdAt)) &&
    validBrowser(r, id, launchId, env) && validSize(r.thumbnail) && validSize(r.expanded) &&
    validHyprland(r.hyprland, launchId);
}

async function withLaunch<T>(dir: DirHandle, launchId: string, operation: (launch: DirHandle) => Promise<T>): Promise<T> {
  if (!VIEWER_LAUNCH_ID_PATTERN.test(launchId)) throw new Error("Invalid viewer launch id");
  const launches = await privateChild(dir, "launches", false);
  let launch: DirHandle | undefined;
  try { launch = await privateChild(launches, launchId, false); return await operation(launch); }
  finally { await launch?.close(); await launches.close(); }
}

async function readRecord(dir: DirHandle, id: string, launchId: string, env: EnvLike): Promise<ViewerLaunchRecord | undefined> {
  return withLaunch(dir, launchId, async launch => {
    const profile = await privateChild(launch, "profile", false);
    await profile.close();
    const raw = await readViewerPrivateFile(launch, "launch.json");
    if (raw === undefined) return undefined;
    const record: unknown = JSON.parse(raw);
    return validRecord(record, id, launchId, env) ? record : undefined;
  });
}

export async function readViewerLaunchRecord(id: string, launchId: string, registryEnv: EnvLike = process.env): Promise<ViewerLaunchRecord | undefined> {
  try { return await withViewerDir(id, registryEnv, false, dir => readRecord(dir, id, launchId, registryEnv)); }
  catch { return undefined; }
}

export async function writeViewerLaunchRecord(record: ViewerLaunchRecord, registryEnv: EnvLike = process.env): Promise<void> {
  if (!validRecord(record, record.sessionId, record.launchId, registryEnv)) throw new Error("Invalid viewer launch record");
  await withViewerDir(record.sessionId, registryEnv, false, dir => withLaunch(dir, record.launchId,
    async launch => {
      const profile = await privateChild(launch, "profile", false); await profile.close();
      await writeViewerPrivateFile(launch, "launch.json", `${JSON.stringify(record)}\n`);
    }));
}

async function removeLaunchIn(dir: DirHandle, id: string, launchId: string, env: EnvLike): Promise<void> {
  await withLaunch(dir, launchId, async launch => {
    const raw = await readViewerPrivateFile(launch, "launch.json");
    if (raw !== undefined) {
      const r: unknown = JSON.parse(raw);
      if (!validRecord(r, id, launchId, env)) throw new Error("Invalid viewer record prevents removal");
      if (r.pid !== undefined && identityIsAlive(r.pid, r.startTicks)) throw new Error("Viewer browser is still alive");
    }
  });
  const launches = await privateChild(dir, "launches", false);
  try { await fs.promises.rm(launches.resolve(launchId), { recursive: true }); }
  finally { await launches.close(); }
}

export async function removeViewerLaunch(id: string, launchId: string, registryEnv: EnvLike = process.env): Promise<void> {
  await withViewerDir(id, registryEnv, false, dir => removeLaunchIn(dir, id, launchId, registryEnv));
}

async function pruneLaunches(dir: DirHandle, id: string, env: EnvLike): Promise<void> {
  const launches = await privateChild(dir, "launches", true);
  try {
    for (const name of await launches.readEntryNames()) {
      if (!VIEWER_LAUNCH_ID_PATTERN.test(name)) continue;
      const stat = await launches.lstatChild(name);
      const record = await readViewerLaunchRecord(id, name, env);
      const gone = record?.pid !== undefined && !identityIsAlive(record.pid, record.startTicks);
      const old = record?.pid === undefined && Date.now() - (record === undefined ? stat?.mtimeMs ?? Date.now() : Date.parse(record.createdAt)) > 600_000;
      if (gone || old) await removeLaunchIn(dir, id, name, env);
    }
  } finally { await launches.close(); }
}

export async function prepareViewerLaunch(id: string, registryEnv: EnvLike = process.env): Promise<PreparedViewerLaunch> {
  return withViewerDir(id, registryEnv, true, async dir => {
    await pruneLaunches(dir, id, registryEnv);
    const launches = await privateChild(dir, "launches", true);
    const launchId = randomBytes(16).toString("hex");
    let launch: DirHandle | undefined;
    let profile: DirHandle | undefined;
    try {
      await launches.mkdirChild(launchId, 0o700);
      launch = await privateChild(launches, launchId, false);
      profile = await privateChild(launch, "profile", true);
      const launchDir = path.join(sessionViewerDir(id, registryEnv), "launches", launchId);
      return { launchId, launchDir, profileDir: path.join(launchDir, "profile") };
    } finally { await profile?.close(); await launch?.close(); await launches.close(); }
  });
}

export async function connectSessionVncReadOnly(id: string, registryEnv: EnvLike = process.env): Promise<net.Socket> {
  assertSessionId(id);
  return withSessionVncLock(id, registryEnv, async () => {
    const record = await getSession(id, registryEnv);
    if (record?.status !== "running") throw new ViewerVncUnavailableError("session-ended", "Session ended");
    const d = record.desktop;
    if (d === undefined || !positive(d.vncPid) || !positive(d.vncStartTimeTicks) ||
        !positive(d.vncPort) || d.vncPort > 65535 ||
        !processIdentityMatches({ pid: d.vncPid, startTicks: d.vncStartTimeTicks })) {
      throw new ViewerVncUnavailableError("unavailable", "Read-only VNC unavailable");
    }
    if (d.vncViewOnly !== true) throw new ViewerVncUnavailableError("writable", "VNC is writable");
    const port = d.vncPort;
    return new Promise<net.Socket>((resolve, reject) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      const timer = setTimeout(() => fail(), 2_000);
      const fail = (): void => {
        clearTimeout(timer); socket.destroy();
        reject(new ViewerVncUnavailableError("unavailable", "VNC connection failed"));
      };
      socket.once("error", fail);
      socket.once("connect", () => { clearTimeout(timer); socket.off("error", fail); resolve(socket); });
    });
  });
}

async function stopViewerProcess(pid: number | undefined, startTicks: number | undefined): Promise<void> {
  if (pid === undefined) return;
  if (startTicks === undefined) {
    if (identityIsAlive(pid)) throw new Error("Viewer process identity is missing");
    return;
  }
  const result = await stopProcessGroupVerified({ pid, startTicks });
  if (result.outcome !== "terminated" && result.outcome !== "already-dead" && result.outcome !== "reused") {
    throw new Error("Viewer process group is not confirmed gone");
  }
}

export async function stopSessionViewer(id: string, desktop: DesktopSessionInfo | undefined, registryEnv: EnvLike = process.env): Promise<Error[]> {
  const failures: Error[] = [];
  const capture = async (operation: () => Promise<void>): Promise<void> => {
    try { await operation(); } catch { failures.push(new Error("Viewer cleanup failed")); }
  };
  await capture(() => stopViewerProcess(desktop?.viewerBridgePid, desktop?.viewerBridgeStartTimeTicks));
  if (!fs.existsSync(sessionViewerDir(id, registryEnv))) {
    // lstat also detects a dangling symlink, which must not be treated as absent.
    try { await fs.promises.lstat(sessionViewerDir(id, registryEnv)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return failures; }
  }
  await capture(() => withViewerDir(id, registryEnv, false, async dir => {
    if (await dir.lstatChild("launches") === undefined) return;
    const launches = await privateChild(dir, "launches", false);
    try {
      for (const name of await launches.readEntryNames()) {
        await capture(async () => {
          if (!VIEWER_LAUNCH_ID_PATTERN.test(name)) throw new Error("Unknown viewer state");
          const record = await readRecord(dir, id, name, registryEnv);
          if (record === undefined) {
            await withLaunch(dir, name, async launch => {
              if (await launch.lstatChild("launch.json") !== undefined) throw new Error("Invalid viewer record");
            });
          } else await stopViewerProcess(record.pid, record.startTicks);
        });
      }
    } finally { await launches.close(); }
  }));
  if (failures.length === 0) {
    await capture(async () => {
      const session = await DirHandle.open(sessionDataDir(id, registryEnv));
      try {
        const viewer = await privateChild(session, "viewer", false);
        await viewer.close();
        await fs.promises.rm(session.resolve("viewer"), { recursive: true });
      } finally { await session.close(); }
    });
  }
  return failures;
}
