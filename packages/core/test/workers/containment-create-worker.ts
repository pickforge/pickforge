// Scope creation worker, run with `bun`. Given a private parent cgroup, this
// process first moves itself into it, so `createContainmentScope` treats that
// parent as its delegated cgroup. No other process creates scopes there, so no
// concurrent prune can remove the fresh, empty scope before it is inspected.
// Given "-", it creates the scope wherever this process already lives.
// Not a `*.test.ts` file, so vitest never runs it directly.
import fs from "node:fs";
import {
  createContainmentScope,
  destroyContainmentScope,
  readOwnCgroupPath,
  scopeCgroupProblem,
} from "../../src/containment.js";

const parent = process.argv[2];
const id = process.argv[3];
const reportPath = process.argv[4];
if (parent === undefined || id === undefined || reportPath === undefined) {
  console.error("usage: containment-create-worker <parentCgroupDir|-> <id> <reportPath>");
  process.exit(2);
}

if (parent !== "-") {
  fs.writeFileSync(`${parent}/cgroup.procs`, String(process.pid));
  if (`/sys/fs/cgroup${readOwnCgroupPath() ?? ""}` !== parent) {
    console.error(`did not join ${parent}: now in ${readOwnCgroupPath() ?? "<unreadable>"}`);
    process.exit(3);
  }
}

const scope = createContainmentScope({ id });
const existed = scope.cgroupDir === undefined ? undefined : fs.existsSync(scope.cgroupDir);
const problem = scope.cgroupDir === undefined ? undefined : scopeCgroupProblem(scope.cgroupDir, id);
fs.writeFileSync(reportPath, JSON.stringify({ scope, existed, problem: problem ?? null }));
await destroyContainmentScope(scope);
