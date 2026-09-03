import {
  isProcessGroupAlive,
  readProcessIdentity,
  runCommand,
  startDaemon,
  stopProcessGroupVerified,
  type EnvLike,
  type ProcessIdentity,
  type RunCommandResult,
} from "@pickforge/picklab-core";
import { parseDisplayNumber } from "./display.js";
import { createIsolatedDesktopEnvironment } from "./environment.js";
import { sleep } from "./util.js";

const XDOTOOL_TIMEOUT_MS = 5_000;
const WINDOW_POLL_INTERVAL_MS = 100;
const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
export const DEFAULT_EXEC_WINDOW_TIMEOUT_MS = 30_000;
const LAUNCH_GRACE_MS = 300;
const LAUNCH_POLL_INTERVAL_MS = 50;

export interface LaunchAppOptions {
  display: string;
  command: string;
  args?: string[];
  env?: EnvLike;
  logDir: string;
  cwd?: string;
}

export interface AppHandle {
  pid: number;
  logPath: string;
}

interface StartedApp extends AppHandle {
  identity: ProcessIdentity;
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

async function startApp(opts: LaunchAppOptions): Promise<StartedApp> {
  parseDisplayNumber(opts.display);
  const daemon = await startDaemon(opts.command, opts.args ?? [], {
    logDir: opts.logDir,
    cwd: opts.cwd,
    env: createIsolatedDesktopEnvironment(opts.display, {
      ...process.env,
      ...opts.env,
    }),
    cleanEnv: true,
  });
  let identity = readProcessIdentity(daemon.pid);
  const graceDeadline = Date.now() + LAUNCH_GRACE_MS;
  while (Date.now() < graceDeadline) {
    if (!isProcessGroupAlive(daemon.pid)) {
      throw new Error(
        `${opts.command} exited immediately after launch on ${opts.display}; ` +
          `check the log at ${daemon.logPath}`,
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
  return { pid: daemon.pid, logPath: daemon.logPath, identity };
}

export async function launchApp(opts: LaunchAppOptions): Promise<AppHandle> {
  const app = await startApp(opts);
  return { pid: app.pid, logPath: app.logPath };
}

export async function execApp(opts: ExecAppOptions): Promise<ExecAppHandle> {
  const existingWindowIds = new Set(
    (await listWindows(opts.display, opts.env)).map((window) => window.id),
  );
  const app = await startApp(opts);
  const timeoutMs = opts.windowTimeoutMs ?? DEFAULT_EXEC_WINDOW_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const windows = (await listWindows(opts.display, opts.env)).filter(
      (window) => !existingWindowIds.has(window.id),
    );
    if (windows.length > 0) {
      return {
        pid: app.pid,
        logPath: app.logPath,
        processGroupId: app.pid,
        windows,
      };
    }
    if (!isProcessGroupAlive(app.pid)) {
      throw new Error(
        `${opts.command} process group exited before opening a client window on ${opts.display}; ` +
          `check the log at ${app.logPath}`,
      );
    }
    if (Date.now() >= deadline) {
      const stopped = await stopProcessGroupVerified(app.identity);
      if (
        stopped.outcome !== "terminated" &&
        stopped.outcome !== "already-dead"
      ) {
        throw new Error(
          `Could not verify that process group ${app.pid} was stopped after ` +
            `no client window appeared on ${opts.display} within ${timeoutMs}ms`,
        );
      }
      throw new Error(
        `No new client window appeared on ${opts.display} within ${timeoutMs}ms ` +
          `while ${opts.command} was still running. PickLab stopped process ` +
          `group ${app.pid} because the app may have escaped the lab and ` +
          "opened on your real desktop. If this was a slow first build, " +
          "retry with `--window-timeout <ms>`. " +
          `Log: ${app.logPath}`,
      );
    }
    await sleep(WINDOW_POLL_INTERVAL_MS);
  }
}

export function noClientWindowsWarning(
  display: string,
  sessionId: string,
): string {
  return (
    `No client windows are visible on ${display}. If the screenshot is black, ` +
    "the app may have escaped the lab and opened on your real desktop. " +
    `Start it with \`picklab desktop exec --session ${sessionId} -- <command>\` ` +
    `or run \`eval "$(picklab desktop env --session ${sessionId})"\` before launching it.`
  );
}

async function runXdotoolQuery(
  display: string,
  args: string[],
  env: EnvLike | undefined,
): Promise<RunCommandResult> {
  try {
    return await runCommand("xdotool", args, {
      env: { ...env, DISPLAY: display },
      timeoutMs: XDOTOOL_TIMEOUT_MS,
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
): Promise<WindowInfo[]> {
  parseDisplayNumber(display);
  const search = await runXdotoolQuery(
    display,
    ["search", "--onlyvisible", "--name", "."],
    env,
  );
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
    const nameResult = await runXdotoolQuery(
      display,
      ["getwindowname", id],
      env,
    );
    windows.push({
      id,
      name: nameResult.ok ? nameResult.stdout.replace(/\n$/, "") : "",
    });
  }
  return windows;
}

export async function waitForWindow(
  display: string,
  namePattern: string | RegExp,
  timeoutMs: number = DEFAULT_WAIT_TIMEOUT_MS,
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
    lastSeen = await listWindows(display);
    const match = lastSeen.find((win) => matches(win.name));
    if (match !== undefined) {
      return match;
    }
    if (Date.now() >= deadline) {
      break;
    }
    await sleep(WINDOW_POLL_INTERVAL_MS);
  }
  const seen = lastSeen.map((win) => JSON.stringify(win.name)).join(", ");
  throw new Error(
    `No window matching ${description} appeared on ${display} within ${timeoutMs}ms` +
      (seen === "" ? "" : `; visible windows: ${seen}`),
  );
}
