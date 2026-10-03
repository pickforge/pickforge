/**
 * Glyph style constants. This module imports nothing, so the report renderer
 * can read them while it loads, even inside an import cycle.
 */

/** Stroke and halo colours, equal to the report's `--ember` and `--bg` tokens. */
export const GLYPH_COLOR = "#FF7A1A";
export const GLYPH_HALO_COLOR = "#0A0A0B";
/** Display pixels. The halo is drawn under every stroke and fill. */
export const GLYPH_STROKE_WIDTH = 2;
export const GLYPH_HALO_WIDTH = 4;
/** Dash and gap lengths in display pixels for `dashed` strokes. */
export const GLYPH_DASH: readonly [number, number] = [6, 4];
