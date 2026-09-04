// Self-exclusion worker, run with `bun`. This process is started *carrying* a
// containment token (and, for a cgroup scope, as a member of that cgroup) and
// then performs the cleanup for that very scope. A cleanup that did not exclude
// the caller's own process chain would kill the process running it, so the
// report file is only written if self-exclusion holds. The full cleanup result
// is written too, so the test can check the scope was still emptied.
// Not a `*.test.ts` file, so vitest never runs it directly.
import fs from "node:fs";
import {
  destroyContainmentScope,
  type ContainmentScope,
} from "../../src/containment.js";

const scopeJson = process.argv[2];
const reportPath = process.argv[3];
if (scopeJson === undefined || reportPath === undefined) {
  console.error("usage: containment-self-worker <scopeJson> <reportPath>");
  process.exit(2);
}

const scope = JSON.parse(scopeJson) as ContainmentScope;
const result = await destroyContainmentScope(scope, {
  termTimeoutMs: 1_000,
  killTimeoutMs: 1_000,
});
fs.writeFileSync(
  reportPath,
  JSON.stringify({ survived: true, pid: process.pid, result }),
);
process.exit(result.signaled.includes(process.pid) ? 1 : 0);
