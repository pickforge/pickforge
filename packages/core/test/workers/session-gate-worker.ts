import fs from "node:fs";
import { withSessionGate } from "../../src/session-gate.js";
import { DirHandle } from "../../src/dir-handle.js";

const [root, id, ready, phase] = process.argv.slice(2);
if (root === undefined || id === undefined || ready === undefined) throw new Error("Missing worker arguments");
const wait = () => new Promise<never>(() => { setInterval(() => {}, 1_000); });
if (phase !== undefined) {
  const write = DirHandle.prototype.writeFileAtomic;
  DirHandle.prototype.writeFileAtomic = async function(name, data) {
    if (phase === "before-owner") { fs.writeFileSync(ready, "ready"); await wait(); }
    await write.call(this, name, data);
    fs.writeFileSync(ready, "ready");
  };
}
await withSessionGate(id, root, async () => {
  fs.writeFileSync(ready, "ready");
  await wait();
});
