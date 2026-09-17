import { performance } from "node:perf_hooks";
import { runCommand, type EnvLike } from "@pickforge/lab-core";
import { bindingSymbols, keysymToCodepoint, textCodepoints } from "./x11-keysyms.js";
import { negotiateXkb, readKeyboard, usableCodepoints, type Keyboard, type XdotoolFamily } from "./x11-keymap.js";
import { validateTypingTarget } from "./x11-target.js";
import { remaining, request, typingFailure, X11_SETUP_MS, X11Wire } from "./x11-wire.js";

export function typingEnvironment(display?: string): Record<string, string | undefined> {
  return { PATH: process.env.PATH, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", DISPLAY: display, XAUTHORITY: "/dev/null" };
}

async function clientFamily(deadline: number): Promise<XdotoolFamily> {
  // The global option exits before xdo_new; 2016's `version` subcommand opens X.
  const result = await runCommand("xdotool", ["--version"], {
    cleanEnv: true, env: typingEnvironment(), timeoutMs: remaining(deadline),
    killGraceMs: 0, maxOutputBytes: 256,
  });
  if (!result.ok || result.stdoutTruncated || result.stderrTruncated) throw typingFailure();
  switch (result.stdout.trim()) {
    case "xdotool version 3.20160805.1": return "2016";
    case "xdotool version 4.20260303.1": return "2026";
    default: throw new Error("Desktop typing requires a supported xdotool lookup version; no text was sent");
  }
}

interface Binding { code: number; symbols: number[] }

export function planBindings(keyboard: Keyboard, desired: number[][], family: XdotoolFamily, points = new Set(desired.flat().map(keysymToCodepoint)), check: () => void = () => {}): Binding[] {
  const available = usableCodepoints(keyboard, family, check);
  const missing = desired.filter((symbols) => {
    check();
    return symbols.some((symbol) => {
      const cp = keysymToCodepoint(symbol);
      return points.has(cp) && !available.has(cp);
    });
  });
  const empty: number[] = [];
  for (let code = keyboard.max; code > keyboard.min; code--) {
    check();
    const row = keyboard.rows[code - keyboard.min]!;
    const key = keyboard.keys[code - keyboard.min]!;
    if (!keyboard.modifiers.has(code) && row.every((symbol) => symbol === 0) && key.groups.every((group) => group.every((symbol) => symbol === 0))) {
      empty.push(code);
    }
  }
  if (missing.length > empty.length) throw new Error("Desktop typing keymap capacity exhausted; no text was sent");
  return missing.map((symbols, index) => ({ code: empty[index]!, symbols: [symbols[0]!, symbols[1] ?? symbols[0]!] }));
}

function changeBinding(wire: X11Wire, binding: Binding): void {
  // Two explicit groups of the same text/case levels. These are not injected
  // text or a sacrificial key. Read back XKB: servers may reshape core requests,
  // and the 2026 client excludes its last enumerated entry.
  const change = request(100, 24, 1);
  change[4] = binding.code;
  change[5] = 4;
  for (let i = 0; i < 4; i++) change.writeUInt32LE(binding.symbols[i % 2]!, 8 + i * 4);
  wire.send(change);
}

function verifyBindings(keyboard: Keyboard, bindings: Binding[], points: Set<number>, family: XdotoolFamily, check: () => void): void {
  for (const binding of bindings) {
    const row = keyboard.rows[binding.code - keyboard.min]!;
    const represented = new Set(row.map(keysymToCodepoint));
    if (keyboard.modifiers.has(binding.code) || !binding.symbols.every((symbol) => represented.has(keysymToCodepoint(symbol)))) throw typingFailure();
  }
  const available = usableCodepoints(keyboard, family, check);
  if (![...points].every((cp) => available.has(cp))) throw typingFailure();
}

/** Caller holds the agent permit for this entire operation AND dispatch.
 * Bindings are never restored, even on partial failure: queued client events
 * may still reference them. The live map is the only allocation ledger.
 */
export async function prepareText(sessionId: string, display: string, text: string, env: EnvLike, deadline: number): Promise<X11Wire> {
  const preparationDeadline = Math.min(deadline, performance.now() + X11_SETUP_MS);
  const points = textCodepoints(text);
  const desired = bindingSymbols(points);
  await validateTypingTarget(sessionId, display, env, preparationDeadline);
  const family = await clientFamily(preparationDeadline);
  // Ownership, version and protocol work share one preparation expiry.
  const target = await validateTypingTarget(sessionId, display, env, preparationDeadline);
  remaining(preparationDeadline);
  if (!target.alive()) throw typingFailure();
  const wire = new X11Wire(target.path, deadline, target.alive, preparationDeadline);
  try {
    const { min, max } = await wire.hello();
    const opcode = await negotiateXkb(wire);
    wire.boundGrab(preparationDeadline);
    wire.send(request(36));
    const keyboard = await readKeyboard(wire, opcode, min, max);
    const bindings = planBindings(keyboard, desired, family, points, () => wire.check());
    for (const binding of bindings) changeBinding(wire, binding);
    const verified = bindings.length === 0 ? keyboard : await readKeyboard(wire, opcode, min, max);
    verifyBindings(verified, bindings, points, family, () => wire.check());
    wire.send(request(37));
    if ((await wire.reply(request(43))).length !== 32) throw typingFailure();
    return wire.retain();
  } catch (error) {
    // Failure closes even a queued/active grab. Success transfers ownership
    // to the caller until dispatch settles, without retaining a server grab.
    wire.close();
    throw error;
  }
}
