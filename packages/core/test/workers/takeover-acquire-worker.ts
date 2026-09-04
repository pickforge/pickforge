// Separate-process human-lease acquire worker, run with `bun`. Races real
// `acquireHumanLease` calls from distinct OS processes (genuinely distinct
// PIDs, unlike in-process races) to prove the `wx` claim protocol yields
// exactly one winner. Not a `*.test.ts` file, so vitest never runs it
// directly.
import { setTimeout as delay } from "node:timers/promises";
import { acquireHumanLease, releaseHumanLease } from "../../src/takeover.js";

const home = process.argv[2];
const sessionId = process.argv[3];
const holdMs = process.argv[4] === undefined ? 0 : Number(process.argv[4]);
if (home === undefined || sessionId === undefined || !Number.isFinite(holdMs)) {
  console.error("usage: takeover-acquire-worker <home> <sessionId> [holdMs]");
  process.exit(2);
}

const env = { ...process.env, PICKFORGE_HOME: home };

try {
  const lease = await acquireHumanLease(sessionId, env, { drainTimeoutMs: 2_000 });
  process.stdout.write(`${JSON.stringify({ won: true, leaseId: lease.leaseId })}\n`);
  if (holdMs > 0) await delay(holdMs);
  await releaseHumanLease(sessionId, lease.leaseId, env);
  process.exit(0);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ won: false, error: error instanceof Error ? error.name : String(error) })}\n`,
  );
  process.exit(0);
}
