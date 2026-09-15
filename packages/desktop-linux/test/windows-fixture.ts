import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSession } from "@pickforge/lab-core";

export async function windowFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-windows-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const state = path.join(root, "state.json");
  const log = path.join(root, "argv.jsonl");
  fs.writeFileSync(state, JSON.stringify({ focused: "11", names: ["One", "Two"] }));
  fs.writeFileSync(path.join(bin, "xdotool"), `#!/usr/bin/env node
const fs = require('node:fs');
const statePath = ${JSON.stringify(state)};
const log = ${JSON.stringify(log)};
const args = process.argv.slice(2);
fs.appendFileSync(log, JSON.stringify(args) + '\\n');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const [command, id] = args;
if (state.hang === command) { setInterval(() => {}, 1000); }
else if (command === 'search') console.log('11\\n22');
else if (command === 'getwindowname') console.log(state.names[id === '11' ? 0 : 1]);
else if (command === 'getwindowclassname') console.log('Zenity');
else if (command === 'getwindowgeometry') console.log('X=-4\\nY=12\\nWIDTH=300\\nHEIGHT=200');
else if (command === 'getwindowfocus') console.log(state.focused);
else if (command === 'windowfocus') {
  if (!state.ignore) state.focused = id;
  fs.writeFileSync(statePath, JSON.stringify(state));
} else process.exit(23);
`, { mode: 0o700 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PICKFORGE_HOME: path.join(root, "home"), PICKFORGE_STORAGE_MODE: "project-local" };
  const session = await createSession({ type: "desktop", projectDir: root, status: "running", desktop: { display: ":42", homePolicy: "private" } }, env);
  return {
    root, env, session,
    state: (patch: Record<string, unknown>) => fs.writeFileSync(state, JSON.stringify({ ...JSON.parse(fs.readFileSync(state, "utf8")), ...patch })),
    calls: (): string[][] => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [],
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
