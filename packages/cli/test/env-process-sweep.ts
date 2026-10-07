import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import {
  processIdentityMatches,
  readProcessIdentity,
  type ProcessIdentity,
} from "@pickforge/lab-core";

/**
 * Finds this user's live processes whose environment holds `name=value` as an
 * exact entry. A process that exits, turns into a zombie or cannot be read
 * during the scan is skipped. This test process is never included.
 */
export function findProcessesWithEnv(
  name: string,
  value: string,
): ProcessIdentity[] {
  if (name === "" || value === "") {
    throw new Error("an environment sweep needs a name and a value");
  }
  const wanted = Buffer.from(`${name}=${value}`).toString("latin1");
  const uid = process.getuid?.();
  const found: ProcessIdentity[] = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    const identity = readOwnedIdentityWithEnv(pid, uid, wanted);
    if (identity !== undefined) found.push(identity);
  }
  return found;
}

function readOwnedIdentityWithEnv(
  pid: number,
  uid: number | undefined,
  wanted: string,
): ProcessIdentity | undefined {
  try {
    if (fs.statSync(`/proc/${pid}`).uid !== uid) return undefined;
    const identity = readProcessIdentity(pid);
    if (identity === undefined) return undefined;
    const environ = fs.readFileSync(`/proc/${pid}/environ`).toString("latin1");
    if (!environ.split("\0").includes(wanted)) return undefined;
    // The pid could exit and be reused while we read. A matching start time
    // proves that the environment came from the process we identified.
    return processIdentityMatches(identity) ? identity : undefined;
  } catch {
    return undefined;
  }
}

export interface EnvSweepResult {
  killed: number[];
  survivors: number[];
}

/**
 * SIGKILLs each process that {@link findProcessesWithEnv} finds, one pid at a
 * time, and scans again until none is left or `waitMs` passes. Processes
 * without the exact entry are never signaled, even in the same group.
 */
export async function killProcessesWithEnv(
  name: string,
  value: string,
  waitMs: number,
): Promise<EnvSweepResult> {
  const deadline = Date.now() + waitMs;
  const killed = new Set<number>();
  for (;;) {
    const found = findProcessesWithEnv(name, value);
    if (found.length === 0 || Date.now() >= deadline) {
      return { killed: [...killed], survivors: found.map(({ pid }) => pid) };
    }
    for (const identity of found) {
      if (!processIdentityMatches(identity)) continue;
      try {
        process.kill(identity.pid, "SIGKILL");
        killed.add(identity.pid);
      } catch {
        // It exited after the scan.
      }
    }
    await sleep(20);
  }
}
