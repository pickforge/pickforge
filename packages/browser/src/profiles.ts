import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  DirHandle,
  getSession,
  identityIsAlive,
  isProcessGroupAlive,
  pickforgeHome,
  processIdentityMatches,
  readProcessIdentity,
  readProcessGroupLeaderIdentity,
  type EnvLike,
  type ProcessIdentity,
} from "@pickforge/lab-core";

export const BROWSER_PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function validateBrowserProfileName(name: string): void {
  if (!BROWSER_PROFILE_NAME.test(name)) {
    throw new Error(`Invalid browser profile name "${name}": expected [a-z0-9][a-z0-9-]{0,31}`);
  }
}

export function browserProfileDir(name: string, env: EnvLike = process.env): string {
  validateBrowserProfileName(name);
  return path.join(pickforgeHome(env), "profiles", name);
}

interface ProfileOwner {
  sessionId: string;
  process: ProcessIdentity;
  token: string;
}

interface HealthyBrowserProfileEntry {
  name: string;
  sizeBytes: number;
  lastUsedAt: string;
  holdingSession: string | null;
}

export type BrowserProfileEntry = HealthyBrowserProfileEntry | {
  name: string;
  error: string;
};

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function assertPrivate(dir: DirHandle): void {
  if (dir.stat.uid !== process.getuid?.() || (dir.stat.mode & 0o077) !== 0) {
    throw new Error(`Refusing unsafe browser profile directory ${dir.dir}: must be owned by this user with mode 0700`);
  }
}

async function openPrivateProfiles(base: DirHandle, create: boolean): Promise<DirHandle> {
  const root = create
    ? await base.ensureChildDir("profiles", 0o700)
    : await base.openChild("profiles");
  try {
    assertPrivate(root);
    return root;
  } catch (error) {
    await root.close();
    throw error;
  }
}

async function openProfiles(env: EnvLike, create: boolean): Promise<DirHandle | undefined> {
  const home = pickforgeHome(env);
  if (create) await fs.promises.mkdir(home, { recursive: true, mode: 0o700 });
  let base: DirHandle;
  try {
    base = await DirHandle.open(home, { followFinal: true });
  } catch (error) {
    if (!create && !fs.existsSync(home)) return undefined;
    throw error;
  }
  try {
    if (base.stat.uid !== process.getuid?.() || (base.stat.mode & 0o022) !== 0) {
      throw new Error(`Refusing unsafe browser profile parent: ${home}`);
    }
    return await openPrivateProfiles(base, create);
  } catch (error) {
    if (!create && errno(error) === "ENOENT") return undefined;
    // DirHandle translates missing directory errors. Check via the pinned parent.
    if (!create && await base.lstatChild("profiles") === undefined) return undefined;
    throw error;
  } finally {
    await base.close();
  }
}

async function openProfile(root: DirHandle, name: string, create: boolean): Promise<DirHandle> {
  let dir: DirHandle;
  try {
    dir = create ? await root.ensureChildDir(name, 0o700) : await root.openChild(name);
  } catch (error) {
    if ((await root.lstatChild(name))?.isSymbolicLink()) {
      throw new Error(`Refusing browser profile "${name}": it is a symlink`);
    }
    throw error;
  }
  try {
    assertPrivate(dir);
    return dir;
  } catch (error) {
    await dir.close();
    throw error;
  }
}

const lockName = (name: string): string => `.${name}.lock`;
const sentinelName = (name: string, token: string): string => `.${name}.lock.${token}`;

function validOwnerProcess(identity: ProcessIdentity | undefined): boolean {
  if (identity?.pid === undefined) return false;
  return Number.isSafeInteger(identity.pid) && identity.pid > 0 && Number.isSafeInteger(identity.startTicks);
}

async function readOwner(root: DirHandle, name: string): Promise<ProfileOwner | undefined> {
  let file: fs.promises.FileHandle;
  try {
    file = await root.openFile(lockName(name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
      throw new Error(`Unsafe browser profile lock: ${name}`);
    }
    const value = JSON.parse(await file.readFile("utf8")) as ProfileOwner;
    if (typeof value.sessionId !== "string" || !/^[0-9a-f-]{36}$/.test(value.token) ||
        !validOwnerProcess(value.process)) {
      throw new Error(`Invalid browser profile lock: ${name}`);
    }
    return value;
  } finally {
    await file.close();
  }
}

async function ownerAlive(owner: ProfileOwner, env: EnvLike): Promise<boolean> {
  if (processIdentityMatches(owner.process)) return true;
  // A CLI can exit while its detached browser and display still run.
  const record = await getSession(owner.sessionId, env);
  return recordedProcessAlive(record?.browser?.browserPid, record?.browser?.browserStartTimeTicks) ||
    recordedProcessAlive(record?.desktop?.xvfbPid, record?.desktop?.xvfbStartTimeTicks);
}

function recordedProcessAlive(pid: number | undefined, startTicks: number | undefined): boolean {
  if (pid === undefined) return false;
  if (startTicks === undefined) return identityIsAlive(pid) || isProcessGroupAlive(pid);
  // A reused leader cannot belong to the recorded process group.
  const current = readProcessGroupLeaderIdentity(pid) ?? readProcessIdentity(pid);
  if (current !== undefined && current.startTicks !== startTicks) return false;
  return identityIsAlive(pid, startTicks) || isProcessGroupAlive(pid);
}

/** Catch a creator crash between spawning Chrome and saving its process identity. */
async function assertNoProfileProcess(profileDir: string): Promise<void> {
  for (const pid of await fs.promises.readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    let argv: string;
    try {
      argv = await fs.promises.readFile(`/proc/${pid}/cmdline`, "utf8");
    } catch (error) {
      if (errno(error) === "ENOENT" || errno(error) === "ESRCH") continue;
      // Other users' processes cannot hold this private profile.
      if (errno(error) === "EACCES") continue;
      throw error;
    }
    if (argv.split("\0").includes(`--user-data-dir=${profileDir}`)) {
      throw new Error(`Browser profile ${profileDir} is still used by process ${pid}`);
    }
  }
}

async function restoreAbandonedRemoval(root: DirHandle, sentinel: string): Promise<boolean> {
  const prefix = `${sentinel}.removing-`;
  for (const entry of await root.readEntryNames()) {
    if (!entry.startsWith(prefix)) continue;
    const match = /^(\d+)-(\d+)$/.exec(entry.slice(prefix.length));
    if (match === null) continue;
    if (processIdentityMatches({ pid: Number(match[1]), startTicks: Number(match[2]) })) continue;
    try {
      // Rename restores the single sentinel without leaving a second breaker candidate.
      await fs.promises.rename(root.resolve(entry), root.resolve(sentinel));
      return true;
    } catch (error) {
      if (errno(error) !== "ENOENT") throw error;
    }
  }
  return false;
}

async function removeOwner(root: DirHandle, name: string, owner: ProfileOwner): Promise<boolean> {
  const identity = readProcessIdentity(process.pid);
  if (identity === undefined) throw new Error("Cannot identify browser profile lock remover");
  const sentinel = sentinelName(name, owner.token);
  const removing = `${sentinel}.removing-${identity.pid}-${identity.startTicks}`;
  try {
    // One breaker wins the sentinel. Keep its identity so a crash mid-release is recoverable.
    await fs.promises.rename(root.resolve(sentinel), root.resolve(removing));
  } catch (error) {
    if (errno(error) !== "ENOENT") throw error;
    return await restoreAbandonedRemoval(root, sentinel) ? removeOwner(root, name, owner) : false;
  }
  try {
    if ((await readOwner(root, name))?.token !== owner.token) return false;
    return await root.unlinkChild(lockName(name));
  } finally {
    await root.unlinkChild(removing);
  }
}

async function acquire(root: DirHandle, name: string, sessionId: string, env: EnvLike): Promise<void> {
  const identity = readProcessIdentity(process.pid);
  if (identity === undefined) throw new Error("Cannot identify browser profile lock owner");
  const owner: ProfileOwner = { sessionId, process: identity, token: randomUUID() };
  const sentinel = sentinelName(name, owner.token);
  const file = await root.openFile(sentinel, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(owner));
  } finally {
    await file.close();
  }
  let acquired = false;
  try {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await root.linkChild(sentinel, lockName(name));
        acquired = true;
        return;
      } catch (error) {
        if (errno(error) !== "EEXIST") throw error;
      }
      const current = await readOwner(root, name);
      if (current === undefined) continue;
      if (await ownerAlive(current, env)) {
        throw new Error(`Browser profile "${name}" is held by session ${current.sessionId}`);
      }
      try {
        await assertNoProfileProcess(browserProfileDir(name, env));
      } catch (error) {
        throw new Error(`Browser profile "${name}" is held by session ${current.sessionId}: ${(error as Error).message}`, { cause: error });
      }
      await removeOwner(root, name, current);
    }
    throw new Error(`Could not acquire browser profile "${name}"; retry the operation`);
  } finally {
    if (!acquired) await root.unlinkChild(sentinel);
  }
}

async function singletonOwnerUsesProfile(pid: number, profileDir: string): Promise<boolean> {
  let argv: string[];
  try {
    argv = (await fs.promises.readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
  } catch (error) {
    if (errno(error) === "ENOENT" || errno(error) === "ESRCH") return false;
    throw error;
  }
  const executable = path.basename(argv[0] ?? "");
  if (!/^(?:google-chrome(?:-stable|-beta|-unstable)?|chrome|chromium(?:-browser)?)$/.test(executable)) return false;
  return argv.includes(`--user-data-dir=${profileDir}`);
}

async function clearSingletons(dir: DirHandle, profileName: string): Promise<void> {
  const lock = await dir.lstatChild("SingletonLock");
  if (lock !== undefined) {
    if (!lock.isSymbolicLink()) throw new Error(`Refusing browser profile "${profileName}": remove the unknown SingletonLock file`);
    const target = await fs.promises.readlink(dir.resolve("SingletonLock"));
    const match = /^(.*)-(\d+)$/.exec(target);
    if (match === null || await singletonOwnerUsesProfile(Number(match[2]), dir.realDir)) {
      throw new Error(`Refusing browser profile "${profileName}": SingletonLock owner is not confirmed dead; remove SingletonLock after closing Chrome`);
    }
  }
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie", "DevToolsActivePort"]) {
    // Unlink the entry itself. Never follow Chrome's singleton symlinks.
    await dir.unlinkChild(name);
  }
}

/** A dead creator cannot finish a partially published startup. Typed teardown must recover it. */
export async function abandonedBrowserProfileStartup(name: string, env: EnvLike): Promise<string | undefined> {
  validateBrowserProfileName(name);
  const root = await openProfiles(env, false);
  if (root === undefined) return undefined;
  try {
    const owner = await readOwner(root, name);
    if (owner === undefined || processIdentityMatches(owner.process)) return undefined;
    const record = await getSession(owner.sessionId, env);
    return record?.type === "browser" && record.status === "starting" ? record.id : undefined;
  } finally {
    await root.close();
  }
}

/** Claim before starting any browser process. The hold survives the creating CLI. */
export async function claimBrowserProfile(name: string, sessionId: string, env: EnvLike): Promise<string> {
  validateBrowserProfileName(name);
  const root = (await openProfiles(env, true))!;
  let held = false;
  try {
    await acquire(root, name, sessionId, env);
    held = true;
    const dir = await openProfile(root, name, true);
    try {
      await assertNoProfileProcess(browserProfileDir(name, env));
      await clearSingletons(dir, name);
      const now = new Date();
      await fs.promises.utimes(dir.resolve(), now, now);
    } finally {
      await dir.close();
    }
    return browserProfileDir(name, env);
  } catch (error) {
    if (held) await releaseOwner(root, name, sessionId);
    throw error;
  } finally {
    await root.close();
  }
}

async function releaseOwner(root: DirHandle, name: string, sessionId: string): Promise<void> {
  const owner = await readOwner(root, name);
  if (owner?.sessionId === sessionId) await removeOwner(root, name, owner);
}

/** Only call after typed teardown confirms all owned processes have stopped. */
export async function releaseBrowserProfile(name: string, sessionId: string, env: EnvLike): Promise<void> {
  validateBrowserProfileName(name);
  const root = await openProfiles(env, false);
  if (root === undefined) return;
  try {
    await releaseOwner(root, name, sessionId);
  } finally {
    await root.close();
  }
}

async function directorySize(dir: DirHandle): Promise<number> {
  let size = 0;
  for (const name of await dir.readEntryNames()) {
    const stat = await dir.lstatChild(name);
    if (stat?.isDirectory()) {
      try {
        const child = await dir.openChild(name);
        try { size += await directorySize(child); } finally { await child.close(); }
      } catch (error) {
        // DirHandle translates ENOENT. Check absence through the pinned parent.
        if (await dir.lstatChild(name) !== undefined) throw error;
      }
    } else if (stat !== undefined) {
      size += stat.size;
    }
  }
  return size;
}

async function readProfileEntry(root: DirHandle, name: string, env: EnvLike): Promise<BrowserProfileEntry> {
  const dir = await openProfile(root, name, false);
  try {
    const owner = await readOwner(root, name);
    return {
      name,
      sizeBytes: await directorySize(dir),
      lastUsedAt: dir.stat.mtime.toISOString(),
      holdingSession: owner !== undefined && await ownerAlive(owner, env) ? owner.sessionId : null,
    };
  } finally {
    await dir.close();
  }
}

export async function listBrowserProfiles(env: EnvLike = process.env): Promise<BrowserProfileEntry[]> {
  const root = await openProfiles(env, false);
  if (root === undefined) return [];
  try {
    const profiles: BrowserProfileEntry[] = [];
    for (const name of (await root.readEntryNames()).sort()) {
      if (!BROWSER_PROFILE_NAME.test(name)) continue;
      if ((await root.lstatChild(name))?.isFile()) continue;
      try {
        profiles.push(await readProfileEntry(root, name, env));
      } catch (error) {
        profiles.push({ name, error: (error as Error).message });
      }
    }
    return profiles;
  } finally {
    await root.close();
  }
}

export async function deleteBrowserProfile(name: string, env: EnvLike = process.env): Promise<void> {
  validateBrowserProfileName(name);
  const root = await openProfiles(env, false);
  if (root === undefined) throw new Error(`Browser profile not found: ${name}`);
  const sessionId = `profile-delete-${randomUUID()}`;
  let held = false;
  try {
    if (await root.lstatChild(name) === undefined) throw new Error(`Browser profile not found: ${name}`);
    await acquire(root, name, sessionId, env);
    held = true;
    const dir = await openProfile(root, name, false);
    try {
      await assertNoProfileProcess(browserProfileDir(name, env));
      await clearSingletons(dir, name);
      // rm never follows symlinks in the tree. The parent is pinned and private.
      await fs.promises.rm(root.resolve(name), { recursive: true });
    } finally {
      await dir.close();
    }
  } finally {
    if (held) await releaseOwner(root, name, sessionId);
    await root.close();
  }
}
