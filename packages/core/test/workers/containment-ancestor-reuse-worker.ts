// Ancestor-migration safety worker, run with `bun`. Like the self-exclusion
// worker, this process performs the cleanup for the very scope it runs inside,
// so its own chain has to be moved out of the cgroup before `cgroup.kill`.
// Here every `/proc/<ppid>/stat` read *after* the first reports a different
// start time: exactly what a caller would see if its parent had exited, been
// reaped, and had its pid handed to an unrelated process between the moment
// the chain was recorded and the moment it is migrated. Cleanup must refuse
// rather than write that pid into another cgroup's `cgroup.procs`.
// Not a `*.test.ts` file, so vitest never runs it directly.
import fs from "node:fs";
import {
  destroyContainmentScope,
  type ContainmentScope,
} from "../../src/containment.js";

const scopeJson = process.argv[2];
const reportPath = process.argv[3];
if (scopeJson === undefined || reportPath === undefined) {
  console.error("usage: containment-ancestor-reuse-worker <scopeJson> <reportPath>");
  process.exit(2);
}

const ancestorStat = `/proc/${process.ppid}/stat`;
const realRead = fs.readFileSync;
let statReads = 0;
const patched = ((file: unknown, ...rest: unknown[]) => {
  const content = (realRead as (...args: unknown[]) => unknown)(file, ...rest);
  if (file !== ancestorStat || typeof content !== "string") return content;
  statReads += 1;
  if (statReads === 1) return content;
  const close = content.lastIndexOf(")");
  const fields = content.slice(close + 1).trim().split(/\s+/);
  fields[22 - 3] = String(Number(fields[22 - 3]) + 12_345);
  return `${content.slice(0, close + 1)} ${fields.join(" ")}\n`;
}) as typeof fs.readFileSync;
fs.readFileSync = patched;

const scope = JSON.parse(scopeJson) as ContainmentScope;
const result = await destroyContainmentScope(scope, {
  termTimeoutMs: 1_000,
  killTimeoutMs: 1_000,
});
fs.readFileSync = realRead;
fs.writeFileSync(
  reportPath,
  JSON.stringify({
    survived: true,
    pid: process.pid,
    ppid: process.ppid,
    statReads,
    result,
  }),
);
process.exit(
  result.signaled.includes(process.pid) || result.signaled.includes(process.ppid)
    ? 1
    : 0,
);
