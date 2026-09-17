import { createHash } from "node:crypto";
import fs from "node:fs";
import { expect, it } from "vitest";
import { legacyKeysyms } from "../src/x11-legacy-keysyms.js";
import { bindingSymbols, codepointToKeysym, keysymToCodepoint } from "../src/x11-keysyms.js";
import { parseCoreMap, parseModifiers, parseXkbMap, usableCodepoints, type Keyboard, type KeyType } from "../src/x11-keymap.js";
import { planBindings } from "../src/x11-prebind.js";
import { FakeXServer } from "./x11-fixture.js";

it("matches every legacy entry extracted from the pinned public-domain source", () => {
  const extracted = fs.readFileSync(new URL("./fixtures/keysym-utf.txt", import.meta.url), "utf8");
  expect(createHash("sha256").update(extracted).digest("hex")).toBe("42fb8f09fc9856517ce2fca52138bbba0a59d8f6870b16dba9f557f03a7b07f2");
  const pairs = extracted.trim().split("\n").map((line) => line.split(" ").map((n) => Number.parseInt(n, 16)));
  expect(pairs).toHaveLength(763);
  expect(legacyKeysyms.size).toBe(763);
  let previous = 0;
  for (const [symbol, cp] of pairs) {
    expect(symbol!).toBeGreaterThan(previous);
    expect(cp!).toBeGreaterThan(0);
    expect(cp!).toBeLessThan(0x10000);
    expect(keysymToCodepoint(symbol!)).toBe(cp);
    previous = symbol!;
  }
});

// Published X11/keysymdef.h constants, not derived from our conversion helper.
it.each([[0x01a1, 0x0104], [0x06d1, 0x044f], [0x07e1, 0x03b1], [0x0ce0, 0x05d0], [0x0da1, 0x0e01], [0xff80, 32], [0xff09, 9], [0xff0a, 10], [0xff0d, 13], [0xffff, 127], [0xffb7, 55], [0x0101f600, 0x1f600]])("converts published symbol %i", (symbol, cp) => {
  expect(keysymToCodepoint(symbol!)).toBe(cp);
});

it("rejects invalid direct Unicode and preserves literal decomposed text", () => {
  expect(keysymToCodepoint(0x0100d800)).toBe(0);
  expect(keysymToCodepoint(0x01110000)).toBe(0);
  expect(keysymToCodepoint(0)).toBe(0);
  expect(bindingSymbols(new Set([0x61, 0x301]))).toEqual([[0x61, 0x41], [0x01000301, 0x01000301]]);
  expect(bindingSymbols(new Set([0xe1, 0xc1]))).toEqual([[0xe1, 0xc1]]);
  expect(codepointToKeysym(10)).toBe(0xff0a);
  expect(bindingSymbols(new Set([0x1c5, 0x1c6, 0x1c4]))).toEqual([[0x010001c5, 0x010001c5], [0x010001c6, 0x010001c4]]);
});

function keyboard(type: KeyType, symbols: number[]): Keyboard {
  return {
    min: 8, max: 10, modifiers: new Map(), modifierMask: 1, types: [type],
    rows: [[], symbols, [0xffe1]],
    keys: [{ code: 8, types: [], groups: [] }, { code: 9, types: [0], groups: [symbols] }, { code: 10, types: [0], groups: [[0xffe1]] }],
  };
}

function twoGroups(): Keyboard {
  const fixture = new FakeXServer("unused-no-socket-started");
  fixture.rows.set(150, [0x61, 0x41, 0x7e1, 0x7c1]);
  return { min: 8, max: 255, rows: Array.from({ length: 248 }, (_, i) => fixture.rows.get(i + 8) ?? []), modifiers: new Map([[200, 1]]), modifierMask: 1, ...parseXkbMap(fixture.xkbReply(), 8, 255) };
}

it("compares group-zero translation with the enumerated group symbol", () => {
  const map = twoGroups();
  expect(usableCodepoints(map, "2016").has(0x3b1)).toBe(true);
  expect(usableCodepoints(map, "2026").has(0x3b1)).toBe(false);
  expect(usableCodepoints(map, "2026").has(0x391)).toBe(true); // Explicit Shift entry survives.
  expect(planBindings(map, [[0x010003b1, 0x010003b1]], "2026")).toEqual([{ code: 255, symbols: [0x010003b1, 0x010003b1] }]);
});

it("uses group-zero's own type and selected level, preserving equal symbols and explicit entries", () => {
  const map = twoGroups();
  map.types.push({ mask: 1, levels: 2, entries: [{ active: true, mask: 0, level: 1 }, { active: true, mask: 1, level: 0 }] });
  const key = map.keys[150 - 8]!;
  key.types[0] = 2; // At state zero this group produces A, not a or alpha.
  expect(usableCodepoints(map, "2026").has(0x3b1)).toBe(false);
  key.groups[1]![0] = 0x41; // Equality is by keysym, not group or level number.
  expect(usableCodepoints(map, "2026").has(0x41)).toBe(true);
  key.groups[1]![0] = 0x7e1;
  map.types[key.types[1]!]!.entries.push({ active: true, mask: 0, level: 0 });
  expect(usableCodepoints(map, "2026").has(0x3b1)).toBe(true);
  expect(planBindings(map, [[0x010003b1, 0x010003b1]], "2026")).toEqual([]);
});

it("preserves equal symbols when group zero selects a nonzero level", () => {
  const map = twoGroups();
  map.keys[150 - 8] = { code: 150, types: [], groups: [] };
  map.rows[150 - 8] = [];
  map.types.push({ mask: 1, levels: 2, entries: [{ active: true, mask: 0, level: 1 }] });
  // Two valid groups with a common padded width: TWO_LEVEL then ONE_LEVEL.
  // Only alpha has an entry in group zero. The equal group-one entry keeps
  // that first entry from becoming the pinned client's excluded final entry.
  map.keys[255 - 8] = { code: 255, types: [2, 0], groups: [[0x61, 0x7e1], [0x7e1, 0]] };
  map.rows[255 - 8] = [0x61, 0x7e1, 0x7e1, 0];
  expect(usableCodepoints(map, "2026").has(0x3b1)).toBe(true);
  expect(planBindings(map, [[0x010003b1, 0x010003b1]], "2026")).toEqual([]);
  map.keys[255 - 8]!.groups[1] = [0, 0];
  expect(usableCodepoints(map, "2026").has(0x3b1)).toBe(false);
});

it("does not mistake an unreachable level for an available character", () => {
  const map = keyboard({ mask: 1, levels: 2, entries: [] }, [0xe1, 0xe9]);
  expect(usableCodepoints(map, "2016").has(0xe9)).toBe(false);
  expect(usableCodepoints(map, "2026").has(0xe9)).toBe(false);
});

it("honors the newer zero-modifier translation rule and last-entry exclusion", () => {
  const map = keyboard({ mask: 1, levels: 2, entries: [{ active: true, mask: 0, level: 1 }] }, [0xe1, 0xe9]);
  // Zero modifiers explicitly select level two, so level one is unreachable.
  expect(usableCodepoints(map, "2026")).toEqual(new Set([0xe9]));
  map.keys.pop();
  expect(usableCodepoints(map, "2016")).toEqual(new Set([0xe9]));
  expect(usableCodepoints(map, "2026")).toEqual(new Set());
});

it("accounts for explicit server case expansion and the newer Latin shift override", () => {
  const map = keyboard({ mask: 1, levels: 2, entries: [{ active: true, mask: 1, level: 1 }] }, [0xe1, 0xc1]);
  expect(usableCodepoints(map, "2026")).toEqual(new Set([0xe1, 0xc1]));
  expect(planBindings(map, [[0xe1, 0xc1]], "2026")).toEqual([]);
});

it("rejects malformed XKB component dimensions, truncated types and trailing bytes", () => {
  const fixture = new FakeXServer("unused-no-socket-started");
  const good = fixture.xkbReply();
  expect(parseXkbMap(good, 8, 255).keys).toHaveLength(248);
  for (const offset of [10, 11, 12, 14, 15, 16, 17, 20, 44, 54, 56, 58, 68, 69, 72, 76, 78]) {
    const malformed = Buffer.from(good);
    malformed[offset] = malformed[offset]! ^ 0xff;
    expect(() => parseXkbMap(malformed, 8, 255)).toThrow("preparation failed");
  }
  expect(() => parseXkbMap(good.subarray(0, 47), 8, 255)).toThrow();
  expect(() => parseXkbMap(Buffer.concat([good, Buffer.alloc(4)]), 8, 255)).toThrow();
  expect(() => parseXkbMap(good, 8, 255, () => { throw new Error("absolute deadline"); })).toThrow("absolute deadline");
});

it("preserves modifier entries after holes and models first-match modifier masks", () => {
  const reply = Buffer.alloc(32 + 3 * 8);
  reply[1] = 3;
  reply[33] = 250; // Shift has a leading hole: reserved, but lookup skips it.
  reply[35] = 250; reply[36] = 251; // Lock lookup wins over a later group.
  reply[38] = 251;
  const mapping = parseModifiers(reply);
  expect(mapping.modifiers).toEqual(new Map([[250, 2], [251, 2]]));
  expect(mapping.modifierMask).toBe(7);
  const map = keyboard({ mask: 1, levels: 2, entries: [{ active: true, mask: 1, level: 1 }] }, [0x61, 0x41]);
  map.modifierMask = 0;
  expect(usableCodepoints(map, "2016").has(0x41)).toBe(false);
  expect(usableCodepoints(map, "2026").has(0x41)).toBe(false);
});

it("bounds core and modifier dimensions including legal empty modifier maps", () => {
  expect(parseModifiers(Buffer.alloc(32))).toEqual({ modifiers: new Map(), modifierMask: 0 });
  const bad = Buffer.alloc(32); bad[1] = 255;
  expect(() => parseModifiers(bad)).toThrow();
  expect(() => parseCoreMap(Buffer.alloc(32), 248)).toThrow();
  expect(() => parseCoreMap(bad, 248)).toThrow();
});
