import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  DirHandle,
  getSession,
  sessionDataDir,
  identityIsAlive,
  listProcessGroupMembers,
  processIdentityMatches,
  readProcessIdentity,
  readProcessGroupLeaderIdentity,
} from "@pickforge/lab-core";
import type { DesktopSessionInfo, EnvLike } from "@pickforge/lab-core";
import { withSessionVncLock } from "./session.js";
import { sleep } from "./util.js";

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
  browser: {
    kind: ViewerBrowserKind;
    binary: string;
  };
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

export type ViewerVncUnavailableReason =
  | "unavailable"
  | "writable"
  | "session-ended";

/** Why the bridge could not reach a read-only VNC server for the session. */
export class ViewerVncUnavailableError extends Error {
  readonly reason: ViewerVncUnavailableReason;

  constructor(reason: ViewerVncUnavailableReason, message: string) {
    super(message);
    this.name = "ViewerVncUnavailableError";
    this.reason = reason;
  }
}

function assertSessionId(sessionId: string): void {
  if (!/^(desk|andr|duo|brow)-[0-9a-f]{6,}$/.test(sessionId)) {
    throw new Error("Invalid session id");
  }
}

/** Return the private viewer directory for a valid session id. */
export function sessionViewerDir(
  sessionId: string,
  registryEnv: EnvLike = process.env,
): string {
  assertSessionId(sessionId);
  return path.join(sessionDataDir(sessionId, registryEnv), "viewer");
}

function assertPrivate(stats: fs.Stats, directory: boolean): void {
  if (
    stats.uid !== process.getuid?.() ||
    (stats.mode & 0o777) !== (directory ? 0o700 : 0o600) ||
    (directory ? !stats.isDirectory() : !stats.isFile())
  ) {
    throw new Error("Unsafe viewer state ownership or permissions");
  }
}

async function privateChild(
  parent: DirHandle,
  name: string,
  create: boolean,
): Promise<DirHandle> {
  const directoryHandle = await (create
    ? parent.ensureChildDir(name, 0o700)
    : parent.openChild(name));
  try {
    assertPrivate(directoryHandle.stat, true);
    return directoryHandle;
  } catch (error) {
    await directoryHandle.close();
    throw error;
  }
}

/** Bind all state access to verified directory descriptors. */
export async function withViewerDir<T>(
  sessionId: string,
  registryEnv: EnvLike,
  create: boolean,
  operation: (directoryHandle: DirHandle) => Promise<T>,
): Promise<T> {
  const viewer = sessionViewerDir(sessionId, registryEnv);
  const registryRoot = await DirHandle.open(
    path.dirname(path.dirname(viewer)),
    {
      followFinal: true,
    },
  );
  let sessionDirectory: DirHandle | undefined;
  let directoryHandle: DirHandle | undefined;
  try {
    if (registryRoot.stat.uid !== process.getuid?.()) {
      throw new Error("Wrong session directory owner");
    }
    sessionDirectory = await (create
      ? registryRoot.ensureChildDir(sessionId, 0o700)
      : registryRoot.openChild(sessionId));
    if (sessionDirectory.stat.uid !== process.getuid?.()) {
      throw new Error("Wrong session data owner");
    }
    directoryHandle = await privateChild(sessionDirectory, "viewer", create);
    return await operation(directoryHandle);
  } finally {
    await directoryHandle?.close();
    await sessionDirectory?.close();
    await registryRoot.close();
  }
}

/** Reject special files before open; O_NOFOLLOW also closes the symlink race. */
export async function readViewerPrivateFile(
  directoryHandle: DirHandle,
  name: string,
): Promise<string | undefined> {
  const stats = await directoryHandle.lstatChild(name);
  if (stats === undefined) {
    return undefined;
  }
  assertPrivate(stats, false);
  const file = await directoryHandle.openFile(
    name,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const fileStat = await file.stat();
    assertPrivate(fileStat, false);
    if (fileStat.size > 64 * 1024) {
      throw new Error("Viewer state file is too large");
    }
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

/** Write a private state file atomically through its verified directory. */
export async function writeViewerPrivateFile(
  directoryHandle: DirHandle,
  name: string,
  content: string,
): Promise<void> {
  const existing = await directoryHandle.lstatChild(name);
  if (existing !== undefined) {
    assertPrivate(existing, false);
  }
  const temporaryName = `.tmp-${randomBytes(16).toString("hex")}`;
  const file = await directoryHandle.openFile(
    temporaryName,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.chmod(0o600);
    await file.writeFile(content, "utf8");
    await file.sync();
    const target = await directoryHandle.lstatChild(name);
    if (target !== undefined) {
      assertPrivate(target, false);
    }
    await fs.promises.rename(
      directoryHandle.resolve(temporaryName),
      directoryHandle.resolve(name),
    );
  } finally {
    await file.close();
    await directoryHandle.unlinkChild(temporaryName);
  }
}

function validSize(value: unknown): value is ViewerWindowSize {
  const size = value as ViewerWindowSize | undefined;
  if (size === null || size === undefined) {
    return false;
  }
  return positive(size.width) && positive(size.height);
}

function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function absolutePath(value: unknown): value is string {
  return typeof value === "string" && path.isAbsolute(value);
}

function validHyprlandInstance(value: unknown): boolean {
  return typeof value === "string" && /^[A-Za-z0-9_]+$/.test(value);
}

function validClassPattern(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length <= 512 &&
    !/[\x00-\x1f\x7f-\x9f]/.test(value)
  );
}

function validHyprland(
  hyprland: ViewerHyprlandLaunch | undefined,
  launchId: string,
): boolean {
  if (hyprland === undefined) {
    return true;
  }
  if (hyprland === null || !absolutePath(hyprland.hyprctl)) {
    return false;
  }
  if (!validHyprlandInstance(hyprland.instance)) {
    return false;
  }
  if (!absolutePath(hyprland.xdgRuntimeDir)) {
    return false;
  }
  if (hyprland.ruleName !== `pickforge-viewer-${launchId}`) {
    return false;
  }
  return validClassPattern(hyprland.classPattern);
}

function validBrowserIdentity(launchRecord: ViewerLaunchRecord): boolean {
  if (launchRecord.pid !== undefined && !positive(launchRecord.pid)) {
    return false;
  }
  if (launchRecord.startTicks === undefined) {
    return true;
  }
  return positive(launchRecord.startTicks) && launchRecord.pid !== undefined;
}

function validBrowser(
  launchRecord: ViewerLaunchRecord,
  sessionId: string,
  launchId: string,
  registryEnv: EnvLike,
): boolean {
  const browser = launchRecord.browser;
  if (browser?.kind !== "chromium" && browser?.kind !== "firefox") {
    return false;
  }
  if (!absolutePath(browser.binary)) {
    return false;
  }
  const expectedProfile = path.join(
    sessionViewerDir(sessionId, registryEnv),
    "launches",
    launchId,
    "profile",
  );
  if (launchRecord.profileDir !== expectedProfile) {
    return false;
  }
  return validBrowserIdentity(launchRecord);
}

function validCreatedAt(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validRecord(
  value: unknown,
  sessionId: string,
  launchId: string,
  registryEnv: EnvLike,
): value is ViewerLaunchRecord {
  const launchRecord = value as ViewerLaunchRecord | undefined;
  if (
    launchRecord === null ||
    launchRecord === undefined ||
    typeof launchRecord !== "object"
  ) {
    return false;
  }
  if (
    !VIEWER_LAUNCH_ID_PATTERN.test(launchId) ||
    launchRecord.launchId !== launchId ||
    launchRecord.sessionId !== sessionId
  ) {
    return false;
  }
  if (!validCreatedAt(launchRecord.createdAt)) {
    return false;
  }
  if (!validBrowser(launchRecord, sessionId, launchId, registryEnv)) {
    return false;
  }
  if (!validSize(launchRecord.thumbnail) || !validSize(launchRecord.expanded)) {
    return false;
  }
  return validHyprland(launchRecord.hyprland, launchId);
}

async function withLaunch<T>(
  directoryHandle: DirHandle,
  launchId: string,
  operation: (launch: DirHandle) => Promise<T>,
): Promise<T> {
  if (!VIEWER_LAUNCH_ID_PATTERN.test(launchId)) {
    throw new Error("Invalid viewer launch id");
  }
  const launches = await privateChild(directoryHandle, "launches", false);
  let launch: DirHandle | undefined;
  try {
    launch = await privateChild(launches, launchId, false);
    return await operation(launch);
  } finally {
    await launch?.close();
    await launches.close();
  }
}

async function readRecord(
  directoryHandle: DirHandle,
  sessionId: string,
  launchId: string,
  registryEnv: EnvLike,
): Promise<ViewerLaunchRecord | undefined> {
  return withLaunch(directoryHandle, launchId, async (launch) => {
    const profile = await privateChild(launch, "profile", false);
    await profile.close();
    const recordJson = await readViewerPrivateFile(launch, "launch.json");
    if (recordJson === undefined) {
      return undefined;
    }
    const record: unknown = JSON.parse(recordJson);
    return validRecord(record, sessionId, launchId, registryEnv)
      ? record
      : undefined;
  });
}

/** Read a validated launch record, or return undefined for unsafe or absent state. */
export async function readViewerLaunchRecord(
  sessionId: string,
  launchId: string,
  registryEnv: EnvLike = process.env,
): Promise<ViewerLaunchRecord | undefined> {
  try {
    return await withViewerDir(
      sessionId,
      registryEnv,
      false,
      (directoryHandle) =>
        readRecord(directoryHandle, sessionId, launchId, registryEnv),
    );
  } catch {
    return undefined;
  }
}

/** Validate and atomically write a launch record with mode 0600. */
export async function writeViewerLaunchRecord(
  record: ViewerLaunchRecord,
  registryEnv: EnvLike = process.env,
): Promise<void> {
  if (!validRecord(record, record.sessionId, record.launchId, registryEnv)) {
    throw new Error("Invalid viewer launch record");
  }
  await withViewerDir(record.sessionId, registryEnv, false, (directoryHandle) =>
    withLaunch(directoryHandle, record.launchId, async (launch) => {
      const profile = await privateChild(launch, "profile", false);
      await profile.close();
      await writeViewerPrivateFile(
        launch,
        "launch.json",
        `${JSON.stringify(record)}\n`,
      );
    }),
  );
}

async function removeLaunchIn(
  directoryHandle: DirHandle,
  sessionId: string,
  launchId: string,
  registryEnv: EnvLike,
): Promise<void> {
  await withLaunch(directoryHandle, launchId, async (launch) => {
    const recordJson = await readViewerPrivateFile(launch, "launch.json");
    if (recordJson !== undefined) {
      const launchRecord: unknown = JSON.parse(recordJson);
      if (!validRecord(launchRecord, sessionId, launchId, registryEnv)) {
        throw new Error("Invalid viewer record prevents removal");
      }
      if (remainingViewerProcesses(launchRecord).length !== 0) {
        await waitForViewerGroupExit(launchRecord);
        const remaining = remainingViewerProcesses(launchRecord);
        if (remaining.length !== 0) {
          throw new ViewerProcessesAliveError(remaining, launchId);
        }
      }
    }
  });
  const launches = await privateChild(directoryHandle, "launches", false);
  try {
    await fs.promises.rm(launches.resolve(launchId), { recursive: true });
  } finally {
    await launches.close();
  }
}

/** Remove a launch only after its recorded browser is confirmed gone. */
export async function removeViewerLaunch(
  sessionId: string,
  launchId: string,
  registryEnv: EnvLike = process.env,
): Promise<void> {
  await withViewerDir(sessionId, registryEnv, false, (directoryHandle) =>
    removeLaunchIn(directoryHandle, sessionId, launchId, registryEnv),
  );
}

async function pruneLaunchEntry(
  directoryHandle: DirHandle,
  launches: DirHandle,
  sessionId: string,
  name: string,
  registryEnv: EnvLike,
): Promise<void> {
  const stats = await launches.lstatChild(name);
  const record = await readViewerLaunchRecord(sessionId, name, registryEnv);
  const gone =
    record?.pid !== undefined &&
    !identityIsAlive(record.pid, record.startTicks);
  const old =
    record?.pid === undefined &&
    Date.now() -
      (record === undefined
        ? (stats?.mtimeMs ?? Date.now())
        : Date.parse(record.createdAt)) >
      600_000;
  if (gone || old) {
    await removeLaunchIn(directoryHandle, sessionId, name, registryEnv);
  }
}

async function pruneLaunches(
  directoryHandle: DirHandle,
  sessionId: string,
  registryEnv: EnvLike,
): Promise<void> {
  const launches = await privateChild(directoryHandle, "launches", true);
  try {
    for (const name of await launches.readEntryNames()) {
      if (!VIEWER_LAUNCH_ID_PATTERN.test(name)) {
        continue;
      }
      try {
        await pruneLaunchEntry(
          directoryHandle,
          launches,
          sessionId,
          name,
          registryEnv,
        );
      } catch {
        // Keep unsafe entries for teardown to report; they must not block a new launch.
      }
    }
  } finally {
    await launches.close();
  }
}

/** Create a private browser profile and prune confirmed dead or stale launches. */
export async function prepareViewerLaunch(
  sessionId: string,
  registryEnv: EnvLike = process.env,
): Promise<PreparedViewerLaunch> {
  return withViewerDir(
    sessionId,
    registryEnv,
    true,
    async (directoryHandle) => {
      await pruneLaunches(directoryHandle, sessionId, registryEnv);
      const launches = await privateChild(directoryHandle, "launches", true);
      const launchId = randomBytes(16).toString("hex");
      let launch: DirHandle | undefined;
      let profile: DirHandle | undefined;
      try {
        await launches.mkdirChild(launchId, 0o700);
        launch = await privateChild(launches, launchId, false);
        profile = await privateChild(launch, "profile", true);
        const launchDir = path.join(
          sessionViewerDir(sessionId, registryEnv),
          "launches",
          launchId,
        );
        return {
          launchId,
          launchDir,
          profileDir: path.join(launchDir, "profile"),
        };
      } finally {
        await profile?.close();
        await launch?.close();
        await launches.close();
      }
    },
  );
}

function validVncDesktop(
  desktop: DesktopSessionInfo | undefined,
): desktop is DesktopSessionInfo & {
  vncPid: number;
  vncStartTimeTicks: number;
  vncPort: number;
} {
  if (desktop === undefined) {
    return false;
  }
  if (!positive(desktop.vncPid) || !positive(desktop.vncStartTimeTicks)) {
    return false;
  }
  if (!positive(desktop.vncPort) || desktop.vncPort > 65_535) {
    return false;
  }
  return processIdentityMatches({
    pid: desktop.vncPid,
    startTicks: desktop.vncStartTimeTicks,
  });
}

/** Verify and connect to read-only VNC while holding the session's VNC lock. */
export async function connectSessionVncReadOnly(
  sessionId: string,
  registryEnv: EnvLike = process.env,
): Promise<net.Socket> {
  assertSessionId(sessionId);
  return withSessionVncLock(sessionId, registryEnv, async () => {
    const record = await getSession(sessionId, registryEnv);
    if (record?.status !== "running") {
      throw new ViewerVncUnavailableError("session-ended", "Session ended");
    }
    const desktop = record.desktop;
    if (!validVncDesktop(desktop)) {
      throw new ViewerVncUnavailableError(
        "unavailable",
        "Read-only VNC unavailable",
      );
    }
    if (desktop.vncViewOnly !== true) {
      throw new ViewerVncUnavailableError("writable", "VNC is writable");
    }
    const port = desktop.vncPort;
    return new Promise<net.Socket>((resolve, reject) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      const timer = setTimeout(() => fail(), 2_000);
      const fail = (): void => {
        clearTimeout(timer);
        socket.destroy();
        reject(
          new ViewerVncUnavailableError("unavailable", "VNC connection failed"),
        );
      };
      socket.once("error", fail);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.off("error", fail);
        resolve(socket);
      });
    });
  });
}

interface ViewerProcessOwner {
  pid?: number;
  startTicks?: number;
  profileDir?: string;
}

class ViewerProcessesAliveError extends Error {
  constructor(pids: number[], launchId?: string) {
    const launch =
      launchId === undefined ? "" : ` for launch ${JSON.stringify(launchId)}`;
    super(`Viewer processes are still alive${launch}: pids ${pids.join(", ")}`);
    this.name = "ViewerProcessesAliveError";
  }
}

function remainingViewerProcesses(owner: ViewerProcessOwner): number[] {
  if (owner.pid === undefined) {
    return [];
  }
  const current = readProcessIdentity(owner.pid);
  if (current !== undefined && owner.startTicks !== undefined) {
    if (current.startTicks !== owner.startTicks) {
      // Linux cannot reuse a pid while the old group still has members.
      return [];
    }
  }
  const members = listProcessGroupMembers(owner.pid);
  if (identityIsAlive(owner.pid) && !members.includes(owner.pid)) {
    members.push(owner.pid);
  }
  return members;
}

async function waitForViewerGroupExit(
  owner: ViewerProcessOwner,
): Promise<boolean> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (remainingViewerProcesses(owner).length === 0) {
      return true;
    }
    await sleep(25);
  }
  return remainingViewerProcesses(owner).length === 0;
}

function processHasViewerProfile(
  pid: number,
  profileDir: string | undefined,
): boolean {
  if (profileDir === undefined) {
    return false;
  }
  try {
    const argumentsList = fs
      .readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .split("\0");
    return argumentsList.some(
      (argument) =>
        argument === profileDir || argument === `--user-data-dir=${profileDir}`,
    );
  } catch {
    return false;
  }
}

function signalViewerPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}

function signalOwnedViewerProcesses(
  owner: ViewerProcessOwner,
  signal: NodeJS.Signals,
): boolean {
  if (owner.pid === undefined) {
    return false;
  }
  const leader = readProcessGroupLeaderIdentity(owner.pid);
  if (leader !== undefined && leader.startTicks === owner.startTicks) {
    if (processIdentityMatches(leader)) {
      signalViewerPid(-leader.pid, signal);
      return true;
    }
  }
  let signaled = false;
  for (const pid of remainingViewerProcesses(owner)) {
    const identity = readProcessIdentity(pid);
    if (identity === undefined) {
      continue;
    }
    const recorded =
      pid === owner.pid && identity.startTicks === owner.startTicks;
    if (!recorded && !processHasViewerProfile(pid, owner.profileDir)) {
      continue;
    }
    // Recheck the captured identity after reading cmdline and before every signal.
    if (processIdentityMatches(identity)) {
      signalViewerPid(pid, signal);
      signaled = true;
    }
  }
  return signaled;
}

async function stopViewerProcess(owner: ViewerProcessOwner): Promise<void> {
  if (remainingViewerProcesses(owner).length === 0) {
    return;
  }
  signalOwnedViewerProcesses(owner, "SIGTERM");
  if (await waitForViewerGroupExit(owner)) {
    return;
  }
  if (signalOwnedViewerProcesses(owner, "SIGKILL")) {
    if (await waitForViewerGroupExit(owner)) {
      return;
    }
  }
  const remaining = remainingViewerProcesses(owner);
  if (remaining.length !== 0) {
    throw new ViewerProcessesAliveError(remaining);
  }
}

/** Stop verified viewer processes and remove state only when cleanup succeeds. */
export async function stopSessionViewer(
  sessionId: string,
  desktop: DesktopSessionInfo | undefined,
  registryEnv: EnvLike = process.env,
): Promise<Error[]> {
  const failures: Error[] = [];
  const capture = async (
    operation: () => Promise<void>,
    message = "Viewer cleanup failed",
  ): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      const detail =
        error instanceof ViewerProcessesAliveError ? `: ${error.message}` : "";
      failures.push(new Error(`${message}${detail}`));
    }
  };
  await capture(
    () =>
      stopViewerProcess({
        pid: desktop?.viewerBridgePid,
        startTicks: desktop?.viewerBridgeStartTimeTicks,
      }),
    "Viewer bridge cleanup failed",
  );
  if (!fs.existsSync(sessionViewerDir(sessionId, registryEnv))) {
    // lstat also detects a dangling symlink, which must not be treated as absent.
    try {
      await fs.promises.lstat(sessionViewerDir(sessionId, registryEnv));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return failures;
      }
    }
  }
  await capture(() =>
    withViewerDir(sessionId, registryEnv, false, async (directoryHandle) => {
      if ((await directoryHandle.lstatChild("launches")) === undefined) {
        return;
      }
      const launches = await privateChild(directoryHandle, "launches", false);
      try {
        for (const name of await launches.readEntryNames()) {
          await capture(
            async () => {
              if (!VIEWER_LAUNCH_ID_PATTERN.test(name)) {
                throw new Error("Unknown viewer state");
              }
              const record = await readRecord(
                directoryHandle,
                sessionId,
                name,
                registryEnv,
              );
              if (record === undefined) {
                await withLaunch(directoryHandle, name, async (launch) => {
                  if ((await launch.lstatChild("launch.json")) !== undefined) {
                    throw new Error("Invalid viewer record");
                  }
                });
              } else {
                await stopViewerProcess(record);
              }
            },
            `Viewer cleanup failed for launch ${JSON.stringify(name)}`,
          );
        }
      } finally {
        await launches.close();
      }
    }),
  );
  if (failures.length === 0) {
    await capture(async () => {
      const sessionDirectory = await DirHandle.open(
        sessionDataDir(sessionId, registryEnv),
      );
      try {
        const viewer = await privateChild(sessionDirectory, "viewer", false);
        await viewer.close();
        await fs.promises.rm(sessionDirectory.resolve("viewer"), {
          recursive: true,
        });
      } finally {
        await sessionDirectory.close();
      }
    });
  }
  return failures;
}
