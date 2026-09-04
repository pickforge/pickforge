import crypto from "node:crypto";
import path from "node:path";
import {
  acquireHumanLease,
  appendAction,
  beginEvidenceRun,
  isEvidenceEnabled,
  getSession,
  loadConfig,
  recordTakeoverEvidence,
  releaseHumanLease,
  renewHumanLease,
  updateSession,
  StaleHumanLeaseError,
  type DesktopSessionInfo,
  type EnvLike,
  type HumanLease,
  type SessionRecord,
} from "@pickforge/lab-core";
import { screenshot } from "./screenshot.js";
import {
  recoverStaleTakeoverLocked,
  startSessionVnc,
  stopOwnedSessionVnc,
  withSessionVncLock,
} from "./session.js";
import type { VncHandle } from "./vnc.js";

/**
 * Desktop-linux orchestration for supervised pause / human takeover
 * (pickforge/pickforge#21): switches x11vnc between read-only and writable
 * scoped to the human lease's lifetime, and recovers a session left with a
 * writable VNC server after a crashed takeover. Lease/permit bookkeeping
 * itself lives in `@pickforge/lab-core` (`takeover.ts`), which this
 * module wraps with VNC-mode and evidence side effects.
 */

export type TakeoverEndReason = "return" | "timeout" | "cancelled";

export interface HumanTakeoverHandle {
  sessionId: string;
  leaseId: string;
  display: string;
  vncPid: number;
  vncPort: number;
  vncStartTimeTicks: number;
  ttlMs: number;
  heartbeatMs: number;
  /** The lease's current expiry, as of the last successful renewal. */
  expiresAt: string;
  projectDir: string;
}

export interface StartHumanTakeoverOptions {
  registryEnv?: EnvLike;
  env?: EnvLike;
  ttlMs?: number;
  heartbeatMs?: number;
  drainTimeoutMs?: number;
}

async function requireRunningDesktopSession(
  id: string,
  registryEnv: EnvLike,
): Promise<{ record: SessionRecord; desktop: DesktopSessionInfo }> {
  const record = await getSession(id, registryEnv);
  if (record === undefined) {
    throw new Error(`Session not found: ${id}`);
  }
  if (record.desktop === undefined) {
    throw new Error(`Session ${id} is not desktop-capable`);
  }
  if (record.status !== "running") {
    throw new Error(`Session ${id} is not running`);
  }
  return { record, desktop: record.desktop };
}

async function evidenceEnabledForProject(
  projectDir: string,
  env: EnvLike | undefined,
): Promise<boolean> {
  try {
    return isEvidenceEnabled(await loadConfig(projectDir, env));
  } catch {
    return false;
  }
}

/**
 * Public entry point for stale-lease recovery outside an already-locked VNC
 * operation (e.g. `pickforge-lab takeover status`, or a standalone health check).
 */
export async function recoverStaleHumanLease(
  id: string,
  registryEnv: EnvLike = process.env,
): Promise<{ recovered: boolean }> {
  return withSessionVncLock(id, registryEnv, async () => {
    const record = await getSession(id, registryEnv);
    if (record === undefined) return { recovered: false };
    return recoverStaleTakeoverLocked(id, record, registryEnv);
  });
}

/**
 * Acquire human control of a desktop-capable session: acquire the lease
 * (self-healing a stale predecessor once), switch its VNC server to
 * writable, and record the transition. Throws `HumanLeaseHeldError` if
 * another live human lease already holds the session.
 */
export async function startHumanTakeover(
  id: string,
  opts: StartHumanTakeoverOptions = {},
): Promise<HumanTakeoverHandle> {
  const registryEnv = opts.registryEnv ?? process.env;
  return withSessionVncLock(id, registryEnv, async () => {
    const { record, desktop } = await requireRunningDesktopSession(id, registryEnv);

    let lease: HumanLease;
    try {
      lease = await acquireHumanLease(id, registryEnv, {
        ttlMs: opts.ttlMs,
        heartbeatMs: opts.heartbeatMs,
        drainTimeoutMs: opts.drainTimeoutMs,
      });
    } catch (error) {
      if (!(error instanceof StaleHumanLeaseError)) throw error;
      await recoverStaleTakeoverLocked(id, record, registryEnv);
      lease = await acquireHumanLease(id, registryEnv, {
        ttlMs: opts.ttlMs,
        heartbeatMs: opts.heartbeatMs,
        drainTimeoutMs: opts.drainTimeoutMs,
      });
    }

    let vnc: VncHandle;
    try {
      if (desktop.vncPid !== undefined && desktop.vncViewOnly === true) {
        await stopOwnedSessionVnc(id, desktop);
      }
      vnc = await startSessionVnc(id, registryEnv, {
        display: desktop.display,
        port: desktop.vncPort,
        env: opts.env,
        viewOnly: false,
      });
    } catch (error) {
      await releaseHumanLease(id, lease.leaseId, registryEnv).catch(() => {});
      throw error;
    }

    try {
      await updateSession(
        id,
        {
          desktop: {
            ...desktop,
            vncPid: vnc.pid,
            vncStartTimeTicks: vnc.startTimeTicks,
            vncPort: vnc.port,
            vncViewOnly: false,
          },
        },
        registryEnv,
      );
      const patched = await renewHumanLease(id, lease.leaseId, registryEnv, {
        vncPid: vnc.pid,
        vncStartTimeTicks: vnc.startTimeTicks,
        vncPort: vnc.port,
      });
      if (patched === undefined) {
        throw new Error(
          `Human lease ${lease.leaseId} for session ${id} went stale before its writable VNC could be recorded`,
        );
      }
      lease.expiresAt = patched.expiresAt;
    } catch (error) {
      await stopOwnedSessionVnc(id, {
        ...desktop,
        vncPid: vnc.pid,
        vncStartTimeTicks: vnc.startTimeTicks,
      }).catch(() => {});
      await releaseHumanLease(id, lease.leaseId, registryEnv).catch(() => {});
      throw error;
    }

    await recordTakeoverEvidence(record.projectDir, id, "takeover_start", {
      env: registryEnv,
    });

    return {
      sessionId: id,
      leaseId: lease.leaseId,
      display: desktop.display,
      vncPid: vnc.pid,
      vncPort: vnc.port,
      vncStartTimeTicks: vnc.startTimeTicks,
      ttlMs: lease.ttlMs,
      heartbeatMs: lease.heartbeatMs,
      expiresAt: lease.expiresAt,
      projectDir: record.projectDir,
    };
  });
}

/**
 * Renew a held lease's TTL. Returns `false` (never throws) if the lease is
 * no longer ours — the caller must then end the takeover with reason
 * `"timeout"` rather than keep driving a writable VNC past its lease.
 */
/**
 * Renew a held lease's TTL. Returns the renewed lease (so callers can read
 * its fresh `expiresAt` and reschedule their own hard-deadline backstop), or
 * `undefined` if the lease was no longer renewable — already stale (TTL
 * elapsed without a timely renewal: `renewHumanLease` itself refuses to
 * resurrect a stale lease, see pickforge/pickforge#21 P0-B) or held by someone
 * else. The caller must treat `undefined` as "the lease is gone" and end the
 * takeover immediately, not merely stop trying to renew.
 */
export async function renewHumanTakeover(
  handle: HumanTakeoverHandle,
  registryEnv: EnvLike = process.env,
): Promise<HumanLease | undefined> {
  return renewHumanLease(handle.sessionId, handle.leaseId, registryEnv).catch(() => undefined);
}

export interface EndHumanTakeoverOptions {
  registryEnv?: EnvLike;
  env?: EnvLike;
  reason: TakeoverEndReason;
}

export interface EndHumanTakeoverResult {
  screenshotPath?: string;
  reason: TakeoverEndReason;
}

/**
 * Revert a session's VNC to read-only, capture a fresh screenshot into
 * evidence as the agent's resume state, record the transition, and release
 * the lease. Safe to call on any exit path (normal return, cancellation, or
 * a failed heartbeat); every step is best-effort past the VNC revert so a
 * failure recording evidence never leaves writable VNC or the lease behind.
 */
export async function endHumanTakeover(
  handle: HumanTakeoverHandle,
  opts: EndHumanTakeoverOptions,
): Promise<EndHumanTakeoverResult> {
  const registryEnv = opts.registryEnv ?? process.env;
  return withSessionVncLock(handle.sessionId, registryEnv, async () => {
    const record = await getSession(handle.sessionId, registryEnv);
    const desktop = record?.desktop;

    if (desktop !== undefined && desktop.vncPid === handle.vncPid) {
      await stopOwnedSessionVnc(handle.sessionId, desktop).catch(() => {});
      try {
        const readOnly = await startSessionVnc(handle.sessionId, registryEnv, {
          display: handle.display,
          port: handle.vncPort,
          env: opts.env,
          viewOnly: true,
        });
        await updateSession(
          handle.sessionId,
          {
            desktop: {
              ...desktop,
              vncPid: readOnly.pid,
              vncStartTimeTicks: readOnly.startTimeTicks,
              vncPort: readOnly.port,
              vncViewOnly: true,
            },
          },
          registryEnv,
        );
      } catch {
        await updateSession(
          handle.sessionId,
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
    }

    // The lifecycle-transition evidence entry is recorded regardless of
    // whether the fresh-state screenshot can be captured (e.g. no screenshot
    // tool on PATH) — a missing screenshot must never silently drop the
    // transition record itself.
    let screenshotPath: string | undefined;
    if (record !== undefined && (await evidenceEnabledForProject(record.projectDir, opts.env))) {
      try {
        const { run } = await beginEvidenceRun(
          record.projectDir,
          handle.sessionId,
          { slug: "computer-use" },
          opts.env,
        );
        try {
          const actionId = crypto.randomUUID();
          const outPath = path.join(run.dir, "screenshots", `${actionId}.png`);
          await screenshot({ display: handle.display, outPath, env: opts.env });
          screenshotPath = path.join("screenshots", `${actionId}.png`);
        } catch {
          // Best-effort: the transition is still recorded without a screenshot.
        }
        await appendAction(run.dir, {
          actionId: crypto.randomUUID(),
          source: "takeover",
          tool: `takeover_${opts.reason}`,
          sessionId: handle.sessionId,
          startedAt: new Date().toISOString(),
          status: "ok",
          ...(screenshotPath === undefined ? {} : { artifacts: [screenshotPath] }),
        });
      } catch {
        // Evidence failure must never block releasing the lease.
      }
    }

    await releaseHumanLease(handle.sessionId, handle.leaseId, registryEnv).catch(
      () => {},
    );

    return { screenshotPath, reason: opts.reason };
  });
}
