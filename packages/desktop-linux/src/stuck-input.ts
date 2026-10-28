import { performance } from "node:perf_hooks";
import { runCommand, type EnvLike } from "@pickforge/lab-core";
import { parseDisplayNumber } from "./display.js";
import { request, X11_SETUP_MS, X11Wire } from "./x11-wire.js";

async function downKeycodes(display: string): Promise<number[]> {
  const number = parseDisplayNumber(display);
  const wire = new X11Wire(`/tmp/.X11-unix/X${number}`, performance.now() + X11_SETUP_MS, () => true);
  try {
    await wire.hello();
    const reply = await wire.reply(request(44)); // QueryKeymap: 32 bytes after the 8-byte reply header.
    if (reply.length !== 40) throw new Error("Invalid X11 QueryKeymap reply");
    const keys: number[] = [];
    for (let code = 8; code < 256; code++) {
      if ((reply[8 + (code >> 3)]! & (1 << (code & 7))) !== 0) keys.push(code);
    }
    return keys;
  } finally {
    wire.close();
  }
}

/** Release input left down by a stopped viewer on this session's display. */
export async function releaseStuckInput(display: string, env?: EnvLike): Promise<void> {
  const keys = await downKeycodes(display);
  const commandEnv = { ...env, DISPLAY: display, XAUTHORITY: "/dev/null" };
  for (const code of keys) {
    await runCommand("xdotool", ["keyup", String(code)], { env: commandEnv, check: true, timeoutMs: 2_000 });
  }
  for (let button = 1; button <= 9; button++) {
    await runCommand("xdotool", ["mouseup", String(button)], { env: commandEnv, check: true, timeoutMs: 2_000 });
  }
}
