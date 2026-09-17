import { legacyKeysyms } from "./x11-legacy-keysyms.js";
import { typingFailure } from "./x11-wire.js";

function latin1(cp: number): boolean {
  return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff);
}

function controlSymbol(symbol: number): boolean {
  const inRange = [[0xff08, 0xff0b], [0xffaa, 0xffb9]].some(([lo, hi]) => symbol >= lo! && symbol <= hi!);
  return inRange || [0xff0d, 0xff1b, 0xffff, 0xff89, 0xff8d, 0xffbd].includes(symbol);
}

/** Mirrors the pinned public-domain keysym-to-UTF32 conversion, including
 * keypad/control aliases and all legacy graphical symbols. No normalization.
 */
export function keysymToCodepoint(symbol: number): number {
  if (latin1(symbol)) return symbol;
  if (symbol === 0xff80) return 0x20;
  if (controlSymbol(symbol)) return symbol & 0x7f;
  if (symbol >= 0x100d800 && symbol <= 0x100dfff) return 0;
  if (symbol >= 0x1000000 && symbol <= 0x110ffff) return symbol - 0x1000000;
  return legacyKeysyms.get(symbol) ?? 0;
}

export function textCodepoints(text: string): Set<number> {
  if (text.length === 0 || text.length > 65536) throw typingFailure();
  const codepoints = new Set<number>();
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    if (cp === 0 || (cp >= 0xd800 && cp <= 0xdfff)) throw typingFailure();
    codepoints.add(cp);
  }
  return codepoints;
}

export function codepointToKeysym(cp: number): number {
  if (latin1(cp)) return cp;
  if ((cp >= 8 && cp <= 11) || cp === 13 || cp === 27) return cp | 0xff00;
  if (cp === 127) return 0xffff;
  return cp + 0x1000000;
}

/** Preserve natural, mutually reversible single-scalar case pairs in each new
 * row, including across calls. Explicit levels avoid depending on the server's
 * Unicode case-table version. Titlecase and expanding cases stay literal.
 */
export function bindingSymbols(missing: Set<number>): number[][] {
  const pending = new Set(missing);
  const result: number[][] = [];
  for (const cp of pending) {
    const char = String.fromCodePoint(cp);
    const lower = char.toLowerCase();
    const upper = char.toUpperCase();
    const paired = [...lower].length === 1 && [...upper].length === 1 && lower.toUpperCase() === upper && upper.toLowerCase() === lower;
    const lo = lower.codePointAt(0)!;
    const hi = upper.codePointAt(0)!;
    if (paired && (cp === lo || cp === hi)) {
      result.push([codepointToKeysym(lo), codepointToKeysym(hi)]);
      pending.delete(lo);
      pending.delete(hi);
    } else {
      result.push([codepointToKeysym(cp), codepointToKeysym(cp)]);
      pending.delete(cp);
    }
  }
  return result;
}
