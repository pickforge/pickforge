// Destroy-from-inside worker, run with `bun --conditions=development`. It is
// launched *into* a desktop session through `launchApp`, so it carries the
// session's containment token and, on a cgroup host, is a member of the
// session's cgroup, exactly like `pickforge-lab session destroy` typed into a
// `desktop exec xterm`. It then destroys that very session. If cleanup did not
// exclude its own process chain, the worker would be killed mid-teardown and
// never write its report. Not a `*.test.ts` file, so vitest never runs it.
import fs from "node:fs";
import { destroyDesktopSession } from "../../src/session.js";

const [id, home, reportPath] = process.argv.slice(2);
if (id === undefined || home === undefined || reportPath === undefined) {
  console.error("usage: destroy-inside-worker <sessionId> <pickforgeHome> <reportPath>");
  process.exit(2);
}

const env = { ...process.env, PICKFORGE_HOME: home };
let report: { ok: boolean; pid: number; error?: string };
try {
  await destroyDesktopSession(id, env);
  report = { ok: true, pid: process.pid };
} catch (error) {
  report = {
    ok: false,
    pid: process.pid,
    error:
      error instanceof AggregateError
        ? error.errors.map((e) => String(e)).join("; ")
        : String(error),
  };
}
fs.writeFileSync(reportPath, JSON.stringify(report));
process.exit(report.ok ? 0 : 1);
