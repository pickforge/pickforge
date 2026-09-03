import { setTimeout as delay } from "node:timers/promises";
import { isHumanLeaseStale, readHumanLease, type EnvLike } from "@pickforge/lab-core";
import { recoverStaleHumanLease } from "./takeover.js";

/** Default interval between staleness checks (pickforge/pickforge#21 P0-A). */
export const DEFAULT_TAKEOVER_WATCHDOG_POLL_MS = 5_000;

export interface RunTakeoverWatchdogLoopOptions {
  sessionId: string;
  leaseId: string;
  registryEnv?: EnvLike;
  pollIntervalMs?: number;
  /**
   * @internal Test hook, checked once per iteration right before sleeping.
   * Returning true stops the loop even though the lease it is watching is
   * still present and live — used to bound a test's runtime rather than
   * waiting for the watched lease to end.
   */
  _shouldStop?: () => boolean;
}

/**
 * Actively reclaim a writable VNC session if its human lease goes stale,
 * independent of the takeover-owning process's own lifetime.
 *
 * This is the crash-path half of the "writable VNC never outlives its
 * lease" invariant (pickforge/pickforge#21 P0-A): `pickforge-lab watch --control`
 * spawns this loop as a **detached** child process (own process group, not
 * killed by a `SIGKILL` of its parent — see
 * `packages/cli/src/commands/watch.ts`), so a crash of the controlling
 * process does not leave writable VNC running until some later, unrelated
 * operation happens to touch the session. That would be a *lazy* reclaim —
 * correct eventually, but with no wall-clock bound — and is rejected: the
 * watchdog polls on its own schedule, in its own process, and actively stops
 * a stale writable VNC (via the same TOCTOU-safe `recoverStaleHumanLease`
 * used elsewhere) the first time it observes the lease has gone stale.
 *
 * A short-lived detached process was chosen over OS-level parent-death
 * coupling (e.g. Linux `PR_SET_PDEATHSIG`) because the latter has no
 * portable Node.js API — it needs either a native addon or an external
 * wrapper binary not guaranteed to be present — while a detached sibling
 * process is plain, dependency-free Node/TypeScript consistent with the rest
 * of this codebase, and the existing `recoverStaleHumanLease` primitive
 * already does exactly the reclaim work this loop needs to trigger.
 *
 * Exits on its own — no external signal needed — as soon as the lease it is
 * watching is gone or has been superseded by a different lease (the
 * takeover it was watching ended, one way or another) or once it has
 * actively reclaimed a stale one. The controlling process additionally
 * terminates it directly on a clean end, for promptness; this self-exit is
 * the backstop if that termination itself is lost (e.g. the controlling
 * process crashes before it can send the signal).
 */
export async function runTakeoverWatchdogLoop(
  opts: RunTakeoverWatchdogLoopOptions,
): Promise<void> {
  const registryEnv = opts.registryEnv ?? process.env;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_TAKEOVER_WATCHDOG_POLL_MS;
  for (;;) {
    const lease = await readHumanLease(opts.sessionId, registryEnv);
    if (lease === undefined || lease.leaseId !== opts.leaseId) {
      return;
    }
    if (isHumanLeaseStale(lease)) {
      await recoverStaleHumanLease(opts.sessionId, registryEnv);
      return;
    }
    if (opts._shouldStop?.() === true) return;
    await delay(pollIntervalMs);
  }
}
