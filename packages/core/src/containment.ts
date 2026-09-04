import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Containment for apps launched into a lab session.
 *
 * A process group alone does not contain a GUI app: a double `fork()` or a
 * `setsid()` moves a descendant out of the group, and the group signal then
 * misses it. Two mechanisms are used here, both unprivileged (no sudo, which
 * MCP may never call):
 *
 * - `cgroup`: a private cgroup v2 directory created inside the *delegated*
 *   cgroup this process already lives in. A process cannot leave a cgroup
 *   without privileges, so `fork`/`setsid` descendants stay members, and
 *   `cgroup.kill` terminates every member atomically. Membership is the proof
 *   of ownership: nothing that is not our descendant is ever in the directory
 *   we created, so a kill cannot reach an unrelated process.
 * - `marker`: a 256-bit random token exported as `PICKFORGE_CONTAINMENT_TOKEN`.
 *   Descendants inherit the environment across `fork`, `setsid` and `exec`, so
 *   `/proc/<pid>/environ` identifies them. The token is unguessable, so a
 *   matching process is our descendant by construction. Signals are still gated
 *   on a re-read of the token and on the recorded `ProcessIdentity`, so a
 *   recycled PID is refused rather than killed.
 *
 * The marker sweep always runs, including after a cgroup kill, so cleanup is
 * confirmed by a mechanism that does not depend on the cgroup being intact.
 */

const TOKEN_ENV = "PICKFORGE_CONTAINMENT_TOKEN";
const CGROUP_ROOT = "/sys/fs/cgroup";
const TOKEN_BYTES = 32;
const POLL_INTERVAL_MS = 25;
const DEFAULT_TERM_TIMEOUT_MS = 3_000;
const DEFAULT_KILL_TIMEOUT_MS = 2_000;
const CGROUP_RMDIR_ATTEMPTS = 20;

export type ContainmentMechanism = "cgroup" | "marker";

export interface ContainmentScope {
  /** Random per-session token exported to every contained process. */
  token: string;
  /** Strongest mechanism available on this host. */
  mechanism: ContainmentMechanism;
  /** Absolute cgroup v2 directory, only when `mechanism` is `cgroup`. */
  cgroupDir?: string;
}

export interface ContainmentCleanupResult {
  mechanism: ContainmentMechanism;
  /** True only when no contained process remains and no PID was left unsafe. */
  confirmed: boolean;
  /** PIDs this cleanup signalled. */
  signaled: number[];
  /** Contained PIDs still alive when the deadline passed. */
  survivors: number[];
  /** PIDs skipped because their identity no longer matched (PID reuse). */
  refused: number[];
  /** Human-readable reason when `confirmed` is false. */
  reason?: string;
}

export const CONTAINMENT_TOKEN_ENV = TOKEN_ENV;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The current process's cgroup v2 path, e.g. `/user.slice/....scope`. */
export function readOwnCgroupPath(): string | undefined {
  let content: string;
  try {
    content = fs.readFileSync("/proc/self/cgroup", "utf8");
  } catch {
    return undefined;
  }
  for (const line of content.split("\n")) {
    if (!line.startsWith("0::")) continue;
    const value = line.slice(3);
    if (value.startsWith("/") && !value.includes("\0")) return value;
  }
  return undefined;
}

/**
 * Resolve the delegated cgroup directory we may create children in, or
 * undefined when this host gives us none (no cgroup v2, a root-owned cgroup,
 * a container without delegation, or a kernel without `cgroup.kill`).
 */
function findDelegatedCgroupDir(): string | undefined {
  const own = readOwnCgroupPath();
  if (own === undefined) return undefined;
  const dir = path.resolve(path.join(CGROUP_ROOT, own));
  if (dir !== CGROUP_ROOT && !dir.startsWith(`${CGROUP_ROOT}/`)) return undefined;
  try {
    fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK);
    fs.accessSync(path.join(dir, "cgroup.procs"), fs.constants.F_OK);
  } catch {
    return undefined;
  }
  return dir;
}

function tryCreateCgroup(parent: string, name: string): string | undefined {
  const dir = path.join(parent, name);
  try {
    fs.mkdirSync(dir);
  } catch {
    return undefined;
  }
  try {
    // `cgroup.kill` (Linux 5.14+) is what makes cleanup atomic and confirmable.
    // Without it a fork bomb inside the cgroup could outrun a PID-by-PID kill,
    // so fall back to the marker sweep rather than pretend to contain.
    fs.accessSync(path.join(dir, "cgroup.kill"), fs.constants.W_OK);
    return dir;
  } catch {
    try {
      fs.rmdirSync(dir);
    } catch {
      // leave the empty cgroup behind rather than fail the session
    }
    return undefined;
  }
}

const SCOPE_PREFIX = "pickforge-";

/**
 * Remove empty leftover scope cgroups beside the one we are about to create.
 * A lab process killed with `SIGKILL` cannot run its own cleanup, so its
 * (already vacated) cgroup directory would otherwise accumulate. `rmdir` fails
 * with EBUSY while a cgroup still has members, so a live session's scope is
 * never removed by this.
 */
function pruneEmptyScopeCgroups(parent: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(parent);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(SCOPE_PREFIX)) continue;
    try {
      fs.rmdirSync(path.join(parent, entry));
    } catch {
      // still in use, or not ours to remove
    }
  }
}

export interface CreateContainmentScopeOptions {
  /** Stable name fragment, normally the session id. */
  id: string;
  /** Set false to force the marker mechanism (used by tests). */
  useCgroup?: boolean;
}

/**
 * Create a containment scope. Never throws: a host without a delegated cgroup
 * degrades to the marker mechanism instead of failing session creation.
 */
export function createContainmentScope(
  opts: CreateContainmentScopeOptions,
): ContainmentScope {
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  if (opts.useCgroup === false) return { token, mechanism: "marker" };
  const parent = findDelegatedCgroupDir();
  if (parent === undefined) return { token, mechanism: "marker" };
  pruneEmptyScopeCgroups(parent);
  const dir = tryCreateCgroup(parent, `${SCOPE_PREFIX}${opts.id}`);
  if (dir === undefined) return { token, mechanism: "marker" };
  return { token, mechanism: "cgroup", cgroupDir: dir };
}

/**
 * Re-create a scope's cgroup directory if it is missing, and report the scope
 * to use. An *empty* scope cgroup is indistinguishable from an abandoned one,
 * so the create-time prune above can remove the directory of a live session
 * that has not launched anything yet; re-creating it on demand makes that
 * harmless. The token is unchanged, so the marker sweep still covers anything
 * started before or after.
 */
export function ensureContainmentScope(
  scope: ContainmentScope,
): ContainmentScope {
  if (scope.mechanism !== "cgroup" || scope.cgroupDir === undefined) {
    return scope;
  }
  if (fs.existsSync(scope.cgroupDir)) return scope;
  const parent = path.dirname(scope.cgroupDir);
  const name = path.basename(scope.cgroupDir);
  if (!name.startsWith(SCOPE_PREFIX)) return scope;
  const dir = tryCreateCgroup(parent, name);
  return dir === undefined ? scope : { ...scope, cgroupDir: dir };
}

/** The environment every contained process must carry. */
export function containmentEnv(
  scope: ContainmentScope,
): Record<string, string> {
  return { [TOKEN_ENV]: scope.token };
}

/**
 * Read a process's environment as NUL-separated entries. Returns undefined when
 * the process is gone or belongs to another user (whose processes can never be
 * ours: nothing here changes uid).
 */
function readProcEnviron(pid: number): string[] | undefined {
  try {
    return fs.readFileSync(`/proc/${pid}/environ`, "latin1").split("\0");
  } catch {
    return undefined;
  }
}

/** Whether a live process carries this scope's exact token entry. */
export function processCarriesToken(pid: number, token: string): boolean {
  const entries = readProcEnviron(pid);
  return entries !== undefined && entries.includes(`${TOKEN_ENV}=${token}`);
}

function readParentPid(pid: number): number | undefined {
  let content: string;
  try {
    content = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return undefined;
  }
  const close = content.lastIndexOf(")");
  if (close === -1) return undefined;
  const fields = content.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(fields[4 - 3]);
  return Number.isFinite(ppid) ? ppid : undefined;
}

/**
 * This process and its ancestors. A lab CLI invoked from inside a contained
 * shell would inherit the token; excluding the caller's own chain keeps a
 * cleanup from killing the process performing it.
 */
function selfAndAncestors(): Set<number> {
  const chain = new Set<number>([process.pid]);
  let current: number | undefined = process.pid;
  while (current !== undefined && current > 1 && chain.size < 64) {
    const parent: number | undefined = readParentPid(current);
    if (parent === undefined || parent <= 1 || chain.has(parent)) break;
    chain.add(parent);
    current = parent;
  }
  return chain;
}

function listProcPids(): number[] {
  let entries: string[];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return [];
  }
  return entries.filter((entry) => /^\d+$/.test(entry)).map(Number);
}

/**
 * Every live process carrying this scope's token, excluding the caller's own
 * process chain. This is the authoritative "is the scope empty?" answer for
 * both mechanisms.
 */
export function listContainedProcesses(token: string): number[] {
  const excluded = selfAndAncestors();
  const found: number[] = [];
  for (const pid of listProcPids()) {
    if (excluded.has(pid)) continue;
    if (processCarriesToken(pid, token)) found.push(pid);
  }
  return found;
}

function readCgroupProcs(cgroupDir: string): number[] {
  try {
    return fs
      .readFileSync(path.join(cgroupDir, "cgroup.procs"), "utf8")
      .split("\n")
      .filter((line) => /^\d+$/.test(line))
      .map(Number);
  } catch {
    return [];
  }
}

function killCgroup(cgroupDir: string): boolean {
  try {
    fs.writeFileSync(path.join(cgroupDir, "cgroup.kill"), "1");
    return true;
  } catch {
    return false;
  }
}

async function waitForCgroupEmpty(
  cgroupDir: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (readCgroupProcs(cgroupDir).length === 0) return true;
    if (Date.now() >= deadline) return false;
    await sleep(POLL_INTERVAL_MS);
  }
}

async function removeCgroupDir(cgroupDir: string): Promise<boolean> {
  for (let attempt = 0; attempt < CGROUP_RMDIR_ATTEMPTS; attempt += 1) {
    try {
      fs.rmdirSync(cgroupDir);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      await sleep(POLL_INTERVAL_MS);
    }
  }
  return false;
}

interface SweepState {
  signaled: Set<number>;
  refused: Set<number>;
}

/**
 * Signal one contained PID, re-verifying immediately before the signal that it
 * still carries the token. A PID that no longer matches is refused, never
 * killed: after a PID recycle the number belongs to an unrelated process.
 */
function signalContained(
  pid: number,
  token: string,
  signal: NodeJS.Signals,
  state: SweepState,
): void {
  if (!processCarriesToken(pid, token)) {
    state.refused.add(pid);
    return;
  }
  try {
    process.kill(pid, signal);
    state.signaled.add(pid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      state.refused.add(pid);
    }
  }
}

/**
 * Signal every contained process once, then wait for the scope to empty. New
 * PIDs that appear while waiting (a descendant forked mid-shutdown) are
 * signalled too, but an already-signalled PID is not signalled again, so a
 * graceful SIGTERM handler is not interrupted by a second SIGTERM.
 */
async function sweepUntilEmpty(
  token: string,
  signal: NodeJS.Signals,
  timeoutMs: number,
  state: SweepState,
): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  const sentThisPass = new Set<number>();
  for (;;) {
    const remaining = listContainedProcesses(token);
    if (remaining.length === 0) return [];
    for (const pid of remaining) {
      if (sentThisPass.has(pid)) continue;
      sentThisPass.add(pid);
      signalContained(pid, token, signal, state);
    }
    if (Date.now() >= deadline) return listContainedProcesses(token);
    await sleep(POLL_INTERVAL_MS);
  }
}

export interface DestroyContainmentOptions {
  termTimeoutMs?: number;
  killTimeoutMs?: number;
}

async function destroyCgroupMembers(
  scope: ContainmentScope,
  timeoutMs: number,
): Promise<string | undefined> {
  const cgroupDir = scope.cgroupDir;
  if (cgroupDir === undefined) return "containment cgroup path is missing";
  if (!fs.existsSync(cgroupDir)) return undefined;
  if (!killCgroup(cgroupDir)) return `could not write ${cgroupDir}/cgroup.kill`;
  if (!(await waitForCgroupEmpty(cgroupDir, timeoutMs))) {
    return `cgroup ${cgroupDir} still has members after cgroup.kill`;
  }
  if (!(await removeCgroupDir(cgroupDir))) {
    return `could not remove empty cgroup ${cgroupDir}`;
  }
  return undefined;
}

/**
 * Terminate every process in a containment scope and confirm the scope is
 * empty. Cleanup is confirmed only when no process carrying the token remains
 * and no PID had to be refused for an identity mismatch.
 */
export async function destroyContainmentScope(
  scope: ContainmentScope,
  opts: DestroyContainmentOptions = {},
): Promise<ContainmentCleanupResult> {
  const termTimeoutMs = opts.termTimeoutMs ?? DEFAULT_TERM_TIMEOUT_MS;
  const killTimeoutMs = opts.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS;
  const state: SweepState = { signaled: new Set(), refused: new Set() };
  const cgroupReason =
    scope.mechanism === "cgroup"
      ? await destroyCgroupMembers(scope, termTimeoutMs)
      : undefined;

  let survivors = await sweepUntilEmpty(
    scope.token,
    "SIGTERM",
    termTimeoutMs,
    state,
  );
  if (survivors.length > 0) {
    survivors = await sweepUntilEmpty(
      scope.token,
      "SIGKILL",
      killTimeoutMs,
      state,
    );
  }

  const reason =
    survivors.length > 0
      ? `${survivors.length} contained process(es) survived SIGKILL: ${survivors.join(", ")}`
      : state.refused.size > 0
        ? `refused to signal ${state.refused.size} PID(s) whose identity no longer matched`
        : cgroupReason;
  return {
    mechanism: scope.mechanism,
    confirmed: reason === undefined,
    signaled: [...state.signaled],
    survivors,
    refused: [...state.refused],
    ...(reason === undefined ? {} : { reason }),
  };
}

const SUPERVISOR_SCRIPT = String.raw`
import * as fs from "node:fs";
import { spawn } from "node:child_process";
const [cgroupDir, binary, ...args] = process.argv.slice(1);
if (!binary) process.exit(127);
if (cgroupDir !== "-") {
  // Join before spawning anything, retrying through the narrow window where a
  // concurrent session create may have pruned this (still empty) cgroup: the
  // directory is re-created rather than treated as a lost scope. Failing to
  // join is fatal by design — a silently uncontained app is the bug this
  // supervisor exists to prevent.
  let joined = false;
  let lastError = "unknown error";
  for (let attempt = 0; attempt < 3 && !joined; attempt += 1) {
    try {
      fs.mkdirSync(cgroupDir);
    } catch (error) {
      if (error.code !== "EEXIST") lastError = error.message;
    }
    try {
      fs.writeFileSync(cgroupDir + "/cgroup.procs", String(process.pid));
      joined = true;
    } catch (error) {
      lastError = error.message;
    }
  }
  if (!joined) {
    console.error("pickforge: could not join containment cgroup:", lastError);
    process.exit(126);
  }
}

function hasLiveGroupMembers() {
  let entries;
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    let content;
    try {
      content = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    } catch {
      continue;
    }
    const close = content.lastIndexOf(")");
    if (close === -1) continue;
    const fields = content.slice(close + 1).trim().split(/\s+/);
    if (fields[0] !== "Z" && Number(fields[2]) === process.pid) return true;
  }
  return false;
}

let childExited = false;
let childCode = 1;
const child = spawn(binary, args, {
  env: process.env,
  shell: false,
  stdio: ["ignore", "inherit", "inherit"],
});
child.once("error", (error) => {
  console.error("pickforge: failed to launch " + binary + ":", error.message);
  childExited = true;
  childCode = 127;
});
child.once("exit", (code) => {
  childExited = true;
  childCode = code == null ? 1 : code;
});
// Stay alive while the app or any same-group descendant lives, so the caller's
// process-group liveness check tracks the app rather than this supervisor.
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {});
}
const timer = setInterval(() => {
  if (childExited && !hasLiveGroupMembers()) {
    clearInterval(timer);
    process.exit(childCode);
  }
}, 50);
`;

export interface ContainedCommand {
  command: string;
  args: string[];
}

/**
 * Wrap a command so it starts *inside* the containment scope. The supervisor
 * joins the cgroup before spawning the app, which closes the window a
 * "spawn, then migrate the PID" approach leaves open: a child forked in that
 * window would never have been a cgroup member.
 */
export function buildContainedCommand(
  nodePath: string,
  scope: ContainmentScope,
  command: string,
  args: readonly string[],
): ContainedCommand {
  if (nodePath === "") {
    throw new Error("Containment supervisor requires a Node.js executable path");
  }
  if (command === "") {
    throw new Error("Containment supervisor requires a command to run");
  }
  const cgroupDir =
    scope.mechanism === "cgroup" && scope.cgroupDir !== undefined
      ? scope.cgroupDir
      : "-";
  return {
    command: nodePath,
    args: [
      "--input-type=module",
      "-e",
      SUPERVISOR_SCRIPT,
      cgroupDir,
      command,
      ...args,
    ],
  };
}
