import { spawn } from "node:child_process";
import { renewHumanTakeover, type HumanTakeoverHandle } from "@pickforge/lab-desktop-linux";
import type { EnvLike } from "@pickforge/lab-core";

export interface TakeoverWatchdogHandle { kill(): void }
export type SpawnWatchdogFn = (handle: HumanTakeoverHandle) => TakeoverWatchdogHandle;

/** A detached sibling recovers the lease even when its owner crashes. */
export function defaultSpawnWatchdog(handle: HumanTakeoverHandle): TakeoverWatchdogHandle {
  const cliEntry = process.argv[1];
  if (cliEntry === undefined) return { kill(): void {} };
  const child = spawn(process.execPath, [cliEntry, "internal", "takeover-watchdog", "--session",
    handle.sessionId, "--lease", handle.leaseId, "--interval", String(handle.heartbeatMs)],
  { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
  let killed = false;
  return { kill(): void {
    if (killed) return;
    killed = true;
    try { child.kill("SIGTERM"); } catch { /* Already gone. */ }
  } };
}

/** Heartbeat, hard expiry, and crash watchdog shared by both input transports. */
export function holdHumanLease(handle: HumanTakeoverHandle, options: {
  registryEnv: EnvLike;
  onLost(): void;
  onRenew?(): void;
  spawnWatchdog?: SpawnWatchdogFn;
}): { stopRenewing(): void; stop(): void; readonly lost: boolean } {
  let stopped = false;
  let lost = false;
  let renewing = false;
  let deadline: NodeJS.Timeout;
  const lose = (): void => {
    if (stopped || lost) return;
    lost = true;
    clearInterval(heartbeat);
    clearTimeout(deadline);
    options.onLost();
  };
  const schedule = (expiresAt: string): void => {
    clearTimeout(deadline);
    deadline = setTimeout(lose, Math.max(0, Date.parse(expiresAt) - Date.now()));
    deadline.unref();
  };
  const heartbeat = setInterval(() => {
    if (stopped || lost || renewing) return;
    renewing = true;
    void renewHumanTakeover(handle, options.registryEnv).then((lease) => {
      if (stopped || lost) return;
      if (lease === undefined) { lose(); return; }
      schedule(lease.expiresAt);
      options.onRenew?.();
    }).catch(lose).finally(() => { renewing = false; });
  }, handle.heartbeatMs);
  heartbeat.unref();
  schedule(handle.expiresAt);
  const watchdog = (options.spawnWatchdog ?? defaultSpawnWatchdog)(handle);
  const stopRenewing = (): void => {
    stopped = true;
    clearInterval(heartbeat);
    clearTimeout(deadline);
  };
  let watchdogStopped = false;
  return {
    stopRenewing,
    get lost(): boolean { return lost; },
    stop(): void {
      stopRenewing();
      if (watchdogStopped) return;
      watchdogStopped = true;
      watchdog.kill();
    },
  };
}
