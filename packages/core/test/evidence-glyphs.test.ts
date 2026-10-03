import { describe, expect, it } from "vitest";
import {
  POINTER_GLYPH_VERSION,
  pointerGlyph,
  runPointerGlyphs,
  type EvidenceAction,
  type EvidenceRecord,
  type GlyphPart,
} from "../src/index.js";

const BEFORE = "screenshots/act-before.png";
const AFTER = "screenshots/act-after.png";
const SCREEN = { width: 1280, height: 800 } as const;

function action(overrides: Partial<EvidenceAction> = {}): EvidenceAction {
  return {
    actionId: "act-1", source: "mcp", tool: "desktop_click", startedAt: "2026-10-03T12:00:00.000Z", status: "ok",
    inputState: "completed", target: { x: 640, y: 400, coordinateSpace: "xvfb-root" }, artifacts: [BEFORE, AFTER],
    captures: [
      { path: BEFORE, phase: "before", width: 1280, height: 800 },
      { path: AFTER, phase: "after", width: 1280, height: 800 },
    ],
    ...overrides,
  };
}

const AT = { x: 640.5, y: 400.5 };
const ring = (at = AT, radius = 7, dashed = false): GlyphPart => ({ shape: "ring", at, radius, dashed });
const dot = (at = AT): GlyphPart => ({ shape: "dot", at, radius: 3 });

function parts(record: EvidenceAction, artifact = BEFORE): GlyphPart[] | undefined {
  return pointerGlyph(record, artifact, SCREEN)?.parts;
}

function label(record: EvidenceAction, artifact = BEFORE): string | undefined {
  return pointerGlyph(record, artifact, SCREEN)?.label;
}

describe("pointer glyphs per action kind", () => {
  it("carries the version, kind, capture size, phase and state", () => {
    expect(pointerGlyph(action(), AFTER, SCREEN)).toEqual({
      version: POINTER_GLYPH_VERSION, kind: "click", width: 1280, height: 800, phase: "after", state: "completed",
      parts: [ring(), dot()], label: "Pointer: click at 640, 400 · after · completed",
    });
  });

  it.each<[string, Partial<EvidenceAction>, GlyphPart[], GlyphPart[]]>([
    ["click", {}, [ring()], [ring(), dot()]],
    ["double click", { tool: "desktop_double_click" }, [ring(), ring(AT, 12)], [ring(), ring(AT, 12), dot()]],
  ])("rings a %s for intent and adds a dot for the result", (_kind, change, before, after) => {
    expect(parts(action(change), BEFORE)).toEqual(before);
    expect(parts(action(change), AFTER)).toEqual(after);
  });

  it("dashes every stroke of attempted input and keeps fills solid", () => {
    const attempted = action({ tool: "desktop_double_click", inputState: "attempted" });
    expect(parts(attempted, BEFORE)).toEqual([ring(AT, 7, true), ring(AT, 12, true)]);
    expect(parts(attempted, AFTER)).toEqual([ring(AT, 7, true), ring(AT, 12, true), dot()]);
    expect(label(attempted)).toBe("Pointer: double click at 640, 400 · before · attempted");
  });

  describe("drag", () => {
    const target = { fromX: 10, fromY: 20, x: 640, y: 400, coordinateSpace: "xvfb-root" };
    const from = { x: 10.5, y: 20.5 };
    const drag = (change: Partial<EvidenceAction> = {}) => action({ tool: "desktop_drag", target, ...change });

    it("shows the press point, the path and the direction before, and both ends after", () => {
      expect(parts(drag(), BEFORE)).toEqual([
        { shape: "line", from, to: AT, dashed: false }, ring(from),
        { shape: "arrow", at: AT, dx: 630, dy: 380, offset: 2, size: 9 },
      ]);
      expect(parts(drag(), AFTER)).toEqual([{ shape: "line", from, to: AT, dashed: false }, dot(from), ring(), dot()]);
      expect(label(drag(), AFTER)).toBe("Pointer: drag 10, 20 → 640, 400 · after · completed");
    });

    it("dashes the line and rings of an attempted drag", () => {
      const attempted = drag({ inputState: "attempted" });
      expect(parts(attempted)?.slice(0, 2)).toEqual([{ shape: "line", from, to: AT, dashed: true }, ring(from, 7, true)]);
      expect(parts(attempted, AFTER)).toEqual([{ shape: "line", from, to: AT, dashed: true }, dot(from), ring(AT, 7, true), dot()]);
    });

    it("draws no arrow for a drag that ends where it starts", () => {
      const still = drag({ target: { fromX: 640, fromY: 400, x: 640, y: 400, coordinateSpace: "xvfb-root" } });
      expect(parts(still)).toEqual([{ shape: "line", from: AT, to: AT, dashed: false }, ring()]);
    });
  });

  describe("scroll", () => {
    const scroll = (wheel: Record<string, number>, change: Partial<EvidenceAction> = {}) =>
      action({ tool: "desktop_scroll", target: { x: 640, y: 400, coordinateSpace: "xvfb-root", ...wheel }, ...change });
    const arrow = (dx: number, dy: number): GlyphPart => ({ shape: "arrow", at: AT, dx, dy, offset: 22, size: 9 });

    it.each<[Record<string, number>, number, number, string]>([
      [{ wheelX: 0, wheelY: 3 }, 0, 3, "down 3"],
      [{ wheelX: 0, wheelY: -2 }, 0, -2, "up 2"],
      [{ wheelX: 4, wheelY: 0 }, 4, 0, "right 4"],
      [{ wheelX: -1, wheelY: -2 }, -1, -2, "up 2 and left 1"],
    ])("points an arrow along %j", (wheel, dx, dy, words) => {
      expect(parts(scroll(wheel), BEFORE)).toEqual([ring(), arrow(dx, dy)]);
      expect(parts(scroll(wheel), AFTER)).toEqual([ring(), dot(), arrow(dx, dy)]);
      expect(label(scroll(wheel))).toBe(`Pointer: scroll ${words} at 640, 400 · before · completed`);
    });

    it.each<[string, Record<string, number>]>([
      ["zero steps", { wheelX: 0, wheelY: 0 }],
      ["no recorded steps", {}],
      ["a lone wheel axis", { wheelY: 3 }],
    ])("keeps a plain ring without direction for %s", (_label, wheel) => {
      expect(parts(scroll(wheel), BEFORE)).toEqual([ring()]);
      expect(parts(scroll(wheel), AFTER)).toEqual([ring(), dot()]);
      expect(label(scroll(wheel))).toBe("Pointer: scroll at 640, 400 · before · completed");
    });

    it("dashes an attempted scroll ring", () => {
      expect(parts(scroll({ wheelX: 0, wheelY: 1 }, { inputState: "attempted" }))).toEqual([ring(AT, 7, true), arrow(0, 1)]);
    });

    it("needs a verified point", () => {
      expect(parts(action({ tool: "desktop_scroll", target: { wheelX: 0, wheelY: 3 } }))).toBeUndefined();
    });
  });

  describe("type", () => {
    const focus = { x: 100, y: 50, width: 600, height: 400 };
    const typed = (window: Record<string, number> = focus, change: Partial<EvidenceAction> = {}) => action({
      tool: "desktop_type", target: { length: 12, inputType: "text", focus: window, coordinateSpace: "xvfb-root" }, ...change,
    });
    const box = (window = focus, dashed = false): GlyphPart => ({ shape: "box", ...window, dashed });
    const caret = (at: { x: number; y: number }): GlyphPart => ({ shape: "caret", at, size: 16 });

    it("marks the focused window with a caret, and the result with a dot", () => {
      const at = { x: 400, y: 250 };
      expect(parts(typed(), BEFORE)).toEqual([box(), caret(at)]);
      expect(parts(typed(), AFTER)).toEqual([box(), caret(at), dot(at)]);
      expect(label(typed(), AFTER)).toBe("Keyboard: type into the focused window · after · completed");
    });

    it("never names typed text, keys or lengths", () => {
      const glyph = pointerGlyph(typed(), AFTER, SCREEN)!;
      expect(glyph.label).not.toMatch(/\d/);
      expect(JSON.stringify(glyph)).not.toMatch(/length|inputType|text"/);
    });

    it("dashes the box of attempted input", () => {
      expect(parts(typed(focus, { inputState: "attempted" }))?.[0]).toEqual(box(focus, true));
    });

    it("centres the caret on the visible part of a window that leaves the capture", () => {
      const window = { x: -200, y: 600, width: 400, height: 1000 };
      expect(parts(typed(window))).toEqual([box(window), caret({ x: 100, y: 700 })]);
    });

    it.each<[string, Record<string, number>]>([
      ["left of", { x: -400, y: 0, width: 400, height: 100 }],
      ["right of", { x: 1280, y: 0, width: 400, height: 100 }],
      ["above", { x: 0, y: -100, width: 400, height: 100 }],
      ["below", { x: 0, y: 800, width: 400, height: 100 }],
    ])("draws nothing for a window %s the capture", (_label, window) => {
      expect(parts(typed(window))).toBeUndefined();
    });

    it.each<[string, Record<string, unknown>]>([
      ["no focus", { length: 3, coordinateSpace: "xvfb-root" }],
      ["an unverified focus", { focus }],
      ["an empty focus", { focus: { x: 0, y: 0, width: 0, height: 10 }, coordinateSpace: "xvfb-root" }],
      ["a fractional focus", { focus: { ...focus, x: 0.5 }, coordinateSpace: "xvfb-root" }],
      ["a partial focus", { focus: { x: 0, y: 0, width: 10 }, coordinateSpace: "xvfb-root" }],
    ])("draws nothing for %s", (_label, target) => {
      expect(parts(action({ tool: "desktop_type", target }))).toBeUndefined();
    });
  });
});

describe("pointer glyph qualification", () => {
  it.each<[string, Partial<EvidenceAction>]>([
    ["desktop_move", { tool: "desktop_move" }],
    ["an unknown tool", { tool: "desktop_screenshot" }],
    ["a hostile tool name", { tool: "desktop_<img src=x>" }],
    ["a non-string tool", { tool: 7 as never }],
    ["not-attempted input", { inputState: "not-attempted" }],
    ["a missing input state", { inputState: undefined }],
    ["an unknown input state", { inputState: "done" as never }],
    ["missing captures", { captures: undefined }],
    ["malformed captures", { captures: BEFORE as never }],
    ["an unknown phase", { captures: [{ path: BEFORE, phase: "during" as never, width: 1280, height: 800 }] }],
    ["duplicate phases", { captures: [
      { path: BEFORE, phase: "before", width: 1280, height: 800 },
      { path: AFTER, phase: "before", width: 1280, height: 800 },
    ] }],
    ["a duplicate path", { captures: [
      { path: BEFORE, phase: "before", width: 1280, height: 800 },
      { path: BEFORE, phase: "after", width: 1280, height: 800 },
    ] }],
    ["a missing coordinate space", { target: { x: 640, y: 400 } }],
    ["an unknown coordinate space", { target: { x: 640, y: 400, coordinateSpace: "screen" } }],
    ["a missing target", { target: undefined }],
    ["an x at the image width", { target: { x: 1280, y: 400, coordinateSpace: "xvfb-root" } }],
    ["a y at the image height", { target: { x: 10, y: 800, coordinateSpace: "xvfb-root" } }],
    ["a negative point", { target: { x: -1, y: 10, coordinateSpace: "xvfb-root" } }],
    ["a fractional point", { target: { x: 10.4, y: 10, coordinateSpace: "xvfb-root" } }],
    ["a drag start outside the image", { tool: "desktop_drag", target: { fromX: 1280, fromY: 0, x: 10, y: 10, coordinateSpace: "xvfb-root" } }],
    ["a partial drag start", { tool: "desktop_drag", target: { fromX: 5, x: 10, y: 10, coordinateSpace: "xvfb-root" } }],
    ["a drag without a start point", { tool: "desktop_drag" }],
    ["a link to a path outside the artifacts", { artifacts: [AFTER] }],
    ["missing artifacts", { artifacts: undefined }],
    ["a capture with a zero size", { captures: [{ path: BEFORE, phase: "before", width: 0, height: 800 }] }],
  ])("draws nothing for %s", (_label, change) => {
    expect(pointerGlyph(action(change), BEFORE, SCREEN)).toBeUndefined();
  });

  it.each([
    ["no PNG size", undefined],
    ["a cropped PNG", { width: 1279, height: 800 }],
    ["a shorter PNG", { width: 1280, height: 799 }],
    ["a larger PNG", { width: 2560, height: 1600 }],
  ])("draws nothing for %s", (_label, size) => {
    expect(pointerGlyph(action(), BEFORE, size)).toBeUndefined();
  });

  it("anchors corner pixels at their centres", () => {
    const corner = (x: number, y: number) => pointerGlyph(action({
      target: { x, y, coordinateSpace: "xvfb-root" }, captures: [{ path: BEFORE, phase: "before", width: 200, height: 120 }],
    }), BEFORE, { width: 200, height: 120 })?.parts;
    expect(corner(0, 0)).toEqual([ring({ x: 0.5, y: 0.5 })]);
    expect(corner(199, 119)).toEqual([ring({ x: 199.5, y: 119.5 })]);
  });

  it("ignores a drag start on a click", () => {
    expect(parts(action({ target: { fromX: 1, fromY: 2, x: 640, y: 400, coordinateSpace: "xvfb-root" } }))).toEqual([ring()]);
  });
});

describe("run pointer glyphs", () => {
  const sizes = (paths: readonly string[]) => new Map(paths.map((relative) => [relative, SCREEN]));
  const other = (change: Partial<EvidenceAction>): EvidenceAction => ({
    actionId: "act-2", source: "mcp", tool: "desktop_screenshot", startedAt: "2026-10-03T12:00:01.000Z", status: "ok", ...change,
  });

  it("keys each linked capture by path", () => {
    const glyphs = runPointerGlyphs([action()], sizes([BEFORE, AFTER]));
    expect([...glyphs.keys()]).toEqual([BEFORE, AFTER]);
    expect(glyphs.get(BEFORE)).toEqual(pointerGlyph(action(), BEFORE, SCREEN));
    expect(glyphs.get(AFTER)?.phase).toBe("after");
  });

  it("skips paths without a validated size", () => {
    expect([...runPointerGlyphs([action()], sizes([AFTER])).keys()]).toEqual([AFTER]);
    expect(runPointerGlyphs([action()], new Map()).size).toBe(0);
  });

  it.each<[string, EvidenceAction]>([
    ["artifacts", other({ artifacts: [AFTER] })],
    ["capture links", other({ captures: [{ path: AFTER, phase: "after", width: 1280, height: 800 }] })],
    ["malformed capture links", other({ captures: [{ path: AFTER } as never] })],
  ])("drops a path another record claims in its %s", (_label, claim) => {
    for (const records of [[action(), claim], [claim, action()]]) {
      expect([...runPointerGlyphs(records, sizes([BEFORE, AFTER])).keys()]).toEqual([BEFORE]);
    }
  });

  it("drops a path two qualifying actions both claim", () => {
    const second = action({ actionId: "act-2", startedAt: "2026-10-03T12:00:01.000Z", artifacts: [AFTER], captures: [{ path: AFTER, phase: "after", width: 1280, height: 800 }] });
    expect([...runPointerGlyphs([action(), second], sizes([BEFORE, AFTER])).keys()]).toEqual([BEFORE]);
  });

  it("never marks another action's capture", () => {
    const elsewhere = "screenshots/other.png";
    const records = [action({ artifacts: [BEFORE], captures: [{ path: elsewhere, phase: "after", width: 1280, height: 800 }] }), other({ artifacts: [elsewhere] })];
    expect(runPointerGlyphs(records, sizes([BEFORE, elsewhere])).size).toBe(0);
  });

  it("skips outcome and truncation records", () => {
    const records: EvidenceRecord[] = [
      action(),
      // Path fields on these records would contest the captures if they were read.
      { actionId: "trunc", evidenceTruncated: true, reason: "evidence-cap", bytes: 10, maxBytes: 10, recordedAt: "2026-10-03T12:00:02.000Z", artifacts: [BEFORE] } as never,
      { kind: "outcome", status: "pass", recordedAt: "2026-10-03T12:00:03.000Z", inspectedScreenshots: [BEFORE], artifacts: [AFTER] } as never,
    ];
    expect([...runPointerGlyphs(records, sizes([BEFORE, AFTER])).keys()]).toEqual([BEFORE, AFTER]);
  });

  it("marks nothing for older records without input state or capture links", () => {
    const { captures: _captures, inputState: _inputState, ...older } = action();
    expect(runPointerGlyphs([older], sizes([BEFORE, AFTER])).size).toBe(0);
  });
});
