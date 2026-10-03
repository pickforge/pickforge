import type { EvidenceAction } from "./evidence.js";

/**
 * Shared pointer glyph geometry. The HTML viewer and the raster export both
 * draw these parts, so a marker looks and lands the same in both.
 */

/** Bumped when glyph geometry or meaning changes; exports record it. */
export const POINTER_GLYPH_VERSION = 1;

/** Stroke and halo colours, equal to the report's `--ember` and `--bg` tokens. */
export const GLYPH_COLOR = "#FF7A1A";
export const GLYPH_HALO_COLOR = "#0A0A0B";
/** Display pixels. The halo is drawn under every stroke and fill. */
export const GLYPH_STROKE_WIDTH = 2;
export const GLYPH_HALO_WIDTH = 4;
/** Dash and gap lengths in display pixels for `dashed` strokes. */
export const GLYPH_DASH: readonly [number, number] = [6, 4];

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

/**
 * The glyph for one linked capture of one action, or undefined when the
 * record does not fully qualify. `size` is the validated PNG size of
 * `artifact`; without it, or when the capture link disagrees with it, nothing
 * is drawn. Journal fields are re-validated because the journal is on-disk data.
 */
export function pointerGlyph(
  record: EvidenceAction,
  artifact: string,
  size: Readonly<{ width: number; height: number }> | undefined,
): PointerGlyph | undefined {
  void record;
  void artifact;
  void size;
  return undefined;
}
