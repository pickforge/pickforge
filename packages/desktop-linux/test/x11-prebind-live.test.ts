import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { readPickforgeEnv, runCommand, withAgentPermit } from "@pickforge/lab-core";
import { createDesktopSession, destroyDesktopSession } from "../src/session.js";
import { typeText } from "../src/input.js";
import { keysymToCodepoint } from "../src/x11-keysyms.js";
import { negotiateXkb, readKeyboard, type Keyboard } from "../src/x11-keymap.js";
import { validateTypingTarget } from "../src/x11-target.js";
import { X11Wire } from "../src/x11-wire.js";
import { performance } from "node:perf_hooks";

const live = readPickforgeEnv(process.env, "LIVE_UNICODE") === "1";
function codesFor(map: Pick<Keyboard, "keys">, cp: number): number[] {
  return map.keys.filter((key) => key.groups.some((group) => group.some((symbol) => keysymToCodepoint(symbol) === cp))).map((key) => key.code);
}
function distinct(map: Pick<Keyboard, "keys">): void {
  const a = codesFor(map, 0xe1);
  const e = codesFor(map, 0xe9);
  expect(a.length).toBeGreaterThan(0);
  expect(e.length).toBeGreaterThan(0);
  expect(a.some((code) => e.includes(code))).toBe(false);
}
function executable(name: string): string {
  for (const folder of (process.env.PATH ?? "").split(path.delimiter)) {
    const file = path.join(folder, name);
    try { fs.accessSync(file, fs.constants.X_OK); return fs.realpathSync(file); } catch { /* next PATH entry */ }
  }
  throw new Error("Required live executable is unavailable");
}

// Protocol proof only, NOT native delivery. Only parent-routed Astra LOW may
// execute these tests. The old zero-client persistence assertion was invalid:
// its preserved failure and reset diagnostic must not be relabeled as passes.
it.skipIf(!live)("retains distinct bindings across calls while a readonly consumer remains", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ul-"));
  const env = { ...process.env, PICKFORGE_HOME: path.join(root, "pf") };
  const session = await createDesktopSession({ projectDir: root, registryEnv: env, env, vnc: false });
  let consumer: X11Wire | undefined;
  try {
    const target = await validateTypingTarget(session.id, session.display, env);
    consumer = new X11Wire(target.path, performance.now() + 3000, target.alive);
    const { min, max } = await consumer.hello();
    const opcode = await negotiateXkb(consumer);
    const observer = consumer;
    const snapshot = () => withAgentPermit(session.id, env, () => readKeyboard(observer, opcode, min, max));
    await typeText({ sessionId: session.id, display: session.display, env, text: "áéáé" });
    const first = await snapshot(); distinct(first);
    await typeText({ sessionId: session.id, display: session.display, env, text: "Olá café 日本\t\n😀áÁ" });
    const after = await snapshot(); distinct(after);
    consumer.check();
    for (const cp of [0xe1, 0xe9]) for (const code of codesFor(first, cp)) expect(codesFor(after, cp)).toContain(code);
    for (const cp of [0x65e5, 0x672c, 0x1f600, 0xc1]) expect(codesFor(after, cp).length).toBeGreaterThan(0);
  } finally {
    consumer?.close();
    await destroyDesktopSession(session.id, env);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30000);

it.skipIf(!live)("COLD-DISPATCH probes prepared bindings at genuine xdotool entry with no external anchor", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uc-"));
  const originalPath = process.env.PATH;
  const real = executable("xdotool");
  const bun = executable("bun");
  const env = { ...process.env, PICKFORGE_HOME: path.join(root, "pf") };
  const session = await createDesktopSession({ projectDir: root, registryEnv: env, env, vnc: false });
  try {
    const version = await runCommand(real, ["--version"], { timeoutMs: 3000, killGraceMs: 0, check: true, maxOutputBytes: 256 });
    console.info(JSON.stringify({ realToolVersion: version.stdout.trim(), exit: version.code, signal: version.signal }));
    const log = path.join(root, "numeric-probes.jsonl");
    const config = { executable: real, sessionId: session.id, display: session.display, home: env.PICKFORGE_HOME, log };
    const entry = path.join(root, "entry.mjs");
    fs.writeFileSync(entry, `import { probeDispatch } from ${JSON.stringify(new URL("./x11-dispatch-probe.ts", import.meta.url).href)};\nawait probeDispatch(${JSON.stringify(config)}, process.argv.slice(2));\n`);
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const shim = `#!/bin/sh\nset -eu\numask 077\nh=$(mktemp -d ${quote(path.join(root, "exec.XXXXXX"))})\nexport HOME="$h" XDG_CONFIG_HOME="$h/config" XDG_DATA_HOME="$h/data" XDG_CACHE_HOME="$h/cache" XDG_STATE_HOME="$h/state" XDG_RUNTIME_DIR="$h/runtime" TMPDIR="$h/tmp" PICKFORGE_HOME="$h/pf" PICKLAB_HOME="$h/pl"\nmkdir "$h/config" "$h/data" "$h/cache" "$h/state" "$h/runtime" "$h/tmp" "$h/pf" "$h/pl"\nexec ${quote(bun)} --conditions=development ${quote(entry)} "$@"\n`;
    fs.writeFileSync(path.join(root, "xdotool"), shim, { mode: 0o700 });
    process.env.PATH = root + path.delimiter + originalPath;
    // Both calls start without an external client. Do not assert that an
    // unobserved zero-client map remains forever; each call preflights anew.
    for (let call = 0; call < 2; call++) {
      await typeText({ sessionId: session.id, display: session.display, env, text: "áéáé" });
      const records = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const probes = records.filter((record) => record.kind === "probe");
      expect(probes).toHaveLength(call + 1);
      distinct(probes.at(-1));
      expect(records.filter((record) => record.kind === "exit").every((record) => record.code === 0 && record.signal === null)).toBe(true);
      expect(records.some((record) => record.kind === "spawn-error")).toBe(false);
      console.info(JSON.stringify({ coldCall: call, numericProbe: probes.at(-1), realToolExits: records.filter((record) => record.kind === "exit") }));
    }
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await destroyDesktopSession(session.id, env);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60000);
