// Self-exclusion worker, run with `bun`. This process is started *carrying* a
// containment token and then performs the cleanup for that very scope. A sweep
// that did not exclude the caller's own process chain would kill the process
// running it, so the marker file is only written if self-exclusion holds.
// Not a `*.test.ts` file, so vitest never runs it directly.
import fs from "node:fs";
import { destroyContainmentScope } from "../../src/containment.js";

const token = process.argv[2];
const markerPath = process.argv[3];
if (token === undefined || markerPath === undefined) {
  console.error("usage: containment-self-worker <token> <markerPath>");
  process.exit(2);
}

const result = await destroyContainmentScope(
  { token, mechanism: "marker" },
  { termTimeoutMs: 500, killTimeoutMs: 500 },
);
fs.writeFileSync(markerPath, "survived");
process.exit(result.signaled.includes(process.pid) ? 1 : 0);
