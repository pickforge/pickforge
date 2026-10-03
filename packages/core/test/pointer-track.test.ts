import { expect, it } from "vitest";
import { createPointerTrack } from "../src/pointer-track.js";
import type { EvidenceAction, EvidenceRecord } from "../src/evidence.js";
const action = (overrides: Partial<EvidenceAction> = {}): EvidenceAction => ({
  actionId: "pointer",
  source: "mcp",
  tool: "desktop_click",
  status: "ok",
  startedAt: "2026-10-03T12:00:00.000Z",
  inputState: "completed",
  target: { x: 4, y: 5, coordinateSpace: "xvfb-root" },
  ...overrides,
});
it("includes all pointer kinds with ordered timing and signed steps", () => {
  const records = [
    action({
      tool: "desktop_drag",
      actionId: "drag",
      durationMs: 42,
      startedAt: "2026-10-03T12:00:01.000Z",
      target: { x: 6, y: 7, fromX: 1, fromY: 2, coordinateSpace: "xvfb-root" },
    }),
    action({
      tool: "desktop_scroll",
      actionId: "scroll",
      target: { x: 4, y: 5, coordinateSpace: "xvfb-root", wheelX: -2, wheelY: 3 },
      inputState: "attempted",
    }),
    action({ actionId: "click" }),
    action({ tool: "desktop_double_click", actionId: "double" }),
    action({ tool: "desktop_move", actionId: "move" }),
  ];
  const track = createPointerTrack("run", records);
  expect(track.clock).toEqual({
    source: "wall-clock-action-records",
    approximate: true,
    origin: "2026-10-03T12:00:00.000Z",
  });
  expect(track.events.map((e) => e.kind)).toEqual([
    "click",
    "double-click",
    "move",
    "scroll",
    "drag",
  ]);
  expect(track.events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
  expect(track.events[3]).toMatchObject({
    milliseconds: 0,
    wheelSteps: { x: -2, y: 3 },
    inputState: "attempted",
  });
  expect(track.events[4]).toMatchObject({
    milliseconds: 1000,
    durationMs: 42,
    dragStart: { x: 1, y: 2 },
    point: { x: 6, y: 7 },
  });
});
it("excludes keyboard records and all typed metadata, including attached pointer metadata", () => {
  const typed = {
    x: 4,
    y: 5,
    coordinateSpace: "xvfb-root",
    text: "SECRET-TEXT",
    keys: "SECRET-KEYS",
    length: 12345,
    name: "SECRET-LABEL",
    typed: { length: 54321 },
  };
  const track = createPointerTrack("run", [
    action({ tool: "desktop_type", target: typed }),
    action({ tool: "desktop_key", target: typed }),
    action({ target: typed }),
  ]);
  expect(track.events).toHaveLength(1);
  expect(JSON.stringify(track)).not.toMatch(/SECRET|12345|54321|text|keys|length|name/);
  expect(track.events[0]).toEqual({
    sequence: 1,
    milliseconds: 0,
    actionId: "pointer",
    kind: "click",
    point: { x: 4, y: 5 },
    inputState: "completed",
  });
});
it.each([
  { inputState: undefined },
  { inputState: "not-attempted" },
  { startedAt: "bad" },
  { target: { x: 4, y: 5 } },
  { target: { x: 4.5, y: 5, coordinateSpace: "xvfb-root" } },
  { target: { x: -1, y: 5, coordinateSpace: "xvfb-root" } },
  { target: { x: Infinity, y: 5, coordinateSpace: "xvfb-root" } },
  { target: { x: 4, y: 5, fromX: 1, coordinateSpace: "xvfb-root" } },
  { target: null },
  { tool: "toString" },
])("drops older or invalid records %j", (override) => {
  expect(createPointerTrack("run", [action(override as Partial<EvidenceAction>)])).toMatchObject({
    version: 1,
    events: [],
    clock: { origin: null },
  });
});
it("omits invalid optional values and excludes non-actions", () => {
  const records: EvidenceRecord[] = [
    action({
      tool: "desktop_scroll",
      durationMs: -1,
      target: { x: 4, y: 5, coordinateSpace: "xvfb-root", wheelX: 1.5, wheelY: "secret" },
    }),
    {
      actionId: "cap",
      evidenceTruncated: true,
      recordedAt: "2026-10-03",
      reason: "evidence-cap",
      bytes: 1,
      maxBytes: 1,
    },
  ];
  const event = createPointerTrack("run", records).events[0]!;
  expect(event).not.toHaveProperty("durationMs");
  expect(event).not.toHaveProperty("wheelSteps");
});
