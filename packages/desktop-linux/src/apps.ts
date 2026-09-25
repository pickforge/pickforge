import path from "node:path";
import {
  buildContainedCommand,
  ObservationTimeoutError,
  observationBudget,
  isProcessGroupAlive,
  listChildProcesses,
  listProcessGroupMembers,
  readProcessGroupLeaderIdentity,
  readProcessIdentity,
  runCommand,
  startDaemon,
  stopProcessGroupVerified,
  type ContainmentMechanism,
  type ContainmentScope,
  type EnvLike,
  type ProcessIdentity,
  type RunCommandResult,
} from "@pickforge/lab-core";
import { parseDisplayNumber } from "./display.js";
import { createIsolatedDesktopEnvironment } from "./environment.js";
import type { DesktopRuntimeLayout } from "./runtime.js";
import { sleep } from "./util.js";

const XDOTOOL_TIMEOUT_MS = 5_000;
const WINDOW_POLL_INTERVAL_MS = 100;
const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
export const DEFAULT_EXEC_WINDOW_TIMEOUT_MS = 30_000;
const LAUNCH_GRACE_MS = 300;
const LAUNCH_POLL_INTERVAL_MS = 50;
/**
 * Upper bound on waiting for the containment supervisor to spawn the app.
 * Only a stuck supervisor gets near it; a merely slow one is observed long
 * before. Expiry is a failed launch, never a launch that is assumed to be
 * fine.
 */
const SUPERVISOR_SPAWN_TIMEOUT_MS = 10_000;

export interface LaunchAppOptions {
  display: string;
  command: string;
  args?: string[];
  env?: EnvLike;
  logDir: string;
  cwd?: string;
  /** Per-session `XDG_RUNTIME_DIR` and D-Bus endpoints (#86). */
  runtime?: DesktopRuntimeLayout;
  homePolicy?: "private" | "inherit";
  /**
   * Session containment scope (#85). When given, the app is started through a
   * supervisor that joins the scope before spawning it, so a double-forked or
   * `setsid` descendant is still cleaned up with the session. Without it the
   * app is only contained by its process group, which such a descendant can
   * leave.
   */
  containment?: ContainmentScope;
}

export interface AppHandle {
  /**
   * The process group leader Pickforge owns. With containment this is the
   * supervisor that spawned the app, not the app itself; it is the pid to
   * signal, and the app is a member of its group.
   */
  pid: number;
  logPath: string;
  containment: ContainmentMechanism | "process-group";
}

interface StartedApp extends AppHandle {
  identity: ProcessIdentity;
}

interface AppWaitOwnership extends AppHandle {
  identity?: ProcessIdentity;
}

export interface ExecAppOptions extends LaunchAppOptions {
  windowTimeoutMs?: number;
}

export interface ExecAppHandle extends AppHandle {
  processGroupId: number;
  windows: WindowInfo[];
}

export interface WindowInfo {
  id: string;
  name: string;
}

async function stopAfterFailedAppWait(app: AppWaitOwnership): Promise<void> {
  const identity =
    app.identity ?? readProcessGroupLeaderIdentity(app.pid);
  if (identity === undefined) {
    if (!isProcessGroupAlive(app.pid)) return;
    throw new Error(
      `Could not verify the identity of process group ${app.pid} before stopping it`,
    );
  }
  const stopped = await stopProcessGroupVerified(identity);
  if (stopped.outcome !== "terminated" && stopped.outcome !== "already-dead") {
    throw new Error(`Could not verify that process group ${app.pid} was stopped`);
  }
}

/**
 * What the operator should do when an app's process group dies without ever
 * opening a window. Under real containment a daemonised descendant is still
 * held and will be stopped with the session, so the old "go hunt for a stray
 * process on your real desktop" advice would be wrong.
 */
function escapeAdvice(
  containment: ContainmentMechanism | "process-group",
): string {
  if (containment === "process-group") {
    return (
      "A daemonising child may have escaped the lab and opened on your real desktop. " +
      "Check your real desktop, find any stray process with `pgrep -af <app-name>`, " +
      "and stop it with `kill <pid>`. "
    );
  }
  return (
    `Any daemonising child is still held by the session's ${containment} containment ` +
    "and is stopped when the session is destroyed. "
  );
}

function containmentLabel(
  scope: ContainmentScope | undefined,
): ContainmentMechanism | "process-group" {
  return scope?.mechanism ?? "process-group";
}

/**
 * Resolve what to actually spawn. With a containment scope the app runs under
 * the containment supervisor, which joins the scope *before* exec so no
 * descendant can be forked outside it.
 */
function resolveSpawnTarget(opts: LaunchAppOptions): {
  command: string;
  args: string[];
  name: string;
} {
  const args = opts.args ?? [];
  const name = path.basename(opts.command);
  if (opts.containment === undefined) {
    return { command: opts.command, args, name };
  }
  const contained = buildContainedCommand(
    process.execPath,
    opts.containment,
    opts.command,
    args,
  );
  return { command: contained.command, args: contained.args, name };
}

function hasSupervisedMember(leader: number): boolean {
  return listProcessGroupMembers(leader).some((pid) => pid !== leader);
}

/**
 * Whether the launched app, and every descendant still in its group, is gone.
 * Under a supervisor that is already true once its own child has died and it
 * is the group's only member, the condition it exits on. It only exits after
 * its next poll, though, which on a loaded host can outlast the whole grace
 * window and turn an app that exited at once into a reported launch (#203).
 */
function hasAppExited(opts: LaunchAppOptions, leader: number): boolean {
  if (!isProcessGroupAlive(leader)) return true;
  if (opts.containment === undefined) return false;
  return listChildProcesses(leader).length === 0 && !hasSupervisedMember(leader);
}

/**
 * With a containment scope the group leader is the supervisor, and the app
 * only becomes a group member once Node has started and the scope is joined.
 * A grace window measured from the supervisor's own start counts that startup
 * against the app, so on a loaded host the group can outlive the window before
 * the app has run at all and an app that exits at once is reported as launched
 * (#191). Wait until a second group member is visible, or the group has
 * already died, before the window opens; a supervisor that does neither
 * within the bound is a failed launch, which the caller cleans up. Without a
 * supervisor the leader is the app itself and there is nothing to wait for.
 */
async function waitForSupervisedSpawn(
  opts: LaunchAppOptions,
  leader: number,
  logPath: string,
): Promise<void> {
  if (opts.containment === undefined) return;
  const deadline = Date.now() + SUPERVISOR_SPAWN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isProcessGroupAlive(leader)) return;
    if (hasSupervisedMember(leader)) return;
    await sleep(LAUNCH_POLL_INTERVAL_MS);
  }
  throw new Error(
    `The containment supervisor did not start ${opts.command} on ${opts.display} ` +
      `within ${SUPERVISOR_SPAWN_TIMEOUT_MS}ms. Log: ${logPath}`,
  );
}

async function startApp(opts: LaunchAppOptions): Promise<StartedApp> {
  parseDisplayNumber(opts.display);
  const target = resolveSpawnTarget(opts);
  const daemon = await startDaemon(target.command, target.args, {
    logDir: opts.logDir,
    name: target.name,
    cwd: opts.cwd,
    env: createIsolatedDesktopEnvironment(
      opts.display,
      { ...process.env, ...opts.env },
      {
        homePolicy: opts.homePolicy,
        ...(opts.runtime === undefined ? {} : { runtime: opts.runtime }),
        ...(opts.containment === undefined
          ? {}
          : { containment: opts.containment }),
      },
    ),
    cleanEnv: true,
  });
  const ownershipIdentity = readProcessGroupLeaderIdentity(daemon.pid);
  let identity = readProcessIdentity(daemon.pid);
  let succeeded = false;
  try {
    await waitForSupervisedSpawn(opts, daemon.pid, daemon.logPath);
    const graceDeadline = Date.now() + LAUNCH_GRACE_MS;
    while (Date.now() < graceDeadline) {
      if (hasAppExited(opts, daemon.pid)) {
        throw new Error(
          `${opts.command} exited immediately after launch on ${opts.display}. ` +
            escapeAdvice(containmentLabel(opts.containment)) +
            `Log: ${daemon.logPath}`,
        );
      }
      identity ??= readProcessIdentity(daemon.pid);
      await sleep(LAUNCH_POLL_INTERVAL_MS);
    }
    if (identity === undefined) {
      throw new Error(
        `Could not capture the process identity for ${opts.command} on ${opts.display}`,
      );
    }
    succeeded = true;
    return {
      pid: daemon.pid,
      logPath: daemon.logPath,
      identity,
      containment: containmentLabel(opts.containment),
    };
  } finally {
    if (!succeeded) {
      await stopAfterFailedAppWait({
        pid: daemon.pid,
        logPath: daemon.logPath,
        containment: containmentLabel(opts.containment),
        identity: identity ?? ownershipIdentity,
      });
    }
  }
}

export async function launchApp(opts: LaunchAppOptions): Promise<AppHandle> {
  const app = await startApp(opts);
  return {
    pid: app.pid,
    logPath: app.logPath,
    containment: app.containment,
  };
}

export async function execApp(opts: ExecAppOptions): Promise<ExecAppHandle> {
  const existingWindowIds = new Set(
    (await listWindows(opts.display, opts.env)).map((window) => window.id),
  );
  const app = await startApp(opts);
  const timeoutMs = opts.windowTimeoutMs ?? DEFAULT_EXEC_WINDOW_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let succeeded = false;
  try {
    for (;;) {
      const windows = (await listWindows(opts.display, opts.env)).filter(
        (window) => !existingWindowIds.has(window.id),
      );
      if (windows.length > 0) {
        succeeded = true;
        return {
          pid: app.pid,
          logPath: app.logPath,
          processGroupId: app.pid,
          containment: app.containment,
          windows,
        };
      }
      if (!isProcessGroupAlive(app.pid)) {
        throw new Error(
          `${opts.command} process group exited before opening a client window on ${opts.display}. ` +
            escapeAdvice(app.containment) +
            `Log: ${app.logPath}`,
        );
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `No new client window appeared on ${opts.display} within ${timeoutMs}ms ` +
            `while ${opts.command} was still running. Pickforge stopped process ` +
            `group ${app.pid} because the app may have escaped the lab and ` +
            "opened on your real desktop. If this was a slow first build, " +
            "retry with `--window-timeout <ms>`. " +
            `Log: ${app.logPath}`,
        );
      }
      await sleep(WINDOW_POLL_INTERVAL_MS);
    }
  } finally {
    if (!succeeded) await stopAfterFailedAppWait(app);
  }
}

export function noClientWindowsWarning(
  display: string,
  sessionId: string,
): string {
  return (
    `No client windows are visible on ${display}. If the screenshot is black, ` +
    "the app may have escaped the lab and opened on your real desktop. " +
    `Start it with \`pickforge-lab desktop exec --session ${sessionId} -- <command>\` ` +
    `or run \`eval "$(pickforge-lab desktop env --session ${sessionId})"\` before launching it.`
  );
}

async function runXdotoolQuery(
  display: string,
  args: string[],
  env: EnvLike | undefined,
  timeoutMs: number = XDOTOOL_TIMEOUT_MS,
): Promise<RunCommandResult> {
  try {
    return await runCommand("xdotool", args, {
      env: { ...env, DISPLAY: display },
      timeoutMs,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        "xdotool was not found on PATH; install xdotool to manage windows",
      );
    }
    throw error;
  }
}

export async function listWindows(
  display: string,
  env?: EnvLike,
  timeoutMs?: number,
): Promise<WindowInfo[]> {
  parseDisplayNumber(display);
  // Legacy inventory has per-query bounds. Only explicit observation callers share a deadline.
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  const budget = (): number => deadline === undefined ? XDOTOOL_TIMEOUT_MS : observationBudget(deadline);
  const searchBudget = budget();
  const search = await runXdotoolQuery(
    display,
    ["search", "--onlyvisible", "--name", "."],
    env,
    Math.min(XDOTOOL_TIMEOUT_MS, searchBudget),
  );
  if (search.timedOut) throw new ObservationTimeoutError(`xdotool search timed out on ${display}`);
  if (!search.ok) {
    if (search.code === 1 && search.stderr.trim() === "") {
      return [];
    }
    const detail = search.stderr.trim() || `exit code ${search.code}`;
    throw new Error(`xdotool search failed on ${display}: ${detail}`);
  }
  const ids = search.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line));

  const windows: WindowInfo[] = [];
  for (const id of ids) {
    const left = budget();
    const nameResult = await runXdotoolQuery(
      display,
      ["getwindowname", id],
      env,
      Math.min(XDOTOOL_TIMEOUT_MS, left),
    );
    if (deadline !== undefined) assertObservedTitle(nameResult, display);
    windows.push({
      id,
      name: nameResult.ok ? nameResult.stdout.replace(/\n$/, "") : "",
    });
  }
  return windows;
}

function assertObservedTitle(result: RunCommandResult, display: string): void {
  if (result.timedOut) throw new ObservationTimeoutError(`xdotool title query timed out on ${display}`);
  if (result.ok) return;
  // The window may disappear between search and getwindowname. Other query failures
  // (including loss of the X connection) are not successful observations.
  if (/BadWindow \(invalid Window parameter\)/.test(result.stderr)) return;
  throw new Error(`xdotool title query failed on ${display}: ${result.stderr.trim() || `exit code ${result.code}`}`);
}

export async function waitForWindow(
  display: string,
  namePattern: string | RegExp,
  timeoutMs: number = DEFAULT_WAIT_TIMEOUT_MS,
  env?: EnvLike,
): Promise<WindowInfo> {
  const matches =
    typeof namePattern === "string"
      ? (name: string): boolean => name.includes(namePattern)
      : (name: string): boolean => namePattern.test(name);
  const description =
    typeof namePattern === "string"
      ? JSON.stringify(namePattern)
      : String(namePattern);
  const deadline = Date.now() + timeoutMs;
  let lastSeen: WindowInfo[] = [];
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      lastSeen = await listWindows(display, env, remaining);
    } catch (error) {
      if (error instanceof ObservationTimeoutError) break;
      throw error;
    }
    if (Date.now() >= deadline) break;
    const match = lastSeen.find((win) => matches(win.name));
    if (match !== undefined) {
      return match;
    }
    if (Date.now() >= deadline) {
      break;
    }
    await sleep(Math.min(WINDOW_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }
  const seen = lastSeen.map((win) => JSON.stringify(win.name)).join(", ");
  throw new Error(
    `No window matching ${description} appeared on ${display} within ${timeoutMs}ms` +
      (seen === "" ? "" : `; visible windows: ${seen}`),
  );
}
