// Separate-process human-lease acquire worker, run with `bun`. Races real
// `acquireHumanLease` calls from distinct OS processes (genuinely distinct
// PIDs, unlike in-process races) to prove the `wx` claim protocol yields
// exactly one winner. Not a `*.test.ts` file, so vitest never runs it
// directly.
//
// Spawn skew must not turn the race into two sequential claims (#278). Each
// worker writes `ready-<name>` into the barrier directory and waits for the
// parent to write `go`. After its claim attempt it writes `attempted-<name>`.
// A winner holds the lease until `expected` workers have attempted, so every
// claim meets a held lease. Times are wall-clock milliseconds from
// `performance.timeOrigin + performance.now()`, comparable across processes.
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  acquireHumanLease,
  releaseHumanLease,
  StaleHumanLeaseError,
  type HumanLease,
} from "../../src/takeover.js";

const home = process.argv[2];
const sessionId = process.argv[3];
const barrier = process.argv[4];
const name = process.argv[5];
const expected = Number(process.argv[6]);
if (
  home === undefined ||
  sessionId === undefined ||
  barrier === undefined ||
  name === undefined ||
  !Number.isInteger(expected) ||
  expected < 1
) {
  console.error("usage: takeover-acquire-worker <home> <sessionId> <barrierDir> <name> <expected>");
  process.exit(2);
}

const BARRIER_TIMEOUT_MS = 8_000;
const env = { ...process.env, PICKFORGE_HOME: home };
const now = (): number => performance.timeOrigin + performance.now();

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + BARRIER_TIMEOUT_MS;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`barrier timeout waiting for ${what}`);
    await delay(2);
  }
}

const attemptedCount = (): number =>
  fs.readdirSync(barrier).filter((entry) => entry.startsWith("attempted-")).length;

fs.writeFileSync(path.join(barrier, `ready-${name}`), "");
await waitFor(() => fs.existsSync(path.join(barrier, "go")), "go");

const claimStart = now();
let lease: HumanLease | undefined;
let claimError: string | undefined;
// The lease file content a StaleHumanLeaseError saw, to diagnose #298.
let staleRaw: string | undefined;
try {
  lease = await acquireHumanLease(sessionId, env, { drainTimeoutMs: 2_000 });
} catch (error) {
  claimError = error instanceof Error ? error.name : String(error);
  if (error instanceof StaleHumanLeaseError) staleRaw = error.raw;
}
const claimEnd = now();
fs.writeFileSync(path.join(barrier, `attempted-${name}`), "");

if (lease === undefined) {
  process.stdout.write(`${JSON.stringify({ won: false, error: claimError, staleRaw, claimStart, claimEnd })}\n`);
  process.exit(0);
}
try {
  await waitFor(() => attemptedCount() >= expected, "all claim attempts");
} finally {
  const releaseAt = now();
  await releaseHumanLease(sessionId, lease.leaseId, env);
  process.stdout.write(
    `${JSON.stringify({ won: true, leaseId: lease.leaseId, claimStart, claimEnd, releaseAt })}\n`,
  );
}
process.exit(0);
