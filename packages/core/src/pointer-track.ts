import { isTruncationRecord, type EvidenceAction, type EvidenceRecord } from "./evidence.js";
import { isOutcomeRecord } from "./evidence-outcome.js";
import { sortEvidenceRecords } from "./evidence-render.js";
import { sanitizeActionTarget } from "./evidence-sanitize.js";

export type PointerEventKind = "move" | "click" | "double-click" | "drag" | "scroll";
export interface PointerTrackEvent {
  sequence: number;
  milliseconds: number;
  durationMs?: number;
  actionId: string;
  kind: PointerEventKind;
  point: { x: number; y: number };
  dragStart?: { x: number; y: number };
  wheelSteps?: { x?: number; y?: number };
  inputState: "attempted" | "completed";
}
export interface PointerTrack {
  schema: "pickforge.pointer-track";
  version: 1;
  runId: string;
  coordinateSpace: "xvfb-root";
  clock: { source: "wall-clock-action-records"; approximate: true; origin: string | null };
  events: PointerTrackEvent[];
}

const KINDS: Readonly<Record<string, PointerEventKind>> = {
  desktop_move: "move", desktop_click: "click", desktop_double_click: "double-click",
  desktop_drag: "drag", desktop_scroll: "scroll",
};

function wheelStep(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function optionalTimingAndWheel(record: EvidenceAction, kind: PointerEventKind): Pick<PointerTrackEvent, "durationMs" | "wheelSteps"> {
  const fields: Pick<PointerTrackEvent, "durationMs" | "wheelSteps"> = {};
  if (typeof record.durationMs === "number" && Number.isFinite(record.durationMs) && record.durationMs >= 0) fields.durationMs = record.durationMs;
  if (kind === "scroll") {
    // Recheck the signed-step allowlist independently for older sanitizer versions.
    const x = wheelStep(record.target?.wheelX), y = wheelStep(record.target?.wheelY);
    if (x !== undefined || y !== undefined) fields.wheelSteps = { ...(x === undefined ? {} : { x }), ...(y === undefined ? {} : { y }) };
  }
  return fields;
}

function pointerEvent(record: EvidenceAction): Omit<PointerTrackEvent, "sequence" | "milliseconds"> | undefined {
  const kind = Object.hasOwn(KINDS, record.tool) ? KINDS[record.tool] : undefined;
  const target = sanitizeActionTarget(record.target);
  const state = record.inputState;
  if (kind === undefined || target.coordinateSpace !== "xvfb-root" || target.x === undefined || target.y === undefined ||
      (state !== "attempted" && state !== "completed")) return undefined;
  const event: Omit<PointerTrackEvent, "sequence" | "milliseconds"> = {
    actionId: record.actionId, kind, point: { x: target.x, y: target.y }, inputState: state, ...optionalTimingAndWheel(record, kind),
  };
  if (kind === "drag" && target.fromX !== undefined && target.fromY !== undefined) event.dragStart = { x: target.fromX, y: target.fromY };
  return event;
}

/** An explicit field allowlist prevents keyboard data or target labels from escaping. */
export function createPointerTrack(runId: string, records: readonly EvidenceRecord[]): PointerTrack {
  const candidates = sortEvidenceRecords(records).flatMap(record => {
    if (isTruncationRecord(record) || isOutcomeRecord(record)) return [];
    const event = pointerEvent(record), time = Date.parse(record.startedAt);
    return event === undefined || !Number.isFinite(time) ? [] : [{ event, time }];
  }).sort((a, b) => a.time - b.time);
  const origin = candidates[0]?.time;
  return {
    schema: "pickforge.pointer-track", version: 1, runId, coordinateSpace: "xvfb-root",
    clock: { source: "wall-clock-action-records", approximate: true, origin: origin === undefined ? null : new Date(origin).toISOString() },
    events: candidates.map(({ event, time }, index) => ({ sequence: index + 1, milliseconds: time - origin!, ...event })),
  };
}
