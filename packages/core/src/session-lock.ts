import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import type { EnvLike } from "./paths.js";
import { isPidAlive } from "./proc.js";
import { getSession, sessionDataDir } from "./session.js";

/**
 * How long a caller waits for a live holder of the session VNC lock. A holder
 * that dies is detected and replaced at once, whatever this bound. Viewer
 * bridge startup holds the lock until the bridge reports ready, which can
 * take over a minute on a busy host (#301), so this bound covers it.
 */
export const SESSION_VNC_LOCK_TIMEOUT_MS = 90_000;
const VNC_LOCK_POLL_MS = 25;

interface VncLockOwner {
  pid: number;
  token: string;
}

function errorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

async function readVncLockOwner(lockPath: string): Promise<VncLockOwner | null> {
  try {
    const value: unknown = JSON.parse(
      await fs.promises.readFile(lockPath, "utf8"),
    );
    if (
      typeof value === "object" &&
      value !== null &&
      "pid" in value &&
      typeof value.pid === "number" &&
      Number.isInteger(value.pid) &&
      "token" in value &&
      typeof value.token === "string"
    ) {
      return { pid: value.pid, token: value.token };
    }
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
  }
  return null;
}

async function releaseVncLock(lockPath: string, token: string): Promise<void> {
  const current = await readVncLockOwner(lockPath);
  if (current?.token === token) {
    const confirmed = await readVncLockOwner(lockPath);
    if (confirmed?.token === token) {
      await fs.promises.unlink(lockPath).catch(() => {});
    }
  }
  await fs.promises.unlink(`${lockPath}.${token}`).catch(() => {});
}

async function breakStaleVncLock(
  lockPath: string,
  owner: VncLockOwner,
): Promise<boolean> {
  try {
    await fs.promises.unlink(`${lockPath}.${owner.token}`);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
  const confirmed = await readVncLockOwner(lockPath);
  if (confirmed?.token !== owner.token) return false;
  try {
    await fs.promises.unlink(lockPath);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function throwIfSessionGone(
  id: string,
  registryEnv: EnvLike,
): Promise<void> {
  if ((await getSession(id, registryEnv)) === undefined) {
    throw new Error(`Session not found: ${id}`);
  }
}


export interface SessionVncLockOptions {
  /** Stops the wait for the lock and skips the locked operation once aborted. */
  signal?: AbortSignal;
}

function throwIfLockWaitCancelled(id: string, signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new Error(`Cancelled while waiting for the VNC lock of session ${id}`);
  }
}

async function waitForVncLockPoll(id: string, signal: AbortSignal | undefined): Promise<void> {
  try {
    await sleep(VNC_LOCK_POLL_MS, undefined, signal === undefined ? undefined : { signal });
  } catch (error) {
    throwIfLockWaitCancelled(id, signal);
    throw error;
  }
}

async function acquireSessionVncLock(
  id: string,
  registryEnv: EnvLike,
  signal: AbortSignal | undefined,
): Promise<() => Promise<void>> {
  throwIfLockWaitCancelled(id, signal);
  const registryDir = path.dirname(sessionDataDir(id, registryEnv));
  await fs.promises.mkdir(registryDir, { recursive: true });
  const lockPath = path.join(registryDir, `${id}.ensure-vnc.lock`);
  const owner = { pid: process.pid, token: randomUUID() };
  const sentinelPath = `${lockPath}.${owner.token}`;
  await fs.promises.writeFile(sentinelPath, JSON.stringify(owner), {
    flag: "wx",
  });
  const deadline = Date.now() + SESSION_VNC_LOCK_TIMEOUT_MS;
  let acquired = false;

  try {
    while (true) {
      try {
        const handle = await fs.promises.open(lockPath, "wx");
        try {
          await handle.writeFile(JSON.stringify(owner), "utf8");
        } finally {
          await handle.close();
        }
        acquired = true;
        return () => releaseVncLock(lockPath, owner.token);
      } catch (error) {
        const code = errorCode(error);
        if (code === "ENOENT") {
          await throwIfSessionGone(id, registryEnv);
          await waitForVncLockPoll(id, signal);
          continue;
        }
        if (code !== "EEXIST") throw error;
      }

      const current = await readVncLockOwner(lockPath);
      if (
        current !== null &&
        !isPidAlive(current.pid) &&
        (await breakStaleVncLock(lockPath, current))
      ) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting to ensure VNC for session ${id}`);
      }
      await waitForVncLockPoll(id, signal);
    }
  } finally {
    if (!acquired) {
      await fs.promises.unlink(sentinelPath).catch(() => {});
    }
  }
}

export async function withSessionVncLock<T>(
  id: string,
  registryEnv: EnvLike,
  operation: () => Promise<T>,
  options: SessionVncLockOptions = {},
): Promise<T> {
  const releaseLock = await acquireSessionVncLock(id, registryEnv, options.signal);
  try {
    throwIfLockWaitCancelled(id, options.signal);
    return await operation();
  } finally {
    await releaseLock();
  }
}
