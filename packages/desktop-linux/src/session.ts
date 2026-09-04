import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import {
  REAPER_CLEANUP_PENDING_META_KEY,
  clearStaleHumanLease,
  createContainmentScope,
  createSession,
  destroyContainmentScope,
  ensureContainmentScope,
  destroySessionRecord,
  getSession,
  isHumanLeaseStale,
  isPidAlive,
  processIdentityMatches,
  reapDeadRunningSessions,
  readHumanLease,
  readHumanLeaseRaw,
  recordTakeoverEvidence,
  sessionDataDir,
  stopPid,
  stopProcessGroupVerified,
  updateSession,
  type ContainmentScope,
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
import {
  createDesktopRuntimeDir,
  desktopRuntimeLayout,
  removeDesktopRuntimeDir,
  type DesktopRuntimeLayout,
} from "./runtime.js";
import {
  VncStartError,
  detectVncBinary,
  startVnc,
  type VncHandle,
  type VncPartialStart,
} from "./vnc.js";

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
  runtimeDir: string;
  containment: ContainmentScope;
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
  return sessionDataDir(id, registryEnv);
}

interface DesktopStartupState {
  runtime: DesktopRuntimeLayout;
  containment: ContainmentScope;
  xvfb?: XvfbHandle;
  xvfbPartial?: XvfbPartialStart;
  vnc?: VncHandle;
  vncPartial?: VncPartialStart;
}

export interface StartSessionVncOptions {
  display: string;
  port?: number;
  env?: EnvLike;
  viewOnly: boolean;
}

/**
 * The one way x11vnc is started for a session, whether at create time, by
 * `desktop watch`, or by a human takeover and its revert: every path attaches
 * the session's own runtime directory and D-Bus endpoints (#86), so a server
 * started after create never keeps the caller's `XDG_RUNTIME_DIR` or bus
 * addresses. The layout is derived from the session directory, never read back
 * from the record.
 */
export async function startSessionVnc(
  id: string,
  registryEnv: EnvLike,
  opts: StartSessionVncOptions,
): Promise<VncHandle> {
  const logDir = desktopSessionLogDir(id, registryEnv);
  const runtime = desktopRuntimeLayout(logDir);
  await createDesktopRuntimeDir(runtime);
  return startVnc({
    display: opts.display,
    port: opts.port,
    logDir,
    env: opts.env,
    viewOnly: opts.viewOnly,
    runtime,
  });
}

function requireVncBinary(opts: CreateDesktopSessionOptions): void {
  if (detectVncBinary({ ...process.env, ...opts.env }) === null) {
    throw new Error(
      "VNC was requested but x11vnc was not found on PATH; install x11vnc to enable it",
    );
  }
}

function runningDesktopInfo(
  state: DesktopStartupState,
  xvfb: XvfbHandle,
  viewOnly: boolean,
): DesktopSessionInfo {
  const desktop: DesktopSessionInfo = {
    display: xvfb.display,
    xvfbPid: xvfb.pid,
    xvfbStartTimeTicks: xvfb.startTimeTicks,
    runtimeDir: state.runtime.runtimeDir,
    containment: state.containment,
    width: xvfb.width,
    height: xvfb.height,
  };
  if (state.vnc !== undefined) {
    desktop.vncPid = state.vnc.pid;
    desktop.vncStartTimeTicks = state.vnc.startTimeTicks;
    desktop.vncPort = state.vnc.port;
    desktop.vncViewOnly = viewOnly;
  }
  return desktop;
}

async function startSessionXvfb(
  recordId: string,
  opts: CreateDesktopSessionOptions,
  state: DesktopStartupState,
  registryEnv: EnvLike,
): Promise<XvfbHandle> {
  try {
    return await startXvfb({
      width: opts.width,
      height: opts.height,
      logDir: desktopSessionLogDir(recordId, registryEnv),
      env: opts.env,
      onSpawn: async (partial) => {
        state.xvfbPartial = partial;
        await updateSession(
          recordId,
          {
            desktop: {
              display: partial.display,
              xvfbPid: partial.pid,
              xvfbStartTimeTicks: partial.startTimeTicks,
              runtimeDir: state.runtime.runtimeDir,
              containment: state.containment,
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
      state.xvfbPartial = error.partial;
    }
    throw error;
  }
}

/**
 * Whether no x11vnc this create started is still running. A startup that threw
 * after spawning reports through its partial handle: `startVnc` has already
 * stopped that process group, and `cleanupConfirmed` is the only honest answer
 * about whether it succeeded. Assuming "no handle means nothing to stop" is
 * what would let rollback delete the runtime under a live server.
 */
async function stopStartupVnc(
  recordId: string,
  state: DesktopStartupState,
): Promise<boolean> {
  if (state.vnc === undefined) {
    return state.vncPartial?.cleanupConfirmed ?? true;
  }
  return stopOwnedSessionVnc(recordId, {
    display: state.xvfb?.display ?? state.xvfbPartial?.display ?? ":0",
    vncPid: state.vnc.pid,
    vncStartTimeTicks: state.vnc.startTimeTicks,
  })
    .then(() => true)
    .catch(() => false);
}

async function stopStartupXvfb(state: DesktopStartupState): Promise<boolean> {
  const xvfb = state.xvfb;
  if (xvfb === undefined) return state.xvfbPartial?.cleanupConfirmed ?? true;
  try {
    const result = await stopProcessGroupVerified({
      pid: xvfb.pid,
      startTicks: xvfb.startTimeTicks,
    });
    return result.outcome === "terminated" || result.outcome === "already-dead";
  } catch {
    return false;
  }
}

/** Error-path VNC identity, from a started server or a failed startup. */
function pendingVncInfo(
  state: DesktopStartupState,
): Partial<DesktopSessionInfo> {
  const vnc = state.vnc ?? state.vncPartial;
  if (vnc === undefined) return {};
  const startTicks =
    state.vnc?.startTimeTicks ?? state.vncPartial?.startTimeTicks;
  return {
    vncPid: vnc.pid,
    ...(startTicks === undefined ? {} : { vncStartTimeTicks: startTicks }),
  };
}

/** Error-path desktop info: keep every identity a later reaper retry needs. */
function pendingDesktopInfo(
  state: DesktopStartupState,
): DesktopSessionInfo | undefined {
  const known = state.xvfb ?? state.xvfbPartial;
  if (known === undefined) return undefined;
  const startTicks =
    state.xvfbPartial?.pid === known.pid
      ? state.xvfbPartial.startTimeTicks
      : state.xvfb?.startTimeTicks;
  return {
    display: known.display,
    xvfbPid: known.pid,
    ...(startTicks === undefined ? {} : { xvfbStartTimeTicks: startTicks }),
    ...pendingVncInfo(state),
    runtimeDir: state.runtime.runtimeDir,
    containment: state.containment,
    width: known.width,
    height: known.height,
  };
}

/**
 * Roll a failed create back. Contained apps and the runtime directory are only
 * cleaned up once the processes that could still be using them are confirmed
 * gone; otherwise the record keeps every identity and is marked for a reaper
 * retry rather than silently dropped.
 */
async function rollbackFailedCreate(
  record: SessionRecord,
  state: DesktopStartupState,
  registryEnv: EnvLike,
): Promise<void> {
  const vncGone = await stopStartupVnc(record.id, state);
  const xvfbGone = await stopStartupXvfb(state);
  const contained = await destroyContainmentScope(state.containment);
  const runtimeRemoved =
    contained.confirmed &&
    vncGone &&
    xvfbGone &&
    (
      await removeDesktopRuntimeDir(
        desktopSessionLogDir(record.id, registryEnv),
        state.runtime.runtimeDir,
      )
    ).removed;
  const cleanupComplete =
    vncGone && xvfbGone && contained.confirmed && runtimeRemoved;
  const pending = pendingDesktopInfo(state);
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
          ...(pending === undefined ? {} : { desktop: pending }),
        },
    registryEnv,
  ).catch(() => {});
}

export async function createDesktopSession(
  opts: CreateDesktopSessionOptions,
): Promise<DesktopSessionHandle> {
  const registryEnv = opts.registryEnv ?? process.env;
  const wantsVnc = opts.vnc === true || opts.vncControl === true;
  if (wantsVnc) requireVncBinary(opts);
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
  const state: DesktopStartupState = {
    runtime: desktopRuntimeLayout(logDir),
    containment: createContainmentScope({ id: record.id }),
  };

  try {
    await createDesktopRuntimeDir(state.runtime);
    const xvfb = await startSessionXvfb(record.id, opts, state, registryEnv);
    state.xvfb = xvfb;
    const viewOnly = opts.vncControl !== true;
    if (wantsVnc) {
      state.vnc = await startSessionVnc(record.id, registryEnv, {
        display: xvfb.display,
        env: opts.env,
        viewOnly,
      }).catch((error: unknown) => {
        // A failed startup still owns whatever it spawned: keep the partial so
        // rollback can decide about the runtime dir and the retry record.
        if (error instanceof VncStartError && error.partial !== undefined) {
          state.vncPartial = error.partial;
        }
        throw error;
      });
    }
    const desktop = runningDesktopInfo(state, xvfb, viewOnly);
    await updateSession(record.id, { status: "running", desktop }, registryEnv);

    const handle: DesktopSessionHandle = {
      id: record.id,
      display: xvfb.display,
      xvfbPid: xvfb.pid,
      runtimeDir: state.runtime.runtimeDir,
      containment: state.containment,
      logDir,
    };
    if (state.vnc !== undefined) {
      handle.vncPid = state.vnc.pid;
      handle.vncStartTimeTicks = state.vnc.startTimeTicks;
      handle.vncPort = state.vnc.port;
      handle.vncViewOnly = viewOnly;
    }
    return handle;
  } catch (error) {
    await rollbackFailedCreate(record, state, registryEnv);
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
  const registryDir = path.dirname(sessionDataDir(id, registryEnv));
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

    const vnc = await startSessionVnc(id, registryEnv, {
      display: desktop.display,
      port: desktop.vncPort,
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

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Stop every app the session launched, including any that double-forked or
 * called `setsid` out of its process group. Contained processes are identified
 * by cgroup membership or by the session's containment token, never by a
 * guessed pid, so cleanup cannot reach an unrelated process.
 */
async function stopSessionContainment(
  desktop: DesktopSessionInfo | undefined,
  failures: Error[],
): Promise<boolean> {
  const containment = desktop?.containment;
  if (containment === undefined) return true;
  try {
    const result = await destroyContainmentScope(containment);
    if (!result.confirmed) {
      failures.push(
        new Error(
          `Contained apps could not be verified as gone (${result.mechanism}): ${result.reason ?? "unknown reason"}`,
        ),
      );
    }
    return result.confirmed;
  } catch (error) {
    failures.push(asError(error));
    return false;
  }
}

/** Stop the session's VNC server; true when it is confirmed gone. */
async function stopSessionVnc(
  id: string,
  desktop: DesktopSessionInfo | undefined,
  failures: Error[],
): Promise<boolean> {
  try {
    await stopOwnedSessionVnc(id, desktop);
    return true;
  } catch (error) {
    failures.push(asError(error));
    return false;
  }
}

/** Stop the session's Xvfb group; true when it is confirmed gone. */
async function stopSessionXvfb(
  desktop: DesktopSessionInfo | undefined,
  failures: Error[],
): Promise<boolean> {
  const xvfbPid = desktop?.xvfbPid;
  if (xvfbPid === undefined) return true;
  const xvfbStartTimeTicks = desktop?.xvfbStartTimeTicks;
  if (xvfbStartTimeTicks === undefined) {
    if (!isPidAlive(xvfbPid)) return true;
    failures.push(
      new Error(
        `Refusing to stop Xvfb (pid ${xvfbPid}): process identity is unavailable`,
      ),
    );
    return false;
  }
  try {
    const result = await stopProcessGroupVerified({
      pid: xvfbPid,
      startTicks: xvfbStartTimeTicks,
    });
    if (result.outcome === "terminated" || result.outcome === "already-dead") {
      return true;
    }
    failures.push(
      new Error(
        `Xvfb process group (pid ${xvfbPid}) could not be verified as gone`,
      ),
    );
  } catch (error) {
    failures.push(asError(error));
  }
  return false;
}

/**
 * Delete the session runtime directory, but only once every process that could
 * still be writing into it (contained apps, x11vnc and Xvfb) is confirmed gone.
 */
async function removeSessionRuntime(
  id: string,
  registryEnv: EnvLike,
  desktop: DesktopSessionInfo | undefined,
  processesGone: boolean,
  failures: Error[],
): Promise<void> {
  const runtimeDir = desktop?.runtimeDir;
  if (runtimeDir === undefined) return;
  if (!processesGone) {
    failures.push(
      new Error(
        `Refusing to delete the runtime directory for ${id}: session processes are not confirmed gone`,
      ),
    );
    return;
  }
  const removal = await removeDesktopRuntimeDir(
    desktopSessionLogDir(id, registryEnv),
    runtimeDir,
  );
  if (!removal.removed) {
    failures.push(
      removal.error ??
        new Error(`Could not remove the runtime directory for ${id}`),
    );
  }
}

export interface DesktopSessionIsolation {
  runtime: DesktopRuntimeLayout;
  /** Absent for sessions created before containment existed (#85). */
  containment?: ContainmentScope;
}

/**
 * The isolation to apply to anything launched into an existing session: the
 * session's own runtime directory (created if missing, e.g. for a session that
 * predates it) and its containment scope. The runtime layout is derived from
 * the session directory rather than read back from the record, so a tampered
 * record cannot redirect a launch's `XDG_RUNTIME_DIR` outside the session.
 */
export async function ensureDesktopSessionIsolation(
  id: string,
  registryEnv: EnvLike = process.env,
): Promise<DesktopSessionIsolation> {
  const record = await getSession(id, registryEnv);
  if (record === undefined) {
    throw new Error(`Desktop session not found: ${id}`);
  }
  const runtime = desktopRuntimeLayout(
    desktopSessionLogDir(id, registryEnv),
  );
  await createDesktopRuntimeDir(runtime);
  const containment = record.desktop?.containment;
  return containment === undefined
    ? { runtime }
    : { runtime, containment: ensureContainmentScope(containment) };
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
    // Apps first: they are clients of the display, and killing the display out
    // from under them would leave the escape this cleanup exists to catch.
    const containedGone = await stopSessionContainment(desktop, failures);
    const vncGone = await stopSessionVnc(id, desktop, failures);
    const xvfbGone = await stopSessionXvfb(desktop, failures);
    await removeSessionRuntime(
      id,
      registryEnv,
      desktop,
      containedGone && vncGone && xvfbGone,
      failures,
    );

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
        `Failed to stop ${failures.length} process(es) of desktop session ${id}: ` +
          failures.map((failure) => failure.message).join("; "),
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
