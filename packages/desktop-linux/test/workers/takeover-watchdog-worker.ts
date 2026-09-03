// Separate-process watchdog worker, run with `bun`. Proves
// `runTakeoverWatchdogLoop`'s reclaim logic works as a genuinely independent
// OS process (not just in-process against a mock) — the property that lets
// `pickforge-lab watch --control` survive its own SIGKILL (pickforge/pickforge#21
// P0-A). Not a `*.test.ts` file, so vitest never runs it directly.
import { runTakeoverWatchdogLoop } from "../../src/takeover-watchdog.js";

const [sessionId, leaseId, home, pollIntervalMs] = process.argv.slice(2);
if (sessionId === undefined || leaseId === undefined || home === undefined) {
  console.error(
    "usage: takeover-watchdog-worker <sessionId> <leaseId> <pickforgeHome> [pollIntervalMs]",
  );
  process.exit(2);
}

await runTakeoverWatchdogLoop({
  sessionId,
  leaseId,
  registryEnv: { ...process.env, PICKFORGE_HOME: home },
  pollIntervalMs: pollIntervalMs === undefined ? undefined : Number(pollIntervalMs),
});
process.exit(0);
