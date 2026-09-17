import { keysymToCodepoint } from "./x11-keysyms.js";
import { request, typingFailure, type X11Wire } from "./x11-wire.js";

export type XdotoolFamily = "2016" | "2026";
export interface KeyType {
  mask: number;
  levels: number;
  entries: { active: boolean; mask: number; level: number }[];
}
export interface XkbKey {
  code: number;
  types: number[];
  groups: number[][];
}
export interface Keyboard {
  min: number;
  max: number;
  rows: number[][];
  modifiers: Map<number, number>;
  modifierMask: number;
  types: KeyType[];
  keys: XkbKey[];
}

class Cursor {
  offset = 40;
  constructor(readonly data: Buffer, private readonly check: () => void) {}
  take(bytes: number): Buffer {
    this.check();
    if (this.offset + bytes > this.data.length) throw typingFailure();
    const result = this.data.subarray(this.offset, this.offset + bytes);
    this.offset += bytes;
    return result;
  }
}

function readType(cursor: Cursor): KeyType {
  const header = cursor.take(8);
  const levels = header[4]!;
  if (levels === 0 || levels > 32 || header[6]! > 1) throw typingFailure();
  const entries: KeyType["entries"] = [];
  for (let i = 0; i < header[5]!; i++) {
    const entry = cursor.take(8);
    if (entry[0]! > 1 || entry[2]! >= levels) throw typingFailure();
    entries.push({ active: entry[0] === 1, mask: entry[1]!, level: entry[2]! });
  }
  if (header[6] === 1) cursor.take(header[5]! * 4);
  return { mask: header[0]!, levels, entries };
}

function readKey(cursor: Cursor, code: number, types: KeyType[]): XkbKey {
  const header = cursor.take(8);
  const groups = header[4]! & 0x0f;
  const width = header[5]!;
  const symbols = header.readUInt16LE(6);
  if (groups > 4 || width > 32) throw typingFailure();
  if (symbols !== groups * width || (groups > 0 && width === 0)) throw typingFailure();
  const key: XkbKey = { code, types: [], groups: [] };
  for (let g = 0; g < groups; g++) {
    const typeIndex = header[g]!;
    const type = types[typeIndex];
    if (!type || type.levels > width) throw typingFailure();
    key.types.push(typeIndex);
    const row = cursor.take(width * 4);
    key.groups.push(Array.from({ length: width }, (_, i) => row.readUInt32LE(i * 4)));
  }
  return key;
}

export function parseXkbMap(data: Buffer, min: number, max: number, check: () => void = () => {}): Pick<Keyboard, "types" | "keys"> {
  if (data.length < 40 || data[10] !== min || data[11] !== max || data.readUInt16LE(12) !== 3) {
    throw typingFailure();
  }
  if (data[14] !== 0 || data[15] === 0 || data[15] !== data[16]) throw typingFailure();
  if (data[17] !== min || data[20] !== max - min + 1) throw typingFailure();
  const cursor = new Cursor(data, check);
  const types = Array.from({ length: data[15]! }, () => readType(cursor));
  const keys = Array.from({ length: data[20]! }, (_, i) => readKey(cursor, min + i, types));
  const symbols = keys.reduce((sum, key) => sum + key.groups.reduce((n, group) => n + group.length, 0), 0);
  if (cursor.offset !== data.length || symbols !== data.readUInt16LE(18)) throw typingFailure();
  return { types, keys };
}

export function parseCoreMap(data: Buffer, count: number): number[][] {
  const width = data[1]!;
  if (width === 0 || width > 32 || data.length !== 32 + count * width * 4) throw typingFailure();
  return Array.from({ length: count }, (_, row) =>
    Array.from({ length: width }, (_, col) => data.readUInt32LE(32 + (row * width + col) * 4)),
  );
}

export function parseModifiers(data: Buffer): { modifiers: Map<number, number>; modifierMask: number } {
  const width = data[1]!;
  if (data.length !== 32 + width * 8) throw typingFailure();
  const modifiers = new Map<number, number>();
  let modifierMask = 0;
  let ended = false;
  for (let i = 0; i < width * 8; i++) {
    if (i % width === 0) ended = false;
    const code = data[32 + i]!;
    if (code === 0) { ended = true; continue; }
    const mask = 1 << Math.floor(i / width);
    modifierMask |= mask;
    // Reserve even entries after a hole. xdotool's keycode-to-modifier query
    // stops at that hole and returns the first matching modifier group.
    if (!modifiers.has(code)) modifiers.set(code, 0);
    if (!ended && modifiers.get(code) === 0) modifiers.set(code, mask);
  }
  return { modifiers, modifierMask };
}

export async function negotiateXkb(wire: X11Wire): Promise<number> {
  const name = Buffer.from("XKEYBOARD", "ascii");
  const query = request(98, 20);
  query.writeUInt16LE(name.length, 4);
  name.copy(query, 8);
  const extension = await wire.reply(query);
  if (extension.length !== 32 || extension[8] !== 1 || extension[9]! < 128) throw typingFailure();
  const opcode = extension[9]!;
  const use = request(opcode, 8);
  use.writeUInt16LE(1, 4);
  const reply = await wire.reply(use);
  if (reply.length !== 32 || reply[1] !== 1 || reply.readUInt16LE(8) !== 1) throw typingFailure();
  return opcode;
}

export async function readKeyboard(wire: X11Wire, opcode: number, min: number, max: number): Promise<Keyboard> {
  const { modifiers, modifierMask } = parseModifiers(await wire.reply(request(119)));
  if ([...modifiers.keys()].some((code) => code < min || code > max)) throw typingFailure();
  const core = request(101, 8);
  core[4] = min;
  core[5] = max - min + 1;
  const rows = parseCoreMap(await wire.reply(core), max - min + 1);
  const xkb = request(opcode, 28, 8);
  xkb.writeUInt16LE(0x100, 4); // XkbUseCoreKbd
  xkb.writeUInt16LE(3, 6); // All key types and symbols, no unrelated components.
  return { min, max, rows, modifiers, modifierMask, ...parseXkbMap(await wire.reply(xkb), min, max, () => wire.check()) };
}

function translatedLevel(type: KeyType, mask: number): number {
  return type.entries.find((entry) => entry.active && entry.mask === (mask & type.mask))?.level ?? 0;
}

interface LookupEntry { symbol: number; usable: boolean }

function groupEntries(keyboard: Keyboard, key: XkbKey, group: number, family: XdotoolFamily): LookupEntry[] {
  const type = keyboard.types[key.types[group]!]!;
  const symbols = key.groups[group]!;
  // XkbTranslateKeyCode with state 0 selects group zero, using its own type.
  const zeroType = keyboard.types[key.types[0]!]!;
  const zeroSymbol = key.groups[0]![translatedLevel(zeroType, 0)];
  const result: LookupEntry[] = [];
  for (let level = 0; level < type.levels; level++) {
    const entry = type.entries.find((item) => item.active && item.level === level);
    const zero = level === 0 && zeroSymbol === symbols[level];
    if (family === "2026" && (symbols[0] === 0 || (!zero && !entry))) continue;
    let mask = (family === "2026" && zero ? 0 : entry?.mask ?? 0) | (keyboard.modifiers.get(key.code) ?? 0);
    const symbol = symbols[level]!;
    const cp = keysymToCodepoint(symbol);
    // The newer client overrides the selected mask for Latin capitals.
    if (family === "2026" && isLatinCapital(cp)) mask = 1;
    const canPressModifiers = (mask & ~keyboard.modifierMask) === 0;
    result.push({ symbol, usable: canPressModifiers && symbols[translatedLevel(type, mask)] === symbol });
  }
  return result;
}

function isLatinCapital(cp: number): boolean {
  return [[0x41, 0x5a], [0xc0, 0xd6], [0xd8, 0xde]].some(([lo, hi]) => cp >= lo! && cp <= hi!);
}

/** Preserve enumeration order: xdotool takes the first character match, then
 * the first exact keysym match. The pinned 2026 macro excludes its last entry.
 */
export function usableCodepoints(keyboard: Keyboard, family: XdotoolFamily, check: () => void = () => {}): Set<number> {
  const entries = keyboard.keys.flatMap((key) => {
    check();
    return key.groups.flatMap((_, group) => groupEntries(keyboard, key, group, family));
  });
  if (family === "2026") entries.pop();
  const first = new Map<number, boolean>();
  for (const entry of entries) {
    const cp = keysymToCodepoint(entry.symbol);
    if (!first.has(cp)) first.set(cp, entry.usable);
  }
  return new Set([...first].filter(([cp, usable]) => cp !== 0 && usable).map(([cp]) => cp));
}
