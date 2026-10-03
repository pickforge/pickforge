import { isTruncationRecord, type EvidenceAction, type EvidenceCaptureLink, type EvidenceRecord } from "./evidence.js";
import { isOutcomeRecord } from "./evidence-outcome.js";
import { GLYPH_HALO_WIDTH } from "./evidence-glyph-style.js";
import type { PngSize } from "./evidence-png.js";
import { sanitizeActionTarget, sanitizeCaptureLinks, type SanitizedActionTarget } from "./evidence-sanitize.js";

/**
 * Shared pointer glyph geometry. The HTML viewer and the raster export both
 * draw these parts, so a marker looks and lands the same in both.
 */

/** Bumped when glyph geometry or meaning changes; exports record it. */
export const POINTER_GLYPH_VERSION = 1;

export { GLYPH_COLOR, GLYPH_DASH, GLYPH_HALO_COLOR, GLYPH_HALO_WIDTH, GLYPH_STROKE_WIDTH } from "./evidence-glyph-style.js";

export type PointerGlyphKind = "click" | "double-click" | "drag" | "scroll" | "type-focus";

/**
 * A point in capture pixels. Pixel (i, j) covers [i, i + 1) x [j, j + 1), so
 * its centre is (i + 0.5, j + 0.5). Fractional values are allowed.
 */
export interface GlyphPoint {
  x: number;
  y: number;
}

/**
 * One drawable part. Anchors (`at`, `from`, `to`) and boxes are in capture
 * pixels. Radii, sizes and offsets are in display pixels: the HTML viewer
 * keeps them constant on screen, and a raster export draws them 1:1 in image
 * pixels. Renderers clip every part to the capture rectangle.
 */
export type GlyphPart =
  /** Hollow circle centred on `at`; `radius` is to the middle of the stroke. */
  | { shape: "ring"; at: GlyphPoint; radius: number; dashed: boolean }
  /** Filled circle centred on `at`. */
  | { shape: "dot"; at: GlyphPoint; radius: number }
  /** Straight stroke between two capture points. */
  | { shape: "line"; from: GlyphPoint; to: GlyphPoint; dashed: boolean }
  /**
   * Filled isosceles triangle pointing along (`dx`, `dy`), which need not be
   * normalised but is never (0, 0). Its tip sits `offset` display pixels from
   * `at` along that direction; `size` is both its length and base width.
   */
  | { shape: "arrow"; at: GlyphPoint; dx: number; dy: number; offset: number; size: number }
  /** Rectangle outline in capture pixels, for example a focused window. */
  | { shape: "box"; x: number; y: number; width: number; height: number; dashed: boolean }
  /** I-beam text caret centred on `at`, `size` display pixels tall. */
  | { shape: "caret"; at: GlyphPoint; size: number };

export interface PointerGlyph {
  version: typeof POINTER_GLYPH_VERSION;
  kind: PointerGlyphKind;
  /** Capture size the anchors refer to; equals the validated PNG size. */
  width: number;
  height: number;
  /** Before captures show intent; after captures show the result. */
  phase: "before" | "after";
  /** Attempted input is drawn so it stays distinguishable from completed input. */
  state: "attempted" | "completed";
  /** Drawn in order. */
  parts: GlyphPart[];
  /** Plain text, already redacted and bounded; not HTML-escaped. */
  label: string;
}


/** Display pixels. The base ring matches the 16 px ring from #199. */
const RING_RADIUS = 7;
const OUTER_RING_RADIUS = 12;
const DOT_RADIUS = 3;
const ARROW_SIZE = 9;
/** A drag arrow tip just past the line end, so it covers the line's round cap. */
const DRAG_ARROW_OFFSET = GLYPH_HALO_WIDTH / 2;
/** A scroll arrow clear of the ring and its halo, so it reads as a direction. */
const SCROLL_ARROW_OFFSET = RING_RADIUS + GLYPH_HALO_WIDTH / 2 + 4 + ARROW_SIZE;
const CARET_SIZE = 16;
/** Holds the caret, its serif tips and both halos with a clear gap. */
const CARET_RING_RADIUS = 13;
/** From the caret marker's centre to the outer edge of its ring halo. */
const CARET_REACH = CARET_RING_RADIUS + GLYPH_HALO_WIDTH / 2;
/**
 * Capture pixels from the visible window corner to the caret marker. At 1:1
 * the box halo reaches half a halo width inside the window, and 3 px of the
 * image stays visible between it and the ring halo.
 */
const CARET_INSET = CARET_REACH + GLYPH_HALO_WIDTH / 2 + 3;
/**
 * The HTML viewer keeps marker sizes fixed on screen, so a scaled-down preview
 * shrinks only the inset. Report gallery previews are at most this many pixels
 * tall. The caret marker keeps a matching distance from the capture's top and
 * left edges, so it stays whole there.
 */
const PREVIEW_HEIGHT = 150;

/** desktop_move takes no captures, so it never gets a glyph. */
const KINDS: ReadonlyMap<unknown, PointerGlyphKind> = new Map([
  ["desktop_click", "click"],
  ["desktop_double_click", "double-click"],
  ["desktop_drag", "drag"],
  ["desktop_scroll", "scroll"],
  ["desktop_type", "type-focus"],
]);

interface GlyphInput {
  kind: PointerGlyphKind;
  target: SanitizedActionTarget;
  width: number;
  height: number;
  phase: PointerGlyph["phase"];
  dashed: boolean;
}

type Drawing = Pick<PointerGlyph, "parts" | "label">;

/**
 * The glyph for one linked capture of one action, or undefined when the
 * record does not fully qualify. `size` is the validated PNG size of
 * `artifact`; without it, or when the capture link disagrees with it, nothing
 * is drawn. Journal fields are re-validated because the journal is on-disk data.
 */
export function pointerGlyph(
  record: EvidenceAction,
  artifact: string,
  size: Readonly<PngSize> | undefined,
): PointerGlyph | undefined {
  const kind = KINDS.get(record.tool);
  const state = record.inputState;
  if (kind === undefined || (state !== "attempted" && state !== "completed")) return undefined;
  const link = sizedLink(record, artifact, size);
  if (link === undefined) return undefined;
  const target = sanitizeActionTarget(record.target);
  if (target.coordinateSpace !== "xvfb-root") return undefined;
  const { width, height, phase } = link;
  const drawing = draw({ kind, target, width, height, phase, dashed: state === "attempted" });
  if (drawing === undefined) return undefined;
  return {
    version: POINTER_GLYPH_VERSION, kind, width, height, phase, state,
    parts: drawing.parts, label: `${drawing.label} · ${phase} · ${state}`,
  };
}

/** The capture link for `artifact`, only when its size equals the actual PNG. */
function sizedLink(record: EvidenceAction, artifact: string, size: Readonly<PngSize> | undefined): EvidenceCaptureLink | undefined {
  if (size === undefined || !Array.isArray(record.artifacts) || !record.artifacts.includes(artifact)) return undefined;
  const link = sanitizeCaptureLinks(record.captures).find((entry) => entry.path === artifact);
  return link?.width === size.width && link.height === size.height ? link : undefined;
}

function draw(input: GlyphInput): Drawing | undefined {
  if (input.kind === "type-focus") return typeFocus(input);
  const { x, y } = input.target;
  if (x === undefined || y === undefined || !inside(input, x, y)) return undefined;
  const at = centre(x, y);
  if (input.kind === "drag") return drag(input, at);
  if (input.kind === "scroll") return scroll(input, at);
  const rings = input.kind === "double-click" ? [RING_RADIUS, OUTER_RING_RADIUS] : [RING_RADIUS];
  const verb = input.kind === "double-click" ? "double click" : "click";
  return { parts: [...rings.map((radius) => ring(at, radius, input.dashed)), ...landed(input, at)], label: `Pointer: ${verb} at ${x}, ${y}` };
}

/** Intent marks the press point and the path; the result marks both ends. */
function drag(input: GlyphInput, to: GlyphPoint): Drawing | undefined {
  const { fromX, fromY, x, y } = input.target;
  if (fromX === undefined || fromY === undefined || !inside(input, fromX, fromY)) return undefined;
  const from = centre(fromX, fromY);
  const parts: GlyphPart[] = [{ shape: "line", from, to, dashed: input.dashed }];
  if (input.phase === "before") {
    parts.push(ring(from, RING_RADIUS, input.dashed));
    if (fromX !== x || fromY !== y) parts.push(arrow(to, to.x - from.x, to.y - from.y, DRAG_ARROW_OFFSET));
  } else {
    parts.push(dot(from), ring(to, RING_RADIUS, input.dashed), dot(to));
  }
  return { parts, label: `Pointer: drag ${fromX}, ${fromY} → ${x}, ${y}` };
}

/** A scroll without recorded steps keeps the plain ring and no direction. */
function scroll(input: GlyphInput, at: GlyphPoint): Drawing {
  const { wheelX = 0, wheelY = 0, x, y } = input.target;
  const parts = [ring(at, RING_RADIUS, input.dashed), ...landed(input, at)];
  if (wheelX !== 0 || wheelY !== 0) parts.push(arrow(at, wheelX, wheelY, SCROLL_ARROW_OFFSET));
  const steps = [stepText(wheelY, "up", "down"), stepText(wheelX, "left", "right")].filter((text) => text !== "");
  return { parts, label: `Pointer: scroll ${steps.length === 0 ? "" : `${steps.join(" and ")} `}at ${x}, ${y}` };
}

function stepText(steps: number, negative: string, positive: string): string {
  if (steps === 0) return "";
  return `${steps < 0 ? negative : positive} ${Math.abs(steps)}`;
}

/**
 * The focused window, and a caret in a ring just inside the top-left corner of
 * its visible part. The marker keeps clear of the capture's top and left edges
 * in a gallery preview, and never passes the middle of the visible part. It
 * tags the window. It claims no text position and no landing point, so the
 * result phase adds no dot and shows only in the label. Attempted input dashes
 * the ring as well as the box, so the state stays visible when the box falls
 * outside the capture. The label names no text or length.
 */
function typeFocus(input: GlyphInput): Drawing | undefined {
  const { focus } = input.target;
  if (focus === undefined) return undefined;
  const left = Math.max(focus.x, 0);
  const top = Math.max(focus.y, 0);
  const right = Math.min(focus.x + focus.width, input.width);
  const bottom = Math.min(focus.y + focus.height, input.height);
  if (left >= right || top >= bottom) return undefined;
  const edge = Math.ceil(CARET_REACH * input.height / PREVIEW_HEIGHT);
  const at = { x: tagCoordinate(left, right, edge), y: tagCoordinate(top, bottom, edge) };
  return {
    parts: [{ shape: "box", ...focus, dashed: input.dashed }, ring(at, CARET_RING_RADIUS, input.dashed), { shape: "caret", at, size: CARET_SIZE }],
    label: "Keyboard: type into the focused window",
  };
}

/** Inset from the start of a visible span and from the capture edge, at most to the span's middle. */
function tagCoordinate(start: number, end: number, edge: number): number {
  return Math.min(Math.max(start + CARET_INSET, edge), (start + end) / 2);
}

/** The result phase adds a filled dot where the input landed. */
function landed(input: GlyphInput, at: GlyphPoint): GlyphPart[] {
  return input.phase === "after" ? [dot(at)] : [];
}

function inside(input: GlyphInput, x: number, y: number): boolean {
  return x < input.width && y < input.height;
}

function centre(x: number, y: number): GlyphPoint {
  return { x: x + 0.5, y: y + 0.5 };
}

function ring(at: GlyphPoint, radius: number, dashed: boolean): GlyphPart {
  return { shape: "ring", at, radius, dashed };
}

function dot(at: GlyphPoint): GlyphPart {
  return { shape: "dot", at, radius: DOT_RADIUS };
}

function arrow(at: GlyphPoint, dx: number, dy: number, offset: number): GlyphPart {
  return { shape: "arrow", at, dx, dy, offset, size: ARROW_SIZE };
}

function claimedPaths(record: EvidenceAction): Set<string> {
  const artifacts: unknown[] = Array.isArray(record.artifacts) ? record.artifacts : [];
  const links: unknown[] = Array.isArray(record.captures) ? record.captures : [];
  const linked = links.map((entry) => (entry as { path?: unknown } | null)?.path);
  return new Set([...artifacts, ...linked].filter((entry): entry is string => typeof entry === "string"));
}

/**
 * Glyphs for a whole run, keyed by run-relative capture path. A path claimed
 * by more than one action record, through `artifacts` or `captures`, gets no
 * glyph because no single action owns it. `sizes` holds validated PNG sizes;
 * a path without one gets no glyph. Outcome and truncation records are skipped.
 * The HTML viewer and the raster export both use this, so they mark the same
 * captures.
 */
export function runPointerGlyphs(
  records: readonly EvidenceRecord[],
  sizes: ReadonlyMap<string, Readonly<PngSize>>,
): Map<string, PointerGlyph> {
  const actions = records.filter((record): record is EvidenceAction => !isTruncationRecord(record) && !isOutcomeRecord(record));
  const owners = new Map<string, EvidenceAction | undefined>();
  for (const action of actions) {
    for (const claimed of claimedPaths(action)) owners.set(claimed, owners.has(claimed) ? undefined : action);
  }
  const glyphs = new Map<string, PointerGlyph>();
  for (const [artifact, owner] of owners) {
    const glyph = owner === undefined ? undefined : pointerGlyph(owner, artifact, sizes.get(artifact));
    if (glyph !== undefined) glyphs.set(artifact, glyph);
  }
  return glyphs;
}
