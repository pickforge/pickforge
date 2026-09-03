import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import {
  REAPER_CLEANUP_PENDING_META_KEY,
  clearStaleHumanLease,
  createSession,
  destroySessionRecord,
  getSession,
  isHumanLeaseStale,
  isPidAlive,
  processIdentityMatches,
  reapDeadRunningSessions,
  readHumanLease,
  readHumanLeaseRaw,
  recordTakeoverEvidence,
  sessionsDir,
  stopPid,
  stopProcessGroupVerified,
  updateSession,
  type DesktopSessionInfo,
  type EnvLike,
  type LocalSessionTeardownFinalizer,
  type SessionRecord,
} from "@pickforge/lab-core";
import {
  XvfbStartError,
  isDisplayAlive,
  startXvfb,
  type XvfbHandle,
  type XvfbPartialStart,
} from "./display.js";
import { detectVncBinary, startVnc, type VncHandle } from "./vnc.js";

export interface CreateDesktopSessionOptions {
  projectDir: string;
  registryEnv?: EnvLike;
  env?: EnvLike;
  width?: number;
  height?: number;
  vnc?: boolean;
  vncControl?: boolean;
}

export interface DesktopSessionHandle {
  id: string;
  display: string;
  xvfbPid: number;
  vncPid?: number;
  vncStartTimeTicks?: number;
  vncPort?: number;
  vncViewOnly?: boolean;
  logDir: string;
}

export interface DesktopSessionStatus {
  record: SessionRecord;
  xvfbAlive: boolean;
  vncAlive: boolean;
  displayAlive: boolean;
}

export interface EnsureSessionVncOptions {
  registryEnv?: EnvLike;
  env?: EnvLike;
}

export interface EnsuredSessionVnc {
  pid: number;
  port: number;
  reused: boolean;
}

export function desktopSessionLogDir(
  id: string,
  registryEnv: EnvLike = process.env,
): string {
  return path.join(sessionsDir(registryEnv), id);
}

// eslint-disable-next-line max-lines-per-function, complexity -- Legacy gate debt: pickforge/pickforge#60
export async function createDesktopSession(
  opts: CreateDesktopSessionOptions,
): Promise<DesktopSessionHandle> {
  const registryEnv = opts.registryEnv ?? process.env;
  const wantsVnc = opts.vnc === true || opts.vncControl === true;
  if (
    wantsVnc &&
    detectVncBinary({ ...process.env, ...opts.env }) === null
  ) {
    throw new Error(
      "VNC was requested but x11vnc was not found on PATH; install x11vnc to enable it",
    );
  }
  await reapDeadRunningSessions(registryEnv, {
    desktop: {
      teardown: (id, finalize) =>
        teardownDesktopSession(id, registryEnv, finalize),
    },
  });
  const record = await createSession(
    { type: "desktop", projectDir: opts.projectDir },
    registryEnv,
  );
  const logDir = desktopSessionLogDir(record.id, registryEnv);

  let xvfb: XvfbHandle | undefined;
  let xvfbPartial: XvfbPartialStart | undefined;
  let xvfbStartTimeTicks: number | undefined;
  let vnc: VncHandle | undefined;
  try {
    try {
      xvfb = await startXvfb({
        width: opts.width,
        height: opts.height,
        logDir,
        env: opts.env,
        onSpawn: async (partial) => {
          xvfbPartial = partial;
          await updateSession(
            record.id,
            {
              desktop: {
                display: partial.display,
                xvfbPid: partial.pid,
                xvfbStartTimeTicks: partial.startTimeTicks,
                width: partial.width,
                height: partial.height,
              },
            },
            registryEnv,
          );
        },
      });
    } catch (error) {
      if (error instanceof XvfbStartError && error.partial !== undefined) {
        xvfbPartial = error.partial;
      }
      throw error;
    }
    xvfbStartTimeTicks = xvfb.startTimeTicks;
    if (wantsVnc) {
      vnc = await startVnc({
        display: xvfb.display,
        logDir,
        env: opts.env,
        viewOnly: opts.vncControl !== true,
      });
    }

    const desktop: DesktopSessionInfo = {
      display: xvfb.display,
      xvfbPid: xvfb.pid,
      xvfbStartTimeTicks,
      width: xvfb.width,
      height: xvfb.height,
    };
    if (vnc !== undefined) {
      desktop.vncPid = vnc.pid;
      desktop.vncStartTimeTicks = vnc.startTimeTicks;
      desktop.vncPort = vnc.port;
      desktop.vncViewOnly = opts.vncControl !== true;
    }
    await updateSession(record.id, { status: "running", desktop }, registryEnv);

    const handle: DesktopSessionHandle = {
      id: record.id,
      display: xvfb.display,
      xvfbPid: xvfb.pid,
      logDir,
    };
    if (vnc !== undefined) {
      handle.vncPid = vnc.pid;
      handle.vncStartTimeTicks = vnc.startTimeTicks;
      handle.vncPort = vnc.port;
      handle.vncViewOnly = opts.vncControl !== true;
    }
    return handle;
  } catch (error) {
    let vncGone = vnc === undefined;
    if (vnc !== undefined) {
      vncGone = await stopOwnedSessionVnc(record.id, {
        display: xvfb?.display ?? xvfbPartial?.display ?? ":0",
        vncPid: vnc.pid,
        vncStartTimeTicks: vnc.startTimeTicks,
      })
        .then(() => true)
        .catch(() => false);
    }
    let xvfbGone =
      xvfb === undefined
        ? (xvfbPartial?.cleanupConfirmed ?? true)
        : false;
    if (xvfb !== undefined && xvfbStartTimeTicks !== undefined) {
      try {
        const result = await stopProcessGroupVerified({
          pid: xvfb.pid,
          startTicks: xvfbStartTimeTicks,
        });
        xvfbGone =
          result.outcome === "terminated" || result.outcome === "already-dead";
      } catch {
        xvfbGone = false;
      }
    }
    const cleanupComplete = vncGone && xvfbGone;
    const knownXvfb = xvfb ?? xvfbPartial;
    const knownXvfbStartTimeTicks =
      knownXvfb !== undefined && xvfbPartial?.pid === knownXvfb.pid
        ? xvfbPartial.startTimeTicks
        : xvfbStartTimeTicks;
    const clearedMeta = { ...record.meta };
    delete clearedMeta[REAPER_CLEANUP_PENDING_META_KEY];
    await updateSession(
      record.id,
      cleanupComplete
        ? { status: "error", desktop: undefined, meta: clearedMeta }
        : {
            status: "error",
            meta: {
              ...record.meta,
              [REAPER_CLEANUP_PENDING_META_KEY]: true,
            },
            ...(knownXvfb === undefined
              ? {}
              : {
                  desktop: {
                    display: knownXvfb.display,
                    xvfbPid: knownXvfb.pid,
                    ...(knownXvfbStartTimeTicks === undefined
                      ? {}
                      : { xvfbStartTimeTicks: knownXvfbStartTimeTicks }),
                    ...(vnc === undefined
                      ? {}
                      : {
                          vncPid: vnc.pid,
                          vncStartTimeTicks: vnc.startTimeTicks,
                        }),
                    width: knownXvfb.width,
                    height: knownXvfb.height,
                  },
                }),
          },
      registryEnv,
    ).catch(() => {});
    throw error;
  }
}

const VNC_LOCK_TIMEOUT_MS = 10_000;
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

async function acquireSessionVncLock(
  id: string,
  registryEnv: EnvLike,
): Promise<() => Promise<void>> {
  const registryDir = sessionsDir(registryEnv);
  await fs.promises.mkdir(registryDir, { recursive: true });
  const lockPath = path.join(registryDir, `${id}.ensure-vnc.lock`);
  const owner = { pid: process.pid, token: randomUUID() };
  const sentinelPath = `${lockPath}.${owner.token}`;
  await fs.promises.writeFile(sentinelPath, JSON.stringify(owner), {
    flag: "wx",
  });
  const deadline = Date.now() + VNC_LOCK_TIMEOUT_MS;
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
          // eslint-disable-next-line max-depth -- Legacy gate debt: pickforge/pickforge#60
          if ((await getSession(id, registryEnv)) === undefined) {
            throw new Error(`Session not found: ${id}`);
          }
          await sleep(VNC_LOCK_POLL_MS);
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
      await sleep(VNC_LOCK_POLL_MS);
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
): Promise<T> {
  const releaseLock = await acquireSessionVncLock(id, registryEnv);
  try {
    return await operation();
  } finally {
    await releaseLock();
  }
}

export async function stopOwnedSessionVnc(
  id: string,
  desktop: DesktopSessionInfo | undefined,
): Promise<void> {
  const pid = desktop?.vncPid;
  if (pid === undefined) return;
  const startTicks = desktop?.vncStartTimeTicks;
  if (startTicks === undefined) {
    if (isPidAlive(pid)) {
      throw new Error(
        `Refusing to stop x11vnc (pid ${pid}) for ${id}: process identity is unavailable`,
      );
    }
    return;
  }
  if (!processIdentityMatches({ pid, startTicks })) {
    if (isPidAlive(pid)) {
      throw new Error(
        `Refusing to stop x11vnc (pid ${pid}) for ${id}: process identity does not match`,
      );
    }
    return;
  }
  if (!(await stopPid(pid))) {
    throw new Error(`x11vnc (pid ${pid}) survived SIGTERM and SIGKILL`);
  }
}

/**
 * Recover a session left with a writable VNC server by a takeover whose
 * owner process is gone (crash) or whose heartbeat lapsed (stale TTL): stop
 * the recorded writable VNC, clear its record, record a `takeover_recovered`
 * evidence entry, and release the stale lease. A *live* lease is left
 * untouched — this only reclaims genuinely stale state. Exported for
 * `@pickforge/lab-desktop-linux`'s `takeover.ts` (a sibling module,
 * imported one-directionally from here to avoid a cycle since `takeover.ts`
 * already depends on this file's VNC primitives). Assumes the caller already
 * holds the session's VNC lock (`withSessionVncLock`).
 */
export async function recoverStaleTakeoverLocked(
  id: string,
  record: SessionRecord,
  registryEnv: EnvLike,
): Promise<{ recovered: boolean }> {
  const initial = await readHumanLease(id, registryEnv);
  if (initial === undefined) return { recovered: false };
  if (!isHumanLeaseStale(initial)) return { recovered: false };

  // TOCTOU guard (pickforge/pickforge#21 P1-C): the cheap check above can be
  // arbitrarily stale by the time we act — a live owner's heartbeat may have
  // renewed the lease in the gap. Re-read immediately before the destructive
  // VNC stop and re-check staleness on THAT read; a lease that is no longer
  // stale (renewed) is left completely untouched. `leaseId` alone cannot
  // detect a renewal (it never changes), so the final release below
  // compare-and-deletes on the exact raw bytes captured here, not just the id.
  const snapshot = await readHumanLeaseRaw(id, registryEnv);
  if (snapshot === undefined) return { recovered: false };
  if (snapshot.lease !== undefined && !isHumanLeaseStale(snapshot.lease)) {
    return { recovered: false };
  }

  const desktop = record.desktop;
  if (desktop !== undefined && desktop.vncPid !== undefined && desktop.vncViewOnly !== true) {
    await stopOwnedSessionVnc(id, desktop).catch(() => {});
    await updateSession(
      id,
      {
        desktop: {
          ...desktop,
          vncPid: undefined,
          vncStartTimeTicks: undefined,
          vncViewOnly: undefined,
        },
      },
      registryEnv,
    ).catch(() => {});
  }

  await recordTakeoverEvidence(record.projectDir, id, "takeover_recovered", {
    env: registryEnv,
    status: "error",
  });

  // Compare-and-delete on the exact bytes captured at the final stale check
  // above, not merely `leaseId` (which a renewal never changes). If the file
  // changed again since — another renewal slipped in during the VNC stop
  // itself — it is left alone rather than deleted out from under a possibly
  // now-live claim. The VNC-stop decision above was correct at the instant it
  // was made (two consecutive stale reads); this bounds the residual race to
  // the width of `stopOwnedSessionVnc` alone, down from the whole function.
  await clearStaleHumanLease(id, snapshot.raw, registryEnv);
  return { recovered: true };
}

export async function ensureSessionVnc(
  id: string,
  opts: EnsureSessionVncOptions = {},
): Promise<EnsuredSessionVnc> {
  const registryEnv = opts.registryEnv ?? process.env;
  if ((await getSession(id, registryEnv)) === undefined) {
    throw new Error(`Session not found: ${id}`);
  }
  // eslint-disable-next-line complexity -- Legacy gate debt: pickforge/pickforge#60
  return withSessionVncLock(id, registryEnv, async () => {
    let record = await getSession(id, registryEnv);
    if (record === undefined) {
      throw new Error(`Session not found: ${id}`);
    }
    let desktop = record.desktop;
    if (desktop?.display === undefined) {
      throw new Error(`Session ${id} is not desktop-capable`);
    }
    if (record.status !== "running") {
      throw new Error(`Session ${id} is not running`);
    }
    if (desktop.vncPid !== undefined && isPidAlive(desktop.vncPid)) {
      if (desktop.vncStartTimeTicks === undefined) {
        throw new Error(
          `Refusing to reuse x11vnc (pid ${desktop.vncPid}) for ${id}: process identity is unavailable`,
        );
      }
      if (
        !processIdentityMatches({
          pid: desktop.vncPid,
          startTicks: desktop.vncStartTimeTicks,
        })
      ) {
        throw new Error(
          `Refusing to reuse x11vnc (pid ${desktop.vncPid}) for ${id}: process identity does not match`,
        );
      }
      if (desktop.vncViewOnly !== true) {
        // A writable VNC left running by a takeover whose owner is dead or
        // whose heartbeat lapsed is recoverable: revert it to read-only and
        // fall through to the normal ensure flow below. A *live* human lease
        // is never touched — `recovered: false` keeps the original refusal.
        const { recovered } = await recoverStaleTakeoverLocked(id, record, registryEnv);
        if (!recovered) {
          throw new Error(
            `Session ${id} has an active writable VNC server; watch requires server-enforced read-only VNC`,
          );
        }
        record = await getSession(id, registryEnv);
        if (record === undefined) {
          throw new Error(`Session not found: ${id}`);
        }
        desktop = record.desktop;
        if (desktop?.display === undefined) {
          throw new Error(`Session ${id} is not desktop-capable`);
        }
      } else {
        if (desktop.vncPort === undefined) {
          throw new Error(
            `Session ${id} has an active VNC server with no port recorded`,
          );
        }
        return { pid: desktop.vncPid, port: desktop.vncPort, reused: true };
      }
    }

    const vnc = await startVnc({
      display: desktop.display,
      port: desktop.vncPort,
      logDir: desktopSessionLogDir(id, registryEnv),
      env: opts.env,
      viewOnly: true,
    });
    try {
      await updateSession(
        id,
        {
          desktop: {
            ...desktop,
            vncPid: vnc.pid,
            vncStartTimeTicks: vnc.startTimeTicks,
            vncPort: vnc.port,
            vncViewOnly: true,
          },
        },
        registryEnv,
      );
    } catch (error) {
      await stopOwnedSessionVnc(id, {
        display: desktop.display,
        vncPid: vnc.pid,
        vncStartTimeTicks: vnc.startTimeTicks,
      }).catch(() => {});
      throw error;
    }
    return { pid: vnc.pid, port: vnc.port, reused: false };
  });
}

export async function teardownDesktopSession(
  id: string,
  registryEnv: EnvLike,
  finalize: LocalSessionTeardownFinalizer,
): Promise<void> {
  if ((await getSession(id, registryEnv)) === undefined) {
    throw new Error(`Desktop session not found: ${id}`);
  }
  await withSessionVncLock(id, registryEnv, async () => {
    const record = await getSession(id, registryEnv);
    if (record === undefined) {
      throw new Error(`Desktop session not found: ${id}`);
    }
    const desktop = record.desktop;
    const failures: Error[] = [];
    try {
      await stopOwnedSessionVnc(id, desktop);
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }

    const xvfbPid = desktop?.xvfbPid;
    const xvfbStartTimeTicks = desktop?.xvfbStartTimeTicks;
    if (xvfbPid !== undefined) {
      if (xvfbStartTimeTicks === undefined) {
        if (isPidAlive(xvfbPid)) {
          failures.push(
            new Error(
              `Refusing to stop Xvfb (pid ${xvfbPid}): process identity is unavailable`,
            ),
          );
        }
      } else {
        try {
          const result = await stopProcessGroupVerified({
            pid: xvfbPid,
            startTicks: xvfbStartTimeTicks,
          });
          if (
            result.outcome !== "terminated" &&
            result.outcome !== "already-dead"
          ) {
            failures.push(
              new Error(
                `Xvfb process group (pid ${xvfbPid}) could not be verified as gone`,
              ),
            );
          }
        } catch (error) {
          failures.push(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }
    }
    if (failures.length > 0) {
      await updateSession(
        id,
        {
          status: "error",
          meta: {
            ...record.meta,
            [REAPER_CLEANUP_PENDING_META_KEY]: true,
          },
        },
        registryEnv,
      ).catch(() => {});
      throw new AggregateError(
        failures,
        `Failed to stop ${failures.length} process(es) of desktop session ${id}`,
      );
    }
    await finalize();
  });
}

export async function destroyDesktopSession(
  id: string,
  registryEnv: EnvLike = process.env,
): Promise<void> {
  await teardownDesktopSession(id, registryEnv, () =>
    destroySessionRecord(id, registryEnv),
  );
}

export async function getDesktopSessionStatus(
  id: string,
  registryEnv: EnvLike = process.env,
): Promise<DesktopSessionStatus> {
  const record = await getSession(id, registryEnv);
  if (record === undefined) {
    throw new Error(`Desktop session not found: ${id}`);
  }
  const desktop = record.desktop;
  return {
    record,
    xvfbAlive:
      desktop?.xvfbPid !== undefined &&
      (desktop.xvfbStartTimeTicks === undefined
        ? isPidAlive(desktop.xvfbPid)
        : processIdentityMatches({
            pid: desktop.xvfbPid,
            startTicks: desktop.xvfbStartTimeTicks,
          })),
    vncAlive:
      desktop?.vncPid !== undefined &&
      desktop.vncStartTimeTicks !== undefined &&
      processIdentityMatches({
        pid: desktop.vncPid,
        startTicks: desktop.vncStartTimeTicks,
      }),
    displayAlive: desktop !== undefined && isDisplayAlive(desktop.display),
  };
}
