import crypto from "node:crypto";
import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { DirHandle, RunStorageAccessError, withDirHandle } from "./dir-handle.js";
import { ensureDir, legacySessionsDirs, sessionsDir, type EnvLike } from "./paths.js";
import { identityIsAlive, readProcessStartTicks } from "./proc.js";

const OWNER = "owner";
const LOCK_TIMEOUT_MS = 5_000;

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
      if (identityIsAlive(owner.ownerPid, owner.ownerStartTicks)) return;
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

/** Serialize short registry writes, coordination initialization and gate closure. */
export async function withSessionGate<T>(id: string, rootPath: string, action: (root: DirHandle) => Promise<T>): Promise<T> {
  await ensureDir(rootPath);
  const root = await DirHandle.open(rootPath);
  try {
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
      await lock.unlinkChild(OWNER).catch(() => {});
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
