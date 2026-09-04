import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readPickforgeEnv } from "./env-compat.js";
import { readProcessStartTicks, type ProcessIdentity } from "./proc.js";

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
 *   of ownership, and it is always read back from the kernel rather than
 *   inferred from a successful write: the supervisor confirms its join through
 *   `/proc/self/cgroup`, and cleanup refuses any path that is not a
 *   `pickforge-*` directory on a cgroup v2 filesystem.
 * - `marker`: a 256-bit random token exported as `PICKFORGE_CONTAINMENT_TOKEN`.
 *   Descendants inherit the environment across `fork`, `setsid` and `exec`, so
 *   `/proc/<pid>/environ` identifies them. The token is unguessable, so a
 *   matching process is our descendant by construction. Every signal is gated
 *   on a re-read immediately before `kill(2)` of both the token and the start
 *   time recorded when the scan found the process: a PID that exited in
 *   between is treated as gone, a PID whose start time changed belongs to an
 *   unrelated process and is refused, never killed, and the same process
 *   whose token is momentarily unreadable (dying, mid-exec) is decided on a
 *   later pass.
 *
 * A lab command run from inside a contained shell (for example `session
 * destroy` typed into a `desktop exec xterm`) carries the token and, on a
 * cgroup host, is itself a member of the scope. Cleanup therefore excludes its
 * own process chain from every signal: on the marker path by skipping those
 * PIDs, on the cgroup path by moving the chain into the parent cgroup and
 * confirming from `cgroup.procs` that it is no longer a member before
 * `cgroup.kill` is written. If the chain cannot be moved out, cleanup refuses
 * with an actionable reason rather than terminating the caller.
 *
 * The marker sweep always runs, including after a cgroup kill, so cleanup is
 * confirmed by a mechanism that does not depend on the cgroup being intact.
 */

const TOKEN_ENV = "PICKFORGE_CONTAINMENT_TOKEN";
const CGROUP_ROOT = "/sys/fs/cgroup";
/** `CGROUP2_SUPER_MAGIC` from `<linux/magic.h>`. */
const CGROUP2_SUPER_MAGIC = 0x63677270;
const TOKEN_BYTES = 32;
const POLL_INTERVAL_MS = 25;
const DEFAULT_TERM_TIMEOUT_MS = 3_000;
const DEFAULT_KILL_TIMEOUT_MS = 2_000;
const CGROUP_RMDIR_ATTEMPTS = 20;
const SCOPE_PREFIX = "pickforge-";
const INSIDE_SCOPE_ADVICE =
  "Run the command from a shell outside the session, not from one started by `desktop exec`.";

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
  /**
   * PIDs skipped because they were still alive without this scope's token
   * (PID reuse). A PID that had simply exited is not listed here.
   */
  refused: number[];
  /** Human-readable reason when `confirmed` is false. */
  reason?: string;
}

export const CONTAINMENT_TOKEN_ENV = TOKEN_ENV;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function ownCgroupDir(): string | undefined {
  const own = readOwnCgroupPath();
  return own === undefined
    ? undefined
    : path.resolve(path.join(CGROUP_ROOT, own));
}

/**
 * Resolve the delegated cgroup directory we may create children in, or
 * undefined when this host gives us none (no cgroup v2, a root-owned cgroup,
 * a container without delegation, or a kernel without `cgroup.kill`).
 */
function findDelegatedCgroupDir(): string | undefined {
  const dir = ownCgroupDir();
  if (dir === undefined) return undefined;
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

/**
 * Why a recorded cgroup path may not be used as a containment scope, or
 * undefined when it has the shape of one: an absolute, normalised path under
 * the cgroup v2 mount whose last component carries the `pickforge-` prefix.
 * This keeps a tampered session record from pointing cleanup at the lab's own
 * delegated cgroup, or at any directory outside the cgroup filesystem.
 */
export function scopeCgroupProblem(cgroupDir: string): string | undefined {
  if (
    path.resolve(cgroupDir) !== cgroupDir ||
    !cgroupDir.startsWith(`${CGROUP_ROOT}/`)
  ) {
    return `${cgroupDir} is not a normalised absolute path under ${CGROUP_ROOT}`;
  }
  if (!path.basename(cgroupDir).startsWith(SCOPE_PREFIX)) {
    return `${cgroupDir} is not a ${SCOPE_PREFIX}* scope cgroup`;
  }
  return undefined;
}

/** Whether a directory really lives on a cgroup v2 filesystem. */
function isCgroup2Dir(dir: string): boolean {
  try {
    return fs.statfsSync(dir).type === CGROUP2_SUPER_MAGIC;
  } catch {
    return false;
  }
}

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
 * `PICKFORGE_CONTAINMENT=marker` forces the marker mechanism on a host that
 * would otherwise get a cgroup. It exists so the marker path (what CI runners
 * and containers without cgroup delegation get) can be exercised end to end on
 * a delegated host; it never claims more than the scope actually achieved.
 */
function markerForcedByEnvironment(): boolean {
  return readPickforgeEnv(process.env, "CONTAINMENT") === "marker";
}

/**
 * Create a containment scope. Never throws: a host without a delegated cgroup
 * degrades to the marker mechanism instead of failing session creation.
 */
export function createContainmentScope(
  opts: CreateContainmentScopeOptions,
): ContainmentScope {
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  if (opts.useCgroup === false || markerForcedByEnvironment()) {
    return { token, mechanism: "marker" };
  }
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
 *
 * Throws when the recorded path does not have the shape of a scope cgroup: a
 * launch must never join whatever directory a tampered record names.
 */
export function ensureContainmentScope(
  scope: ContainmentScope,
): ContainmentScope {
  if (scope.mechanism !== "cgroup" || scope.cgroupDir === undefined) {
    return scope;
  }
  const problem = scopeCgroupProblem(scope.cgroupDir);
  if (problem !== undefined) {
    throw new Error(
      `Refusing to launch into a containment scope that is not a Pickforge cgroup: ${problem}`,
    );
  }
  if (fs.existsSync(scope.cgroupDir)) return scope;
  const parent = path.dirname(scope.cgroupDir);
  const name = path.basename(scope.cgroupDir);
  const dir = tryCreateCgroup(parent, name);
  return dir === undefined ? scope : { ...scope, cgroupDir: dir };
}

/** The environment every contained process must carry. */
export function containmentEnv(
  scope: ContainmentScope,
): Record<string, string> {
  return { [TOKEN_ENV]: scope.token };
}

function readProcStatFields(pid: number): string[] | undefined {
  let content: string;
  try {
    content = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return undefined;
  }
  const close = content.lastIndexOf(")");
  if (close === -1) return undefined;
  // fields[0] is field 3 (state); field N maps to fields[N - 3].
  return content.slice(close + 1).trim().split(/\s+/);
}

type EnvironRead =
  | { kind: "entries"; entries: string[] }
  | { kind: "gone" }
  | { kind: "unreadable" };

function readEnviron(pid: number): EnvironRead {
  try {
    return {
      kind: "entries",
      entries: fs.readFileSync(`/proc/${pid}/environ`, "latin1").split("\0"),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ESRCH"
      ? { kind: "gone" }
      : { kind: "unreadable" };
  }
}

/** Whether a live process carries this scope's exact token entry. */
export function processCarriesToken(pid: number, token: string): boolean {
  const read = readEnviron(pid);
  return read.kind === "entries" && read.entries.includes(`${TOKEN_ENV}=${token}`);
}

type TokenProbe = "match" | "gone" | "mismatch" | "same-process";

/**
 * Re-verify, immediately before a signal, that `identity` (a PID and the
 * start time recorded when the scan found it carrying the token) is still the
 * process that was scanned and still carries the token.
 *
 * - `match`: the token is there. Signal it.
 * - `gone`: `/proc/<pid>` is missing or the process is a zombie. Skip.
 * - `mismatch`: the PID is alive with a *different* start time: the number
 *   was recycled by an unrelated process. Refused, never signalled.
 * - `same-process`: the same start time, but the token is not readable. A
 *   process that is dying reads like this for a moment (its address space is
 *   already released while it is still in state R, and the kernel then
 *   refuses the environ read with EACCES); so does one mid-`execve`, one
 *   that wiped its own environment, or one that exec'd a setuid image. It is
 *   the process the scan saw, so it is never refused; it is also not
 *   signalled on this pass. The sweep decides it later, by which time a dying
 *   process is gone and an exec'ing one carries the token again.
 */
function probeToken(identity: ProcessIdentity, token: string): TokenProbe {
  const read = readEnviron(identity.pid);
  if (read.kind === "gone") return "gone";
  const startTicks = readProcessStartTicks(identity.pid);
  if (startTicks === undefined) return "gone";
  if (startTicks !== identity.startTicks) return "mismatch";
  if (read.kind !== "entries") return "same-process";
  return read.entries.includes(`${TOKEN_ENV}=${token}`) ? "match" : "same-process";
}

function readParentPid(pid: number): number | undefined {
  const fields = readProcStatFields(pid);
  if (fields === undefined) return undefined;
  const ppid = Number(fields[4 - 3]);
  return Number.isFinite(ppid) ? ppid : undefined;
}

/**
 * Every live process carrying this scope's token, excluding the caller's own
 * process chain, each with the start time that pins its identity for the
 * pre-signal re-check. A process that exits between the environ read and the
 * start-time read is not listed.
 */
function listContainedIdentities(token: string): ProcessIdentity[] {
  const excluded = selfAndAncestors();
  const found: ProcessIdentity[] = [];
  for (const pid of listProcPids()) {
    if (excluded.has(pid)) continue;
    if (!processCarriesToken(pid, token)) continue;
    const startTicks = readProcessStartTicks(pid);
    if (startTicks !== undefined) found.push({ pid, startTicks });
  }
  return found;
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

/** Members of a cgroup, or undefined when the list cannot be read at all. */
function readCgroupProcs(cgroupDir: string): number[] | undefined {
  try {
    return fs
      .readFileSync(path.join(cgroupDir, "cgroup.procs"), "utf8")
      .split("\n")
      .filter((line) => /^\d+$/.test(line))
      .map(Number);
  } catch {
    return undefined;
  }
}

function isInsideCgroup(cgroupDir: string): boolean {
  const own = ownCgroupDir();
  return (
    own !== undefined && (own === cgroupDir || own.startsWith(`${cgroupDir}/`))
  );
}

/** PIDs of this process's own chain that are members of the scope cgroup. */
function ownChainInside(cgroupDir: string, members: number[]): number[] {
  const chain = selfAndAncestors();
  const inside = new Set(members.filter((pid) => chain.has(pid)));
  if (isInsideCgroup(cgroupDir)) inside.add(process.pid);
  return [...inside];
}

/**
 * Move this process's own chain out of the scope cgroup into its parent, and
 * confirm from the kernel that none of it is still a member. Returns the
 * reason cleanup must refuse when that cannot be established.
 */
function evacuateOwnChain(cgroupDir: string, pids: number[]): string | undefined {
  const parentProcs = path.join(path.dirname(cgroupDir), "cgroup.procs");
  for (const pid of pids) {
    try {
      fs.writeFileSync(parentProcs, String(pid));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") continue;
      return (
        `this command is running inside the session's containment cgroup ` +
        `(pid ${pid}) and could not be moved out: ${errorMessage(error)}. ` +
        INSIDE_SCOPE_ADVICE
      );
    }
  }
  const remaining = readCgroupProcs(cgroupDir);
  const chain = selfAndAncestors();
  const still =
    remaining === undefined ? pids : remaining.filter((pid) => chain.has(pid));
  if (still.length > 0 || isInsideCgroup(cgroupDir)) {
    return (
      `this command is still a member of the session's containment cgroup ` +
      `(pid(s) ${still.join(", ") || process.pid}) after moving out; ` +
      `refusing to write cgroup.kill. ${INSIDE_SCOPE_ADVICE}`
    );
  }
  return undefined;
}

/**
 * Everything that must hold before `cgroup.kill` may be written: the path is
 * a real cgroup, its member list is readable, and none of this process's own
 * chain is (any longer) a member.
 */
function guardCgroupKill(cgroupDir: string): string | undefined {
  if (!isCgroup2Dir(cgroupDir)) {
    return `refusing cgroup cleanup: ${cgroupDir} is not on a cgroup v2 filesystem`;
  }
  const members = readCgroupProcs(cgroupDir);
  if (members === undefined) {
    return `could not read ${cgroupDir}/cgroup.procs`;
  }
  const inside = ownChainInside(cgroupDir, members);
  return inside.length === 0 ? undefined : evacuateOwnChain(cgroupDir, inside);
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
    const members = readCgroupProcs(cgroupDir);
    if (members === undefined ? !fs.existsSync(cgroupDir) : members.length === 0) {
      return true;
    }
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

type SignalOutcome = "signaled" | "refused" | "skipped";

/**
 * Signal one contained process, re-verifying immediately before the signal
 * that the PID is still the scanned process and still carries the token. A
 * process that exited since the scan is skipped; a PID now owned by a
 * different process is refused, never killed; the same process without a
 * readable token (dying or mid-exec) is skipped and decided on a later pass.
 */
function signalContained(
  identity: ProcessIdentity,
  token: string,
  signal: NodeJS.Signals,
  state: SweepState,
): SignalOutcome {
  const probe = probeToken(identity, token);
  if (probe === "gone" || probe === "same-process") return "skipped";
  if (probe === "mismatch") {
    state.refused.add(identity.pid);
    return "refused";
  }
  try {
    process.kill(identity.pid, signal);
    state.signaled.add(identity.pid);
    return "signaled";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return "skipped";
    state.refused.add(identity.pid);
    return "refused";
  }
}

/**
 * Signal every contained process once, then wait for the scope to empty. New
 * PIDs that appear while waiting (a descendant forked mid-shutdown) are
 * signalled too, but an already-signalled PID is not signalled again, so a
 * graceful SIGTERM handler is not interrupted by a second SIGTERM. A process
 * that could not be decided on one pass is decided on a later one.
 */
async function sweepUntilEmpty(
  token: string,
  signal: NodeJS.Signals,
  timeoutMs: number,
  state: SweepState,
): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  const settledThisPass = new Set<number>();
  let emptyScans = 0;
  for (;;) {
    const remaining = listContainedIdentities(token);
    // A process mid-exec is invisible to one scan; only two consecutive empty
    // scans, a poll apart, mean the scope is empty.
    if (remaining.length === 0) {
      emptyScans += 1;
      if (emptyScans >= 2) return [];
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    emptyScans = 0;
    for (const identity of remaining) {
      if (settledThisPass.has(identity.pid)) continue;
      if (signalContained(identity, token, signal, state) !== "skipped") {
        settledThisPass.add(identity.pid);
      }
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
  const problem = scopeCgroupProblem(cgroupDir);
  if (problem !== undefined) return `refusing cgroup cleanup: ${problem}`;
  if (!fs.existsSync(cgroupDir)) return undefined;
  const blocked = guardCgroupKill(cgroupDir);
  if (blocked !== undefined) return blocked;
  if (!killCgroup(cgroupDir)) return `could not write ${cgroupDir}/cgroup.kill`;
  if (!(await waitForCgroupEmpty(cgroupDir, timeoutMs))) {
    return `cgroup ${cgroupDir} still has members after cgroup.kill`;
  }
  if (!(await removeCgroupDir(cgroupDir))) {
    return `could not remove empty cgroup ${cgroupDir}`;
  }
  return undefined;
}

function unconfirmed(
  mechanism: ContainmentMechanism,
  reason: string,
): ContainmentCleanupResult {
  return {
    mechanism,
    confirmed: false,
    signaled: [],
    survivors: [],
    refused: [],
    reason,
  };
}

/**
 * Terminate every process in a containment scope and confirm the scope is
 * empty. Cleanup is confirmed only when no process carrying the token remains
 * and no live PID had to be refused for an identity mismatch. The process
 * performing the cleanup and its ancestors are never signalled.
 */
export async function destroyContainmentScope(
  scope: ContainmentScope,
  opts: DestroyContainmentOptions = {},
): Promise<ContainmentCleanupResult> {
  if (process.platform !== "linux") {
    return unconfirmed(
      scope.mechanism,
      `containment cleanup needs Linux /proc; cannot confirm on ${process.platform}`,
    );
  }
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
        ? `refused to signal ${state.refused.size} live PID(s) that no longer carry the session token: ${[...state.refused].join(", ")}`
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
const CGROUP_ROOT = "/sys/fs/cgroup";
const [cgroupDir, binary, ...args] = process.argv.slice(1);
if (!binary) process.exit(127);

function fail(message) {
  console.error("pickforge: " + message);
  process.exit(126);
}

function ownCgroupPath() {
  let content;
  try {
    content = fs.readFileSync("/proc/self/cgroup", "utf8");
  } catch {
    return undefined;
  }
  for (const line of content.split("\n")) {
    if (line.startsWith("0::")) return line.slice(3);
  }
  return undefined;
}

if (cgroupDir !== "-") {
  // Join before spawning anything, retrying through the narrow window where a
  // concurrent session create may have pruned this (still empty) cgroup: the
  // directory is re-created rather than treated as a lost scope. Failing to
  // join is fatal by design — a silently uncontained app is the bug this
  // supervisor exists to prevent. A successful write proves nothing on its
  // own (a regular file accepts it too), so membership is read back from the
  // kernel before anything is spawned; a path outside the cgroup filesystem
  // can never pass that check.
  const expected = cgroupDir.startsWith(CGROUP_ROOT + "/")
    ? cgroupDir.slice(CGROUP_ROOT.length)
    : undefined;
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
    } catch (error) {
      lastError = error.message;
      continue;
    }
    const actual = ownCgroupPath();
    joined = expected !== undefined && actual === expected;
    if (!joined) {
      lastError =
        "membership was not reflected in /proc/self/cgroup (now in " +
        (actual === undefined ? "<unreadable>" : actual) +
        ")";
    }
  }
  if (!joined) {
    fail("could not join containment cgroup " + cgroupDir + ": " + lastError);
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
// A termination signal is forwarded to the app rather than ending this
// supervisor: it stays alive while the app or any same-group descendant lives,
// so the caller's process-group liveness check tracks the app rather than this
// process, and it exits within one poll of the app going away instead of
// making a sweep wait out its whole SIGTERM budget.
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    if (childExited) return;
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  });
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
  let cgroupDir = "-";
  if (scope.mechanism === "cgroup" && scope.cgroupDir !== undefined) {
    const problem = scopeCgroupProblem(scope.cgroupDir);
    if (problem !== undefined) {
      throw new Error(
        `Containment supervisor refuses a scope that is not a Pickforge cgroup: ${problem}`,
      );
    }
    cgroupDir = scope.cgroupDir;
  }
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
