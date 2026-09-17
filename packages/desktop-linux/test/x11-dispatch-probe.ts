// Opt-in LOW-only protocol instrumentation. Never imported by product code.
import fs from "node:fs";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { validateTypingTarget } from "../src/x11-target.js";
import { X11Wire } from "../src/x11-wire.js";
import { negotiateXkb, readKeyboard } from "../src/x11-keymap.js";

interface ProbeConfig {
  executable: string;
  sessionId: string;
  display: string;
  home: string;
  log: string;
}

export async function probeDispatch(config: ProbeConfig, args: string[]): Promise<void> {
  if (args[0] === "type") {
    const deadline = performance.now() + 3000;
    const target = await validateTypingTarget(config.sessionId, config.display, { PICKFORGE_HOME: config.home }, deadline);
    const wire = new X11Wire(target.path, deadline, target.alive);
    try {
      const { min, max } = await wire.hello();
      const map = await readKeyboard(wire, await negotiateXkb(wire), min, max);
      fs.appendFileSync(config.log, JSON.stringify({ kind: "probe", keys: map.keys.map(({ code, groups }) => ({ code, groups })) }) + "\n");
    } finally { wire.close(); }
  }
  // No shell, rewritten text, fake result or detached subgroup. The probe has
  // closed; the product anchor alone bridges entry into the genuine client.
  const child = spawn(config.executable, args, { stdio: "inherit", shell: false });
  child.once("error", () => {
    fs.appendFileSync(config.log, JSON.stringify({ kind: "spawn-error" }) + "\n");
    process.exit(1);
  });
  child.once("close", (code, signal) => {
    fs.appendFileSync(config.log, JSON.stringify({ kind: "exit", code, signal }) + "\n");
    process.exit(code ?? 1);
  });
}
