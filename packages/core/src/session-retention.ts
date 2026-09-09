import fs from "node:fs";
import path from "node:path";
import { DirHandle, withDirHandle } from "./dir-handle.js";
import { legacySessionsDirs, sessionsDir, type EnvLike } from "./paths.js";
import { sessionDataDir, type SessionRecord } from "./session.js";

const MARKER = "stopped.json";
const SESSION_ID = /^(desk|andr|duo|brow)-[0-9a-f]{6,}$/;
const LOG_FILE = /^[^.].*\.log$/;

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

async function retainedAge(dir: DirHandle, id: string): Promise<number | undefined> {
  const stat = await dir.lstatChild(MARKER);
  if (stat?.isFile() !== true) return undefined;
  const file = await dir.openFile(MARKER, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const marker = JSON.parse(await file.readFile("utf8"));
    if (marker.id !== id || typeof marker.stoppedAt !== "string") return undefined;
    const stoppedAt = Date.parse(marker.stoppedAt);
    return Number.isFinite(stoppedAt) ? Date.now() - stoppedAt : undefined;
  } catch {
    return undefined;
  } finally {
    await file.close();
  }
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

async function pruneDirectory(root: DirHandle, id: string, roots: string[], age: number): Promise<boolean> {
  if (await registryHasSession(id, roots)) return false;
  return withDirHandle(root.openChild(id), async (dir) => {
    const elapsed = await retainedAge(dir, id);
    if (elapsed === undefined || elapsed < age) return false;
    const names = await dir.readEntryNames();
    // Unknown data is not ours to delete. Never traverse a child directory or link.
    for (const name of names) {
      if (name !== MARKER && !LOG_FILE.test(name)) return false;
      if ((await dir.lstatChild(name))?.isFile() !== true) return false;
    }
    if (await registryHasSession(id, roots)) return false;
    for (const name of names.filter((name) => name !== MARKER)) await dir.unlinkChild(name);
    await dir.unlinkChild(MARKER);
    await fs.promises.rmdir(root.resolve(id));
    return true;
  });
}

/** Explicit only. Active/error records and unmarked legacy directories are kept. */
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
      for (const id of await root.readEntryNames()) {
        if (!SESSION_ID.test(id)) continue;
        if ((await root.lstatChild(id))?.isDirectory() !== true) continue;
        if (await pruneDirectory(root, id, roots, olderThanMs)) pruned.push(id);
      }
    });
  }
  return pruned;
}
