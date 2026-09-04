import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 2_000;
const POLL_INTERVAL_MS = 50;

export interface RunCommandOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  cleanEnv?: boolean;
  timeoutMs?: number;
  killGraceMs?: number;
  maxOutputBytes?: number;
  check?: boolean;
  input?: string;
  binary?: boolean;
}

export interface RunCommandResult {
  ok: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stdoutBuffer?: Buffer;
  stderr: string;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export class CommandError extends Error {
  readonly result: RunCommandResult;

  constructor(cmd: string, args: readonly string[], result: RunCommandResult) {
    const reason =
      result.code !== null
        ? `exited with code ${result.code}`
        : `killed with signal ${result.signal ?? "unknown"}`;
    super(
      `Command failed (${reason}${result.timedOut ? ", timed out" : ""}): ` +
        `${cmd} ${args.join(" ")}`,
    );
    this.name = "CommandError";
    this.result = result;
  }
}

function resolveEnv(opts: {
  env?: Record<string, string | undefined>;
  cleanEnv?: boolean;
}): NodeJS.ProcessEnv {
  if (opts.cleanEnv) {
    return (opts.env ?? {}) as NodeJS.ProcessEnv;
  }
  return { ...process.env, ...opts.env } as NodeJS.ProcessEnv;
}

export function runCommand(
  cmd: string,
  args: readonly string[],
  opts: RunCommandOptions & { binary: true },
): Promise<RunCommandResult & { stdoutBuffer: Buffer }>;
export function runCommand(
  cmd: string,
  args: readonly string[],
  opts?: RunCommandOptions,
): Promise<RunCommandResult>;
// eslint-disable-next-line max-lines-per-function -- Legacy gate debt: pickforge/pickforge#60
export function runCommand(
  cmd: string,
  args: readonly string[],
  opts: RunCommandOptions = {},
): Promise<RunCommandResult> {
  // eslint-disable-next-line max-lines-per-function -- Legacy gate debt: pickforge/pickforge#60
  return new Promise((resolve, reject) => {
    const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: resolveEnv(opts),
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    const timers: NodeJS.Timeout[] = [];

    const collect = (
      chunks: Buffer[],
      counted: number,
      chunk: Buffer,
    ): number => {
      if (counted >= maxBytes) return counted + chunk.length;
      const remaining = maxBytes - counted;
      chunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk);
      return counted + chunk.length;
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = collect(stdoutChunks, stdoutBytes, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = collect(stderrChunks, stderrBytes, chunk);
    });

    const buildResult = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): RunCommandResult => {
      const stdoutBuffer = Buffer.concat(stdoutChunks);
      const result: RunCommandResult = {
        ok: code === 0 && !timedOut,
        code,
        signal,
        stdout: opts.binary ? "" : stdoutBuffer.toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut,
        stdoutTruncated: stdoutBytes > maxBytes,
        stderrTruncated: stderrBytes > maxBytes,
      };
      if (opts.binary) {
        result.stdoutBuffer = stdoutBuffer;
      }
      return result;
    };

    const settle = (result: RunCommandResult): void => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      if (opts.check && !result.ok) {
        reject(new CommandError(cmd, args, result));
        return;
      }
      resolve(result);
    };

    const killTree = (signal: NodeJS.Signals): void => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // fall through to direct kill
        }
      }
      try {
        child.kill(signal);
      } catch {
        // already gone
      }
    };

    if (opts.timeoutMs !== undefined) {
      timers.push(
        setTimeout(() => {
          timedOut = true;
          killTree("SIGTERM");
          timers.push(
            setTimeout(() => {
              killTree("SIGKILL");
              timers.push(
                setTimeout(() => {
                  child.stdout.destroy();
                  child.stderr.destroy();
                  child.stdin.destroy();
                  settle(
                    buildResult(exitCode, exited ? exitSignal : "SIGKILL"),
                  );
                }, killGraceMs),
              );
            }, killGraceMs),
          );
        }, opts.timeoutMs),
      );
    }

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      reject(error);
    });

    child.on("exit", (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
    });

    child.on("close", (code, signal) => {
      settle(buildResult(code, signal));
    });

    child.stdin.on("error", () => {
      // child exited before consuming stdin (EPIPE); output collection continues
    });
    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
    }
    child.stdin.end();
  });
}

export interface StartDaemonOptions {
  logDir: string;
  name?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  cleanEnv?: boolean;
}

export interface DaemonHandle {
  pid: number;
  logPath: string;
}

export interface OwnedDaemonHandle extends DaemonHandle {
  child: ChildProcess;
  release(): void;
}

export function startDaemon(
  cmd: string,
  args: readonly string[],
  opts: StartDaemonOptions & { owned: true },
): Promise<OwnedDaemonHandle>;
export function startDaemon(
  cmd: string,
  args: readonly string[],
  opts: StartDaemonOptions,
): Promise<DaemonHandle>;

export async function startDaemon(
  cmd: string,
  args: readonly string[],
  opts: StartDaemonOptions & { owned?: boolean },
): Promise<DaemonHandle | OwnedDaemonHandle> {
  await fs.promises.mkdir(opts.logDir, { recursive: true });
  const name = opts.name ?? path.basename(cmd);
  const logPath = path.join(opts.logDir, `${name}.log`);
  const fd = fs.openSync(logPath, "a");

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: resolveEnv(opts),
      shell: false,
      detached: true,
      stdio: ["ignore", fd, fd],
    });
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }

  return new Promise<DaemonHandle | OwnedDaemonHandle>((resolve, reject) => {
    const onSpawn = (): void => {
      cleanup();
      if (child.pid === undefined) {
        reject(new Error(`Failed to start daemon: ${cmd}`));
        return;
      }
      if (opts.owned === true) {
        let released = false;
        resolve({
          pid: child.pid,
          logPath,
          child,
          release: () => {
            if (released) return;
            released = true;
            child.unref();
          },
        });
      } else {
        child.unref();
        resolve({ pid: child.pid, logPath });
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
      fs.closeSync(fd);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}

export async function stopPid(
  pid: number,
  opts: { timeoutMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  if (!isPidAlive(pid)) return true;

  signalPid(pid, "SIGTERM");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(POLL_INTERVAL_MS);
  }

  signalPid(pid, "SIGKILL");
  const killDeadline = Date.now() + 1_000;
  while (Date.now() < killDeadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return !isPidAlive(pid);
}

/**
 * A process's identity: its PID plus the `/proc` start time (field 22 of
 * `/proc/<pid>/stat`, in clock ticks). The start time distinguishes a live
 * process from a later, unrelated process that the kernel happened to assign
 * the same PID, so callers can refuse to signal a reused PID.
 */
export interface ProcessIdentity {
  pid: number;
  startTicks: number;
}

interface ProcStat {
  state: string;
  pgrp: number;
  startTicks: number;
}

/**
 * Parse the fields we care about out of a `/proc/<pid>/stat` line. The `comm`
 * field (field 2) is wrapped in parentheses and may itself contain spaces or
 * parentheses, so we anchor on the final `)` and index the numeric fields that
 * follow it.
 */
export function parseProcStat(content: string): ProcStat | undefined {
  const close = content.lastIndexOf(")");
  if (close === -1) return undefined;
  const fields = content.slice(close + 1).trim().split(/\s+/);
  // fields[0] is field 3 (state); field N maps to fields[N - 3].
  const state = fields[0];
  const pgrp = Number(fields[5 - 3]);
  const startTicks = Number(fields[22 - 3]);
  if (
    state === undefined ||
    !Number.isFinite(pgrp) ||
    !Number.isFinite(startTicks)
  ) {
    return undefined;
  }
  return { state, pgrp, startTicks };
}

function readProcStat(pid: number): ProcStat | undefined {
  let content: string;
  try {
    content = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return undefined;
  }
  return parseProcStat(content);
}

/** Read a process's start time in clock ticks, or undefined if it is gone. */
export function readProcessStartTicks(pid: number): number | undefined {
  const stat = readProcStat(pid);
  return stat === undefined || stat.state === "Z" ? undefined : stat.startTicks;
}

/** Snapshot a live process's identity, or undefined if it is not running. */
export function readProcessIdentity(pid: number): ProcessIdentity | undefined {
  const startTicks = readProcessStartTicks(pid);
  return startTicks === undefined ? undefined : { pid, startTicks };
}

/**
 * Snapshot a process-group leader for cleanup, including a zombie leader whose
 * descendants may still be running in its group.
 */
export function readProcessGroupLeaderIdentity(
  pid: number,
): ProcessIdentity | undefined {
  const stat = readProcStat(pid);
  return stat === undefined || stat.pgrp !== pid
    ? undefined
    : { pid, startTicks: stat.startTicks };
}

/**
 * Confirm the PID still refers to the same process it did when the identity
 * was captured. Returns false if the process exited or the PID was reused.
 */
export function processIdentityMatches(identity: ProcessIdentity): boolean {
  const startTicks = readProcessStartTicks(identity.pid);
  return startTicks !== undefined && startTicks === identity.startTicks;
}

/**
 * Check whether any process in the given process group still exists, via a
 * `kill(2)` signal-0 probe. Unlike `listProcessGroupMembers`, this does not
 * read `/proc`, so it works on any POSIX platform (including Darwin) at the
 * cost of being a yes/no existence check rather than a member list. Useful to
 * confirm a group is empty when no `/proc`-backed `ProcessIdentity` for its
 * leader is available yet, such as during the brief window between spawning
 * an owned daemon and capturing its identity.
 */
export function isProcessGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** List the PIDs whose process group id equals `pgid`. */
export function listProcessGroupMembers(pgid: number): number[] {
  let entries: string[];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return [];
  }
  const members: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const stat = readProcStat(pid);
    if (stat !== undefined && stat.state !== "Z" && stat.pgrp === pgid) {
      members.push(pid);
    }
  }
  return members;
}

export type StopProcessGroupOutcome =
  | "already-dead"
  | "reused"
  | "terminated"
  | "survived";

export interface StopProcessGroupResult {
  outcome: StopProcessGroupOutcome;
  signaled: boolean;
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}

/**
 * Terminate a whole process group, identified by its group-leader identity,
 * with SIGTERM then SIGKILL escalation. Before the first signal, the recorded
 * process must still exist with its recorded start identity and lead the
 * recorded group. This remains verifiable while the leader is a zombie.
 * After that verified group receives SIGTERM, a missing leader does not make
 * its surviving same-pgid members unsafe: the pgid cannot be reused while they
 * remain, so SIGKILL escalation is valid. A reused live leader is still refused.
 *
 * The leader must have been spawned as a process-group leader (e.g. `spawn`
 * with `detached: true`), so its PID doubles as the group id.
 */
// eslint-disable-next-line complexity -- Legacy gate debt: pickforge/pickforge#60
export async function stopProcessGroupVerified(
  identity: ProcessIdentity,
  opts: { timeoutMs?: number } = {},
): Promise<StopProcessGroupResult> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const leader = readProcStat(identity.pid);
  if (leader === undefined) {
    return {
      outcome:
        listProcessGroupMembers(identity.pid).length === 0
          ? "already-dead"
          : "reused",
      signaled: false,
    };
  }
  if (
    leader.startTicks !== identity.startTicks ||
    leader.pgrp !== identity.pid
  ) {
    return { outcome: "reused", signaled: false };
  }

  signalGroup(identity.pid, "SIGTERM");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      listProcessGroupMembers(identity.pid).length === 0 &&
      !processIdentityMatches(identity)
    ) {
      return { outcome: "terminated", signaled: true };
    }
    await sleep(POLL_INTERVAL_MS);
  }

  const members = listProcessGroupMembers(identity.pid);
  const currentLeader = readProcStat(identity.pid);
  if (
    currentLeader !== undefined &&
    (currentLeader.startTicks !== identity.startTicks ||
      currentLeader.pgrp !== identity.pid)
  ) {
    return { outcome: "reused", signaled: true };
  }
  if (
    members.length === 0 &&
    (currentLeader === undefined || currentLeader.state === "Z")
  ) {
    return { outcome: "terminated", signaled: true };
  }
  signalGroup(identity.pid, "SIGKILL");
  const killDeadline = Date.now() + 1_000;
  while (Date.now() < killDeadline) {
    if (
      listProcessGroupMembers(identity.pid).length === 0 &&
      !processIdentityMatches(identity)
    ) {
      return { outcome: "terminated", signaled: true };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return {
    outcome:
      listProcessGroupMembers(identity.pid).length === 0 &&
      !processIdentityMatches(identity)
        ? "terminated"
        : "survived",
    signaled: true,
  };
}
