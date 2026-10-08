import crypto from "node:crypto";
import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { DirHandle, RunStorageAccessError, withDirHandle } from "./dir-handle.js";
import { ensureDir, legacySessionsDirs, sessionsDir, type EnvLike } from "./paths.js";
import { identityIsAlive, readProcessStartTicks } from "./proc.js";

const OWNER = "owner";
const LOCK_TIMEOUT_MS = 5_000;
const STAGE_MAX_AGE_MS = 60_000;
const STAGE_NAME = /^\.(?:desk|andr|duo|brow)-[0-9a-f]{6,}\.gate-stage-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const OWNER_TEMP = /^\.owner\.tmp-([0-9]+)-[0-9]+$/;

export class SessionInputClosedError extends Error {
  constructor(id: string) {
    super(`Session ${id} is not running: input is permanently closed; takeover coordination is unavailable`);
    this.name = "SessionInputClosedError";
  }
}

export function sessionInputClosedName(id: string): string {
  return `.${id}.input-closed`;
}

export async function assertSessionInputOpen(root: DirHandle, id: string): Promise<void> {
  if (await root.lstatChild(sessionInputClosedName(id)) !== undefined) throw new SessionInputClosedError(id);
}

async function removeEmptyDirectory(root: DirHandle, name: string): Promise<void> {
  try { await fs.promises.rmdir(root.resolve(name)); }
  catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

async function sweepDeadLock(root: DirHandle, name: string): Promise<void> {
  if (await root.lstatChild(name) === undefined) return;
  let held: DirHandle;
  try { held = await root.openChild(name); }
  catch (error) {
    const current = await root.lstatChild(name);
    if (error instanceof RunStorageAccessError && (current === undefined || current.isDirectory())) return;
    throw error;
  }
  await withDirHandle(Promise.resolve(held), async (lock) => {
    const file = await lock.lstatChild(OWNER);
    if (file !== undefined) {
      let handle: fs.promises.FileHandle;
      try { handle = await lock.openFile(OWNER, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      let owner;
      try { owner = JSON.parse(await handle.readFile("utf8")); }
      finally { await handle.close(); }
      if (typeof owner.ownerPid !== "number") throw new Error("Invalid session gate lock owner");
      if (owner.released !== true && identityIsAlive(owner.ownerPid, owner.ownerStartTicks)) return;
      await lock.unlinkChild(OWNER);
    }
    // A successor is published with its owner already present. This rmdir can
    // remove only an empty, released lock, never a successor's live lock.
    await removeEmptyDirectory(root, name);
  });
}

async function publishLock(root: DirHandle, stage: string, name: string): Promise<void> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await fs.promises.rename(root.resolve(stage), root.resolve(name));
      return;
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    await sweepDeadLock(root, name);
    if (Date.now() >= deadline) throw new Error("Timed out waiting for session gate lock");
    await delay(5);
  }
}

async function stageOwnerIsDead(stage: DirHandle): Promise<boolean> {
  if ((await stage.lstatChild(OWNER))?.isFile() === true) {
    const file = await stage.openFile(OWNER, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const owner = JSON.parse(await file.readFile("utf8"));
      return typeof owner.ownerPid === "number" && (owner.released === true || !identityIsAlive(owner.ownerPid, owner.ownerStartTicks));
    } finally { await file.close(); }
  }
  // An empty or partly written stage has no published owner yet. Leave fresh
  // stages and temp files belonging to live processes alone.
  if (Date.now() - stage.stat.mtimeMs < STAGE_MAX_AGE_MS) return false;
  for (const name of await stage.readEntryNames()) {
    const match = OWNER_TEMP.exec(name);
    if (match === null || identityIsAlive(Number(match[1]), undefined)) return false;
  }
  return true;
}

async function removeAbandonedStage(root: DirHandle, name: string): Promise<void> {
  if ((await root.lstatChild(name))?.isDirectory() !== true) return;
  await withDirHandle(root.openChild(name), async (stage) => {
    if (!await stageOwnerIsDead(stage)) return;
    const entries = await stage.readEntryNames();
    for (const entry of entries) {
      if (entry !== OWNER && !OWNER_TEMP.test(entry)) return;
      const stat = await stage.lstatChild(entry);
      if (stat !== undefined && !stat.isFile() && !stat.isSymbolicLink()) return;
    }
    for (const entry of entries) await stage.unlinkChild(entry);
    await removeEmptyDirectory(root, name);
  });
}

/** Reclaim only gate stages from dead owners or old, unfinished writes. */
export async function sweepSessionGateStages(root: DirHandle, id?: string): Promise<void> {
  for (const name of await root.readEntryNames()) {
    if (!STAGE_NAME.test(name) || id !== undefined && !name.startsWith(`.${id}.gate-stage-`)) continue;
    // A peer can publish or reclaim the stage between listing and opening it.
    await removeAbandonedStage(root, name).catch((error) => {
      if (error instanceof RunStorageAccessError || (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    });
  }
}

async function releaseOwner(lock: DirHandle): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { await lock.unlinkChild(OWNER); return; }
    catch { if (attempt < 2) await delay(5); }
  }
  // If unlink remains unavailable, record that this operation has finished.
  // A later acquirer can sweep it even while this process remains alive.
  await lock.writeFileAtomic(OWNER, JSON.stringify({ ownerPid: process.pid, released: true })).catch(() => {});
}

/** Serialize short registry writes, coordination initialization and gate closure. */
export async function withSessionGate<T>(id: string, rootPath: string, action: (root: DirHandle) => Promise<T>): Promise<T> {
  await ensureDir(rootPath);
  const root = await DirHandle.open(rootPath);
  try {
    await sweepSessionGateStages(root, id);
    const stage = `.${id}.gate-stage-${crypto.randomUUID()}`;
    const name = `.${id}.gate-lock`;
    const lock = await root.ensureChildDir(stage, 0o700);
    let published = false;
    try {
      await lock.writeFileAtomic(OWNER, JSON.stringify({ ownerPid: process.pid, ownerStartTicks: readProcessStartTicks(process.pid) }));
      // Rename publishes a complete, nonempty directory. A live lock cannot
      // be replaced because rename refuses to overwrite nonempty directories.
      await publishLock(root, stage, name);
      published = true;
      return await action(root);
    } finally {
      // Cleanup must not lose the result or descriptors returned by action.
      await releaseOwner(lock);
      await removeEmptyDirectory(root, published ? name : stage).catch(() => {});
      await lock.close().catch(() => {});
    }
  } finally { await root.close().catch(() => {}); }
}

export async function closeSessionInput(id: string, rootPath: string): Promise<void> {
  await withSessionGate(id, rootPath, async (root) => {
    try {
      const file = await root.openFile(sessionInputClosedName(id), "wx", 0o600);
      await file.close().catch(() => {});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  });
}

/** Read-only gate check; diagnostic readers do not initialize registry storage. */
export async function checkSessionInputOpen(id: string, env: EnvLike): Promise<void> {
  for (const rootPath of [sessionsDir(env), ...legacySessionsDirs(env)]) {
    if (fs.existsSync(rootPath)) await withDirHandle(DirHandle.open(rootPath), (root) => assertSessionInputOpen(root, id));
  }
}

export async function sessionInputIsClosed(id: string, env: EnvLike): Promise<boolean> {
  try { await checkSessionInputOpen(id, env); return false; }
  catch (error) { if (error instanceof SessionInputClosedError) return true; throw error; }
}
