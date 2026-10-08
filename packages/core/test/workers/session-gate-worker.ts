import { withSessionGate } from "../../src/session-gate.js";

const home = process.argv[2]!;
const id = process.argv[3]!;
await withSessionGate(id, { PICKFORGE_HOME: home }, async () => {
  process.stdout.write("held\n");
  await new Promise(() => {});
});
