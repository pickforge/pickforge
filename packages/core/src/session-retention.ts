import fs from "node:fs";
import path from "node:path";
import { abandonedRemoval, DirHandle, withDirHandle } from "./dir-handle.js";
import { legacySessionsDirs, sessionsDir, type EnvLike } from "./paths.js";
import { identityIsAlive, isPidAlive } from "./proc.js";
import { sessionDataDir, sessionInputClosedName, takeoverIdentityName, type SessionRecord } from "./session.js";

const MARKER = "stopped.json";
const SESSION_ID = /^(desk|andr|duo|brow)-[0-9a-f]{6,}$/;
const SESSION_MARKER = /^\.((?:desk|andr|duo|brow)-[0-9a-f]{6,})\.(?:takeover-identity|input-closed)$/;
const LOG_FILE = /^[^.].*\.log$/;
// Lease staging names: the takeover.ts staging file, writeFileAtomic's temp
// for it, and the temp a lease renewal leaves.
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const LEASE_STAGING = new RegExp(
  `^(\\.human-lease-${UUID}|\\.\\.human-lease-${UUID}\\.tmp-\\d+-\\d+|\\.human\\.lease\\.json\\.tmp-\\d+-\\d+)$`,
);
// The writeFileAtomic temp for the marker, left when teardown dies before the rename.
const MARKER_TEMP = /^\.stopped\.json\.tmp-(\d+)-\d+$/;
// Coordination files of takeover.ts that carry an owner, and write temps
// that carry their writer pid, in the session and permits directories.
const LEASE_RECORD = new RegExp(`^(human\\.lease\\.json|\\.human-lease-${UUID})$`);
const LEASE_TEMP = new RegExp(`^(?:\\.\\.human-lease-${UUID}|\\.human\\.lease\\.json)\\.tmp-(\\d+)-\\d+$`);
const PERMIT_RECORD = new RegExp(`^(${UUID}\\.json|\\.agent-permit-${UUID})$`);
const PERMIT_TEMP = new RegExp(`^\\.\\.agent-permit-${UUID}\\.tmp-(\\d+)-\\d+$`);
// publishCoordinationIdentity's staging file in the sessions root, and the
// writeFileAtomic temp for it, which carries its writer pid.
const IDENTITY_STAGING = new RegExp(`^\\.takeover-identity-${UUID}$`);
const IDENTITY_TEMP = new RegExp(`^\\.\\.takeover-identity-${UUID}\\.tmp-(\\d+)-\\d+$`);

// A temp whose writer may still run belongs to an overlapping retain. If a
// live process reuses the dead writer's pid, the orphan stays and blocks
// pruning of that session, but no data is lost.
function isOrphanMarkerTemp(name: string): boolean {
  const pid = MARKER_TEMP.exec(name)?.[1];
  return pid !== undefined && Number(pid) !== process.pid && !isPidAlive(Number(pid));
}

/** Called only after typed teardown has confirmed its processes are gone. */
export async function retainSessionLogs(
  record: SessionRecord,
  env: EnvLike,
): Promise<void> {
  const dir = sessionDataDir(record.id, env);
  await withDirHandle(DirHandle.open(path.dirname(dir)), async (root) => {
    await withDirHandle(root.ensureChildDir(record.id, 0o700), async (handle) => {
      for (const name of ["permits", "human.lease.json"]) {
        await fs.promises.rm(handle.resolve(name), { recursive: true, force: true });
      }
      // A lease publisher or an earlier teardown killed before its cleanup
      // leaves staging files behind, possibly under a removal name.
      let names = await handle.readEntryNames();
      if (await restoreAbandonedRemovals(handle, names)) names = await handle.readEntryNames();
      for (const name of names) {
        // One that cannot go back, because its name was taken again, is still
        // the staging file it was.
        const original = abandonedRemoval(name) ?? name;
        if (!LEASE_STAGING.test(original) && !isOrphanMarkerTemp(original)) continue;
        const stat = await handle.lstatChild(name);
        if (stat?.isDirectory() === false) await unlinkStaleFile(handle, name, stat);
      }
      await handle.writeFileAtomic(MARKER, JSON.stringify({
        id: record.id,
        stoppedAt: new Date().toISOString(),
        ...(record.status === "error" ? { failure: record } : {}),
      }) + "\n");
    });
  });
}

export function parseSessionRetentionDuration(value: string): number {
  const match = /^(\d+)(s|m|h|d|w)$/.exec(value);
  if (match === null) throw new Error("Duration must be a positive integer followed by s, m, h, d or w");
  const units: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  const duration = Number(match[1]) * units[match[2]!]!;
  if (!Number.isSafeInteger(duration) || duration <= 0) throw new Error("Invalid retention duration");
  return duration;
}

/**
 * How long the input closure and takeover identity markers reserve an id after
 * its last record. A command reads the record once and re-checks it at each
 * permit. The longest command is a 300 s desktop wait or input action after
 * up to 90 s for the session lock, so live references end within minutes. A
 * day also covers a stopped or suspended caller. One that resumes later still
 * fails closed on the missing record. Ids carry 64 random bits, so a new
 * session drawing the same id again is negligible (#413).
 */
export const SESSION_MARKER_HORIZON_MS = 86_400_000;

/** The identity goes first: a closure marker left alone still refuses every caller. */
function markerNames(id: string): string[] {
  return [takeoverIdentityName(id), sessionInputClosedName(id)];
}

/** Opens a file prune just lstat'ed, or undefined when a concurrent prune removed it. */
async function openIfPresent(dir: DirHandle, name: string): Promise<fs.promises.FileHandle | undefined> {
  return dir.openFile(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  });
}

/** Lists a directory prune opened, or undefined when a concurrent prune removed it. */
async function entriesIfPresent(dir: DirHandle): Promise<string[] | undefined> {
  return dir.readEntryNames().catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  });
}

/**
 * A remover stopped between its rename and its unlink leaves the entry under
 * its removal name. Putting it back lets prune check it again. If a live
 * process reuses the remover's pid, the entry stays, which keeps only its
 * directory. Returns whether an entry went back.
 */
async function restoreAbandonedRemovals(dir: DirHandle, names: string[]): Promise<boolean> {
  let restored = false;
  for (const name of names) {
    const original = abandonedRemoval(name);
    if (original !== undefined && await dir.restoreRemoved(name, original)) restored = true;
  }
  return restored;
}

/** {@link entriesIfPresent}, with abandoned removals put back first. */
async function entriesAfterRestore(dir: DirHandle): Promise<string[] | undefined> {
  const names = await entriesIfPresent(dir);
  if (names === undefined || !await restoreAbandonedRemovals(dir, names)) return names;
  await restoreTimes(dir);
  return entriesIfPresent(dir);
}

/** Runs `fn` on a directory prune just lstat'ed; false when a concurrent prune removed it. */
async function withChildIfPresent(dir: DirHandle, name: string, fn: (child: DirHandle) => Promise<boolean>): Promise<boolean> {
  const child = await dir.openChild(name).catch((error: unknown) => {
    // openChild reports a gone entry as a storage error caused by ENOENT, or as
    // a plain ENOENT when the entry goes after the open, while it is verified.
    const cause = (error as Error | undefined)?.cause as NodeJS.ErrnoException | undefined;
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT" && cause?.code !== "ENOENT") throw error;
    return undefined;
  });
  return child !== undefined && withDirHandle(child, fn);
}

async function retainedStoppedAt(dir: DirHandle, id: string): Promise<number | undefined> {
  const stat = await dir.lstatChild(MARKER);
  if (stat?.isFile() !== true) return undefined;
  const file = await openIfPresent(dir, MARKER);
  if (file === undefined) return undefined;
  try {
    const marker = JSON.parse(await file.readFile("utf8"));
    if (marker.id !== id || typeof marker.stoppedAt !== "string") return undefined;
    const stoppedAt = Date.parse(marker.stoppedAt);
    return Number.isFinite(stoppedAt) ? stoppedAt : undefined;
  } catch {
    return undefined;
  } finally {
    await file.close();
  }
}

// A prune stopped while it removed stopped.json leaves it under a removal name.
async function restoredStoppedAt(dir: DirHandle, id: string): Promise<number | undefined> {
  const names = await entriesIfPresent(dir);
  if (names === undefined || !await restoreAbandonedRemovals(dir, names)) return undefined;
  await restoreTimes(dir);
  return retainedStoppedAt(dir, id);
}

async function registryHasSession(id: string, roots: string[]): Promise<boolean> {
  for (const root of roots) {
    try {
      const entries = await fs.promises.readdir(root);
      if (entries.some((name) => name === `${id}.json` || name.startsWith(`${id}.ensure-vnc.lock`))) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return false;
}

// Teardown retains logs just before it removes the record, so stoppedAt is
// when the id was last live. Markers keep that time once the directory goes.
async function carryStoppedAt(root: DirHandle, id: string, stoppedAt: number): Promise<void> {
  for (const name of markerNames(id)) {
    const stat = await root.lstatChild(name);
    if (stat?.isFile() !== true || stat.mtimeMs >= stoppedAt) continue;
    const file = await openIfPresent(root, name);
    if (file === undefined) continue;
    try {
      await file.utimes(stat.atime, new Date(stoppedAt));
    } finally {
      await file.close();
    }
  }
}

type StaleFiles = Array<[string, fs.Stats]>;

function isOld(stat: fs.Stats): boolean {
  return Date.now() - stat.mtimeMs >= SESSION_MARKER_HORIZON_MS;
}

function ownerIsGone(raw: string): boolean {
  try {
    const { ownerPid, ownerStartTicks } = JSON.parse(raw);
    if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) return false;
    return !identityIsAlive(ownerPid, typeof ownerStartTicks === "number" ? ownerStartTicks : undefined);
  } catch {
    return false;
  }
}

/**
 * An old regular file that a first permit or lease caller writes: a permit or
 * lease record, or its staging copy, whose owner is gone; or a write temp
 * whose writer pid is gone. Anything else is not ours to delete.
 */
async function staleCoordinationFile(dir: DirHandle, name: string, records: RegExp, temps: RegExp): Promise<fs.Stats | undefined> {
  const stat = await dir.lstatChild(name);
  if (stat?.isFile() !== true || !isOld(stat)) return undefined;
  const original = abandonedRemoval(name) ?? name;
  const pid = temps.exec(original)?.[1];
  if (pid !== undefined) return isPidAlive(Number(pid)) ? undefined : stat;
  if (!records.test(original)) return undefined;
  const file = await openIfPresent(dir, name);
  if (file === undefined) return undefined;
  try {
    return ownerIsGone(await file.readFile("utf8")) ? stat : undefined;
  } finally {
    await file.close();
  }
}

// Restored after our own unlinks, so a prune that stops midway leaves the
// directory old and the next prune finishes it.
async function restoreTimes(dir: DirHandle): Promise<void> {
  await fs.promises.utimes(dir.resolve(), dir.stat.atime, dir.stat.mtime);
}

/** Removes a file that was checked, and keeps a replacement made at any point. */
async function unlinkStaleFile(dir: DirHandle, name: string, stat: fs.Stats): Promise<void> {
  // A concurrent prune may have removed it first; a replaced entry still fails.
  await dir.unlinkOwnedFile(name, stat).catch((error: unknown) => {
    if (((error as Error).cause as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
  });
}

/**
 * Removes the directory by name: POSIX has no rmdir by inode. If a concurrent
 * prune removed it and a stalled first permit caller then made an empty one
 * with the same id, this removes that one too. The caller fails closed on its
 * next step, so no data is lost and no input is delivered.
 */
async function rmdirIfEmpty(target: string): Promise<boolean> {
  try {
    await fs.promises.rmdir(target);
    return true;
  } catch (error) {
    // A concurrent prune removed it, or a writer added an entry first.
    if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    return false;
  }
}

async function stalePermitFiles(permits: DirHandle): Promise<StaleFiles | undefined> {
  if (!isOld(permits.stat)) return undefined;
  const names = await entriesAfterRestore(permits);
  if (names === undefined) return undefined;
  const files: StaleFiles = [];
  for (const name of names) {
    const stat = await staleCoordinationFile(permits, name, PERMIT_RECORD, PERMIT_TEMP);
    if (stat === undefined) return undefined;
    files.push([name, stat]);
  }
  return files;
}

async function removePermits(dir: DirHandle, permits: DirHandle, files: StaleFiles): Promise<boolean> {
  try {
    for (const [name, stat] of files) await unlinkStaleFile(permits, name, stat);
  } finally {
    await restoreTimes(permits);
  }
  return rmdirIfEmpty(dir.resolve("permits"));
}

async function removeCoordinationDirectory(
  root: DirHandle, dir: DirHandle, id: string, roots: string[],
  files: StaleFiles, permits?: [DirHandle, StaleFiles],
): Promise<boolean> {
  if (await registryHasSession(id, roots)) return false;
  const current = await root.lstatChild(id);
  if (current?.dev !== dir.stat.dev || current.ino !== dir.stat.ino) return false;
  try {
    if (permits !== undefined && !await removePermits(dir, ...permits)) return false;
    for (const [name, stat] of files) await unlinkStaleFile(dir, name, stat);
  } finally {
    await restoreTimes(dir);
  }
  return rmdirIfEmpty(root.resolve(id));
}

/**
 * A directory without stopped.json is left by a prune that stopped before
 * rmdir, or rebuilt by a first permit or lease caller that stalled past
 * teardown and prune. With no record or lock, it goes once it and every entry
 * are past the horizon and hold only stale coordination files. The directory
 * mtime is the last entry change, after teardown in both cases.
 */
async function pruneCoordinationDirectory(root: DirHandle, dir: DirHandle, id: string, roots: string[]): Promise<boolean> {
  if (!isOld(dir.stat)) return false;
  const names = await entriesIfPresent(dir);
  if (names === undefined) return false;
  const files: StaleFiles = [];
  for (const name of names.filter((name) => name !== "permits")) {
    const stat = await staleCoordinationFile(dir, name, LEASE_RECORD, LEASE_TEMP);
    if (stat === undefined) return false;
    files.push([name, stat]);
  }
  if (!names.includes("permits")) return removeCoordinationDirectory(root, dir, id, roots, files);
  if ((await dir.lstatChild("permits"))?.isDirectory() !== true) return false;
  return withChildIfPresent(dir, "permits", async (permits) => {
    const permitFiles = await stalePermitFiles(permits);
    return permitFiles !== undefined && removeCoordinationDirectory(root, dir, id, roots, files, [permits, permitFiles]);
  });
}

/** The files prune checked in a retained directory, and its teardown time. */
type Retained = { files: StaleFiles; stoppedAt: number };

async function removeRetainedDirectory(
  root: DirHandle, dir: DirHandle, id: string, roots: string[],
  { files, stoppedAt }: Retained, permits?: [DirHandle, StaleFiles],
): Promise<boolean> {
  if (await registryHasSession(id, roots)) return false;
  const current = await root.lstatChild(id);
  if (current?.dev !== dir.stat.dev || current.ino !== dir.stat.ino) return false;
  if (permits !== undefined && !await removePermits(dir, ...permits)) return false;
  await carryStoppedAt(root, id, stoppedAt);
  // stopped.json goes last, so a prune that stops midway leaves the next one
  // the teardown time. A file replaced since its check is not removed.
  for (const [name, stat] of files.filter(([name]) => name !== MARKER)) await unlinkStaleFile(dir, name, stat);
  // An entry that arrived meanwhile keeps the teardown time for a later prune.
  if ((await entriesIfPresent(dir))?.some((name) => name !== MARKER) === true) return false;
  for (const [name, stat] of files.filter(([name]) => name === MARKER)) await unlinkStaleFile(dir, name, stat);
  // The sibling markers stay until the horizon: late callers for this id
  // keep failing closed, and createSession never reuses a reserved id.
  return rmdirIfEmpty(root.resolve(id));
}

// An abandoned removal that could not go back, because a writer took its name
// again, counts as the retained file it was.
function isRetainedFileName(name: string): boolean {
  const original = abandonedRemoval(name) ?? name;
  return original === MARKER || LOG_FILE.test(original);
}

async function pruneDirectory(root: DirHandle, id: string, roots: string[], age: number): Promise<boolean> {
  if (await registryHasSession(id, roots)) return false;
  return withChildIfPresent(root, id, async (dir) => {
    const stoppedAt = await retainedStoppedAt(dir, id) ?? await restoredStoppedAt(dir, id);
    if (stoppedAt === undefined) return pruneCoordinationDirectory(root, dir, id, roots);
    if (Date.now() - stoppedAt < age) return false;
    const names = await entriesAfterRestore(dir);
    if (names === undefined) return false;
    const files: StaleFiles = [];
    // Unknown data is not ours to delete. Never traverse a child directory or link.
    for (const name of names.filter((name) => name !== "permits")) {
      if (!isRetainedFileName(name)) return false;
      const stat = await dir.lstatChild(name);
      if (stat?.isFile() !== true) return false;
      files.push([name, stat]);
    }
    if (files.length === names.length) return removeRetainedDirectory(root, dir, id, roots, { files, stoppedAt });
    // A first permit caller that stalled only through teardown builds permits/
    // in the retained directory, then fails closed.
    if ((await dir.lstatChild("permits"))?.isDirectory() !== true) return false;
    return withChildIfPresent(dir, "permits", async (permits) => {
      const permitFiles = await stalePermitFiles(permits);
      return permitFiles !== undefined &&
        removeRetainedDirectory(root, dir, id, roots, { files, stoppedAt }, [permits, permitFiles]);
    });
  });
}

/**
 * The staging file names no writer, so age alone decides. Its writer links it
 * right after the write; a writer that stalls past the horizon and then finds
 * it gone fails on the link and publishes nothing.
 */
async function staleIdentityStaging(root: DirHandle, name: string): Promise<fs.Stats | undefined> {
  const temp = IDENTITY_TEMP.exec(name);
  if (temp === null && !IDENTITY_STAGING.test(name)) return undefined;
  const stat = await root.lstatChild(name);
  if (stat?.isFile() !== true || !isOld(stat)) return undefined;
  return temp !== null && isPidAlive(Number(temp[1])) ? undefined : stat;
}

async function sessionEntryExists(id: string, roots: string[]): Promise<boolean> {
  for (const root of roots) {
    for (const name of [`${id}.json`, id, `${id}.ensure-vnc.lock`]) {
      try {
        await fs.promises.lstat(path.join(root, name));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  return false;
}

// A record, a teardown lock or a data directory means teardown is pending,
// interrupted or retained. The reaper finds interrupted work by its marker.
async function pruneMarkers(root: DirHandle, id: string, roots: string[]): Promise<void> {
  if (await sessionEntryExists(id, roots)) return;
  const markers: Array<[string, fs.Stats]> = [];
  for (const name of markerNames(id)) {
    const stat = await root.lstatChild(name);
    if (stat === undefined) continue;
    if (!stat.isFile() || Date.now() - stat.mtimeMs < SESSION_MARKER_HORIZON_MS) return;
    markers.push([name, stat]);
  }
  if (await sessionEntryExists(id, roots)) return;
  for (const [name, stat] of markers) await unlinkStaleFile(root, name, stat);
}

/**
 * Explicit only. Active/error records and unmarked legacy directories are kept.
 * A directory without stopped.json that holds only stale coordination files
 * goes after the horizon.
 * Markers of a gone session go once they are older than the horizon.
 * So do takeover identity staging files a killed writer left.
 */
export async function pruneSessionLogs(
  olderThanMs: number,
  env: EnvLike = process.env,
): Promise<string[]> {
  if (!Number.isSafeInteger(olderThanMs) || olderThanMs < 0) throw new Error("Invalid retention age");
  const roots = [...new Set([sessionsDir(env), ...legacySessionsDirs(env)])];
  const pruned: string[] = [];
  for (const rootPath of roots) {
    if (!fs.existsSync(rootPath)) continue;
    await withDirHandle(DirHandle.open(rootPath), async (root) => {
      let names = await root.readEntryNames();
      if (await restoreAbandonedRemovals(root, names)) names = await root.readEntryNames();
      for (const id of names) {
        if (!SESSION_ID.test(id)) continue;
        if ((await root.lstatChild(id))?.isDirectory() !== true) continue;
        if (await pruneDirectory(root, id, roots, olderThanMs)) pruned.push(id);
      }
      // After the directories, so a pruned one has carried its teardown time.
      const markerIds = new Set(names.flatMap((name) => SESSION_MARKER.exec(name)?.[1] ?? []));
      for (const id of markerIds) await pruneMarkers(root, id, roots);
      for (const name of names) {
        const stat = await staleIdentityStaging(root, name);
        if (stat !== undefined) await unlinkStaleFile(root, name, stat);
      }
    });
  }
  return pruned;
}
