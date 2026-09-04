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
 *   `/proc/self/cgroup`. A scope directory is bound to exactly one session —
 *   it must be named `pickforge-<session id>` on a cgroup v2 filesystem, so a
 *   record naming a *sibling* session's valid-looking scope is refused — and
 *   immediately before `cgroup.kill` every remaining member must be shown to
 *   carry this session's token (or descend from a process that does).
 * - `marker`: a 256-bit random token exported as `PICKFORGE_CONTAINMENT_TOKEN`.
 *   Descendants inherit the environment across `fork`, `setsid` and `exec`, so
 *   `/proc/<pid>/environ` identifies them. The token is unguessable, so a
 *   matching process is our descendant by construction. Every signal is gated
 *   on a re-read immediately before `kill(2)` of both the token and the start
 *   time recorded when the scan found the process: a PID that exited in
 *   between is treated as gone, a PID whose start time changed belongs to an
 *   unrelated process and is refused, never killed, and the same process
 *   whose token is unreadable (dying, mid-exec) is decided on a later pass.
 *   Ownership, once a scan has established it, is kept until the process is
 *   seen to be gone: a scope with an identity that never becomes readable
 *   again fails cleanup instead of being reported empty.
 *
 * A lab command run from inside a contained shell (for example `session
 * destroy` typed into a `desktop exec xterm`) carries the token and, on a
 * cgroup host, is itself a member of the scope. Cleanup therefore excludes its
 * own process chain from every signal: on the marker path by skipping those
 * PIDs, on the cgroup path by moving the chain into the parent cgroup and
 * confirming from `cgroup.procs` that it is no longer a member before
 * `cgroup.kill` is written. If the chain cannot be moved out, cleanup refuses
 * with an actionable reason rather than terminating the caller. The chain is
 * pinned by start time on both paths, so an ancestor that exits mid-cleanup
 * neither exempts nor donates its pid to an unrelated process.
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
/**
 * Session ids that may become a cgroup directory name: no separators, no
 * `..`, nothing the kernel or `path.basename` would read as another path.
 */
const SCOPE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** How long a member whose ownership cannot yet be read may stay undecided. */
const MEMBER_VERIFY_TIMEOUT_MS = 1_000;
const INSIDE_SCOPE_ADVICE =
  "Run the command from a shell outside the session, not from one started by `desktop exec`.";

export type ContainmentMechanism = "cgroup" | "marker";

export interface ContainmentScope {
  /**
   * The session this scope belongs to. `cgroupDir` is bound to it: a scope may
   * only ever act on the directory named `pickforge-<id>`.
   */
  id: string;
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

/** The cgroup v2 path in a `/proc/<pid>/cgroup` file, e.g. `/user.slice/x`. */
function readCgroupPathOf(procFile: string): string | undefined {
  let content: string;
  try {
    content = fs.readFileSync(procFile, "utf8");
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

/** The current process's cgroup v2 path, e.g. `/user.slice/....scope`. */
export function readOwnCgroupPath(): string | undefined {
  return readCgroupPathOf("/proc/self/cgroup");
}

function cgroupDirOf(procFile: string): string | undefined {
  const relative = readCgroupPathOf(procFile);
  return relative === undefined
    ? undefined
    : path.resolve(path.join(CGROUP_ROOT, relative));
}

function ownCgroupDir(): string | undefined {
  return cgroupDirOf("/proc/self/cgroup");
}

/** The cgroup v2 directory another process is currently a member of. */
function processCgroupDir(pid: number): string | undefined {
  return cgroupDirOf(`/proc/${pid}/cgroup`);
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
 * Why a recorded cgroup path may not be used as session `id`'s containment
 * scope, or undefined when it is exactly that session's scope: an absolute,
 * normalised path under the cgroup v2 mount, named `pickforge-<id>`, directly
 * inside a parent that is not itself a scope.
 *
 * The name is what binds a directory to one session. Checking only for a
 * `pickforge-*` prefix would accept any *other* live session's scope, so a
 * tampered record could aim one session's cleanup at a sibling's processes;
 * requiring the exact name means a record can only ever act on its own scope,
 * the lab's own delegated cgroup and every directory outside the cgroup
 * filesystem stay unreachable, and a scope nested inside another scope (which
 * `cgroup.kill` would reach through its parent anyway) is refused.
 */
export function scopeCgroupProblem(
  cgroupDir: string,
  id: string,
): string | undefined {
  if (!SCOPE_ID_PATTERN.test(id)) {
    return `${JSON.stringify(id)} is not a usable containment scope id`;
  }
  if (
    path.resolve(cgroupDir) !== cgroupDir ||
    !cgroupDir.startsWith(`${CGROUP_ROOT}/`)
  ) {
    return `${cgroupDir} is not a normalised absolute path under ${CGROUP_ROOT}`;
  }
  const expected = `${SCOPE_PREFIX}${id}`;
  if (path.basename(cgroupDir) !== expected) {
    return `${cgroupDir} is not session ${id}'s scope cgroup (expected a directory named ${expected})`;
  }
  if (path.basename(path.dirname(cgroupDir)).startsWith(SCOPE_PREFIX)) {
    return `${cgroupDir} is nested inside another ${SCOPE_PREFIX}* scope cgroup`;
  }
  return undefined;
}

/**
 * Why a scope may not be used at all: a `cgroup` scope must carry a path bound
 * to its own session. A `cgroup` mechanism with no path is malformed, never a
 * silent degrade to "no containment": callers would keep reporting `cgroup`
 * while nothing joined a cgroup at all.
 */
export function containmentScopeProblem(
  scope: ContainmentScope,
): string | undefined {
  if (scope.mechanism !== "cgroup") return undefined;
  if (scope.cgroupDir === undefined) {
    return `containment scope for ${scope.id} claims the cgroup mechanism without a cgroup path`;
  }
  return scopeCgroupProblem(scope.cgroupDir, scope.id);
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
  const marker: ContainmentScope = { id: opts.id, token, mechanism: "marker" };
  if (opts.useCgroup === false || markerForcedByEnvironment()) return marker;
  if (!SCOPE_ID_PATTERN.test(opts.id)) return marker;
  const parent = findDelegatedCgroupDir();
  if (parent === undefined) return marker;
  pruneEmptyScopeCgroups(parent);
  const dir = tryCreateCgroup(parent, `${SCOPE_PREFIX}${opts.id}`);
  if (dir === undefined) return marker;
  const scope: ContainmentScope = { ...marker, mechanism: "cgroup", cgroupDir: dir };
  // A cgroup we cannot later prove is this session's own is worse than none:
  // degrade to the marker mechanism instead of recording a scope that every
  // launch and cleanup would refuse.
  return containmentScopeProblem(scope) === undefined ? scope : marker;
}

/**
 * Re-create a scope's cgroup directory if it is missing, and report the scope
 * to use. An *empty* scope cgroup is indistinguishable from an abandoned one,
 * so the create-time prune above can remove the directory of a live session
 * that has not launched anything yet; re-creating it on demand makes that
 * harmless. The token is unchanged, so the marker sweep still covers anything
 * started before or after.
 *
 * Throws when the recorded scope is not this session's own scope cgroup: a
 * launch must never join whatever directory a tampered record names, nor
 * silently start uncontained while still reporting the cgroup mechanism.
 */
export function ensureContainmentScope(
  scope: ContainmentScope,
): ContainmentScope {
  if (scope.mechanism !== "cgroup") return scope;
  const problem = containmentScopeProblem(scope);
  if (problem !== undefined) {
    throw new Error(
      `Refusing to launch into a containment scope that is not this session's Pickforge cgroup: ${problem}`,
    );
  }
  if (scope.cgroupDir === undefined || fs.existsSync(scope.cgroupDir)) {
    return scope;
  }
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

/** A live process's parent and start time from a single `stat` read. */
function readParentAndStart(
  pid: number,
): { ppid: number; startTicks: number } | undefined {
  const fields = readProcStatFields(pid);
  if (fields === undefined || fields[0] === "Z") return undefined;
  const ppid = Number(fields[4 - 3]);
  const startTicks = Number(fields[22 - 3]);
  return Number.isFinite(ppid) && Number.isFinite(startTicks)
    ? { ppid, startTicks }
    : undefined;
}

/**
 * Every live process carrying this scope's token, excluding the caller's own
 * process chain, each with the start time that pins its identity for the
 * pre-signal re-check. A process that exits between the environ read and the
 * start-time read is not listed.
 */
function listContainedIdentities(token: string): ProcessIdentity[] {
  const excluded = selfAndAncestorIdentities();
  const found: ProcessIdentity[] = [];
  for (const pid of listProcPids()) {
    if (!processCarriesToken(pid, token)) continue;
    const startTicks = readProcessStartTicks(pid);
    if (startTicks === undefined) continue;
    if (excluded.get(pid) === startTicks) continue;
    found.push({ pid, startTicks });
  }
  return found;
}

/**
 * This process and its ancestors, each pinned to the start time it has right
 * now. A lab CLI invoked from inside a contained shell would inherit the
 * token; excluding the caller's own chain keeps a cleanup from killing the
 * process performing it. The exclusion is by identity, not by bare pid: an
 * ancestor that exits during a sweep must not lend its number to a contained
 * process that the kernel later assigns it to, in either direction — such a
 * process is signalled like any other, and a chain member is only ever
 * exempted (or migrated out of a cgroup) while its start time still matches.
 */
function selfAndAncestorIdentities(): Map<number, number> {
  const chain = new Map<number, number>();
  let current: number | undefined = process.pid;
  while (current !== undefined && current > 1 && chain.size < 64) {
    const stat = readParentAndStart(current);
    if (stat === undefined) break;
    chain.set(current, stat.startTicks);
    if (stat.ppid <= 1 || chain.has(stat.ppid)) break;
    current = stat.ppid;
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
  return listContainedIdentities(token).map((identity) => identity.pid);
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

/**
 * This process's own chain members of the scope cgroup, each pinned to the
 * start time it has now, so a later migration can refuse a recycled number.
 */
function ownChainInside(
  cgroupDir: string,
  members: number[],
): ProcessIdentity[] {
  const chain = selfAndAncestorIdentities();
  const inside = new Map<number, number>();
  for (const pid of members) {
    const startTicks = chain.get(pid);
    if (startTicks !== undefined) inside.set(pid, startTicks);
  }
  const own = chain.get(process.pid);
  if (isInsideCgroup(cgroupDir) && own !== undefined) {
    inside.set(process.pid, own);
  }
  return [...inside].map(([pid, startTicks]) => ({ pid, startTicks }));
}

function insideScopeRefusal(detail: string): string {
  return (
    `this command is running inside the session's containment cgroup and ` +
    `${detail}; refusing to write cgroup.kill. ${INSIDE_SCOPE_ADVICE}`
  );
}

/**
 * Move one pinned chain member into the parent cgroup. `cgroup.procs` takes a
 * bare number, so every guarantee has to come from re-reading `/proc` around
 * the write: the pid must still be this process's ancestor *with the recorded
 * start time* and still a member of this scope, or nothing is written at all —
 * a pid that has been reaped and reused belongs to an unrelated process, and
 * moving that out of its own cgroup would be exactly the harm this avoids.
 * After the write the same identity must be readable in the parent cgroup;
 * anything else is refused rather than assumed.
 */
function migrateChainMember(
  identity: ProcessIdentity,
  cgroupDir: string,
  parentDir: string,
): string | undefined {
  if (selfAndAncestorIdentities().get(identity.pid) !== identity.startTicks) {
    return undefined;
  }
  if (processCgroupDir(identity.pid) !== cgroupDir) return undefined;
  try {
    fs.writeFileSync(path.join(parentDir, "cgroup.procs"), String(identity.pid));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return undefined;
    return insideScopeRefusal(
      `pid ${identity.pid} could not be moved out: ${errorMessage(error)}`,
    );
  }
  const now = processCgroupDir(identity.pid);
  if (selfAndAncestorIdentities().get(identity.pid) !== identity.startTicks) {
    return insideScopeRefusal(
      `pid ${identity.pid} changed identity while being moved out of ${cgroupDir}`,
    );
  }
  if (now !== parentDir) {
    return insideScopeRefusal(
      `pid ${identity.pid} is in ${now ?? "<unreadable>"} after being moved out, not ${parentDir}`,
    );
  }
  return undefined;
}

/**
 * Move this process's own chain out of the scope cgroup into its parent, and
 * confirm from the kernel that none of it is still a member. Returns the
 * reason cleanup must refuse when that cannot be established.
 */
function evacuateOwnChain(
  cgroupDir: string,
  chainInside: ProcessIdentity[],
): string | undefined {
  const parentDir = path.dirname(cgroupDir);
  for (const identity of chainInside) {
    const problem = migrateChainMember(identity, cgroupDir, parentDir);
    if (problem !== undefined) return problem;
  }
  const remaining = readCgroupProcs(cgroupDir);
  if (remaining === undefined) {
    return insideScopeRefusal(`${cgroupDir}/cgroup.procs became unreadable`);
  }
  const chain = selfAndAncestorIdentities();
  const still = remaining.filter((pid) => chain.has(pid));
  if (still.length > 0 || isInsideCgroup(cgroupDir)) {
    return insideScopeRefusal(
      `pid(s) ${still.join(", ") || process.pid} are still members afterwards`,
    );
  }
  return undefined;
}

type MemberVerdict = "ours" | "gone" | "foreign" | "unknown";

/**
 * Whether a cgroup member belongs to this scope. It does when it carries the
 * token, or when an ancestor *inside the same cgroup* does: a member that
 * exec'd a setuid image has an unreadable `environ` of its own, but it is
 * still a child of the supervisor that joined the scope carrying the token.
 * The walk stops at the cgroup boundary, so an unreadable process outside the
 * scope never decides anything about a member of it.
 *
 * The residual case — a process that wiped its own environment *and* whose
 * whole in-scope parent chain has exited — is reported as `unknown` and
 * refused rather than killed on an unproven claim of ownership.
 */
function classifyCgroupMember(
  pid: number,
  token: string,
  members: Set<number>,
): MemberVerdict {
  let current: number | undefined = pid;
  let unreadable = false;
  for (let depth = 0; current !== undefined && depth < 64; depth += 1) {
    const read = readEnviron(current);
    if (read.kind === "entries") {
      if (read.entries.includes(`${TOKEN_ENV}=${token}`)) return "ours";
    } else if (read.kind === "unreadable") {
      unreadable = true;
    } else if (current === pid) {
      return "gone";
    }
    const parent = readParentPid(current);
    current = parent !== undefined && members.has(parent) ? parent : undefined;
  }
  return unreadable ? "unknown" : "foreign";
}

/**
 * Prove, immediately before `cgroup.kill`, that every process the kill would
 * reach is this session's own. A directory named `pickforge-<id>` on a cgroup
 * v2 filesystem is already bound to one session, so this is the second, live
 * proof: even a record whose id and path were both rewritten cannot make the
 * kill land on processes that carry another session's token. Members whose
 * ownership is momentarily unreadable (dying, mid-exec) are re-read until they
 * settle or leave; one that never settles fails cleanup instead of being
 * killed unverified.
 */
async function verifyCgroupMembership(
  cgroupDir: string,
  token: string,
): Promise<string | undefined> {
  const deadline = Date.now() + MEMBER_VERIFY_TIMEOUT_MS;
  for (;;) {
    const members = readCgroupProcs(cgroupDir);
    if (members === undefined) return `could not read ${cgroupDir}/cgroup.procs`;
    const chain = selfAndAncestorIdentities();
    const inScope = new Set(members);
    const undecided: number[] = [];
    const foreign: number[] = [];
    for (const pid of members) {
      if (chain.has(pid)) continue;
      const verdict = classifyCgroupMember(pid, token, inScope);
      if (verdict === "foreign") foreign.push(pid);
      else if (verdict === "unknown") undecided.push(pid);
    }
    if (foreign.length > 0) {
      return (
        `refusing cgroup cleanup: ${cgroupDir} holds process(es) that do not ` +
        `carry this session's containment token: ${foreign.join(", ")}`
      );
    }
    if (undecided.length === 0) return undefined;
    if (Date.now() >= deadline) {
      return (
        `refusing cgroup cleanup: could not verify that process(es) ` +
        `${undecided.join(", ")} in ${cgroupDir} belong to this session`
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Everything that must hold before `cgroup.kill` may be written: the path is
 * a real cgroup, its member list is readable, none of this process's own chain
 * is (any longer) a member, and every remaining member is provably ours.
 */
async function guardCgroupKill(
  cgroupDir: string,
  token: string,
): Promise<string | undefined> {
  if (!isCgroup2Dir(cgroupDir)) {
    return `refusing cgroup cleanup: ${cgroupDir} is not on a cgroup v2 filesystem`;
  }
  const members = readCgroupProcs(cgroupDir);
  if (members === undefined) {
    return `could not read ${cgroupDir}/cgroup.procs`;
  }
  const inside = ownChainInside(cgroupDir, members);
  const evacuated =
    inside.length === 0 ? undefined : evacuateOwnChain(cgroupDir, inside);
  if (evacuated !== undefined) return evacuated;
  return verifyCgroupMembership(cgroupDir, token);
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
  /**
   * Every identity a scan has found carrying the token and that has not been
   * shown to be gone (or refused) since. Ownership, once established, is never
   * forgotten because a later `environ` read failed: an identity that stops
   * being readable stays here, so it can still be signalled when the token
   * comes back and is reported as an unconfirmed survivor if it never does.
   */
  pending: Map<string, ProcessIdentity>;
  /** Pending identities whose token could not be re-read on the last pass. */
  unverified: Set<number>;
}

function identityKey(identity: ProcessIdentity): string {
  return `${identity.pid}:${identity.startTicks}`;
}

/**
 * Decide one pending identity: `gone` and `mismatch` settle it for good,
 * `match` signals it (once per sweep) and keeps it pending until it exits, and
 * `same-process` — the same process with an unreadable, empty or tokenless
 * environment — leaves it pending, marked unverified, for a later pass.
 */
function decidePending(
  identity: ProcessIdentity,
  token: string,
  signal: NodeJS.Signals,
  state: SweepState,
  settled: Set<string>,
): void {
  const key = identityKey(identity);
  const probe = probeToken(identity, token);
  if (probe === "gone") {
    state.pending.delete(key);
    state.unverified.delete(identity.pid);
    return;
  }
  if (probe === "mismatch") {
    state.pending.delete(key);
    state.unverified.delete(identity.pid);
    state.refused.add(identity.pid);
    settled.add(key);
    return;
  }
  if (probe === "same-process") {
    state.unverified.add(identity.pid);
    return;
  }
  state.unverified.delete(identity.pid);
  if (settled.has(key)) return;
  settled.add(key);
  try {
    process.kill(identity.pid, signal);
    state.signaled.add(identity.pid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      state.pending.delete(key);
      return;
    }
    state.pending.delete(key);
    state.refused.add(identity.pid);
  }
}

/**
 * Signal every contained process once, then wait for the scope to empty. New
 * PIDs that appear while waiting (a descendant forked mid-shutdown) are
 * signalled too, but an already-signalled PID is not signalled again in the
 * same sweep, so a graceful SIGTERM handler is not interrupted by a second
 * SIGTERM. A process that could not be decided on one pass stays pending and
 * is decided on a later one — including one the scans can no longer see.
 */
async function sweepUntilEmpty(
  token: string,
  signal: NodeJS.Signals,
  timeoutMs: number,
  state: SweepState,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const settled = new Set<string>();
  let emptyPasses = 0;
  for (;;) {
    for (const identity of listContainedIdentities(token)) {
      state.pending.set(identityKey(identity), identity);
    }
    for (const identity of [...state.pending.values()]) {
      decidePending(identity, token, signal, state, settled);
    }
    // A process mid-exec is invisible to one scan; only two consecutive passes
    // with nothing pending, a poll apart, mean the scope is empty.
    emptyPasses = state.pending.size === 0 ? emptyPasses + 1 : 0;
    if (emptyPasses >= 2 || Date.now() >= deadline) return;
    await sleep(POLL_INTERVAL_MS);
  }
}

/** Contained processes still pending when a sweep ran out of time. */
function pendingSurvivors(state: SweepState): number[] {
  return [...new Set([...state.pending.values()].map((each) => each.pid))];
}

export interface DestroyContainmentOptions {
  termTimeoutMs?: number;
  killTimeoutMs?: number;
}

async function destroyCgroupMembers(
  scope: ContainmentScope,
  timeoutMs: number,
): Promise<string | undefined> {
  const problem = containmentScopeProblem(scope);
  if (problem !== undefined) return `refusing cgroup cleanup: ${problem}`;
  const cgroupDir = scope.cgroupDir as string;
  if (!fs.existsSync(cgroupDir)) return undefined;
  const blocked = await guardCgroupKill(cgroupDir, scope.token);
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
  const state: SweepState = {
    signaled: new Set(),
    refused: new Set(),
    pending: new Map(),
    unverified: new Set(),
  };
  const cgroupReason =
    scope.mechanism === "cgroup"
      ? await destroyCgroupMembers(scope, termTimeoutMs)
      : undefined;

  await sweepUntilEmpty(scope.token, "SIGTERM", termTimeoutMs, state);
  if (state.pending.size > 0) {
    await sweepUntilEmpty(scope.token, "SIGKILL", killTimeoutMs, state);
  }
  const survivors = pendingSurvivors(state);
  const unverified = survivors.filter((pid) => state.unverified.has(pid));

  const reason =
    survivors.length > 0
      ? `${survivors.length} contained process(es) survived SIGKILL: ${survivors.join(", ")}` +
        (unverified.length === 0
          ? ""
          : ` (${unverified.join(", ")} still had this scope's start identity with an unreadable containment token)`)
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
  const problem = containmentScopeProblem(scope);
  if (problem !== undefined) {
    throw new Error(
      `Containment supervisor refuses a scope that is not this session's Pickforge cgroup: ${problem}`,
    );
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
