import fs from "node:fs";
import { withSessionGate } from "../../src/session-gate.js";

const [root, id, ready] = process.argv.slice(2);
if (root === undefined || id === undefined || ready === undefined) throw new Error("Missing worker arguments");
await withSessionGate(id, root, async () => {
  fs.writeFileSync(ready, "ready");
  await new Promise(() => { setInterval(() => {}, 1_000); });
});
