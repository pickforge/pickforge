import fs from "node:fs";
import { acquireHumanLease } from "../../src/takeover.js";
import { DirHandle } from "../../src/dir-handle.js";

const [home, sessionId, ready] = process.argv.slice(2);
if (home === undefined || sessionId === undefined || ready === undefined) throw new Error("Missing worker arguments");
const link = DirHandle.prototype.linkChild;
DirHandle.prototype.linkChild = async function(from, to) {
  if (to !== "human.lease.json") return link.call(this, from, to);
  fs.writeFileSync(ready, "ready");
  await new Promise(() => { setInterval(() => {}, 1_000); });
};
await acquireHumanLease(sessionId, { PICKFORGE_HOME: home });
