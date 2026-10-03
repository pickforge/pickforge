/**
 * Glyph style constants, and the report layout that glyph geometry depends on.
 * This module imports nothing, so the report renderer can read them while it
 * loads, even inside an import cycle.
 */

/** Stroke and halo colours, equal to the report's `--ember` and `--bg` tokens. */
export const GLYPH_COLOR = "#FF7A1A";
export const GLYPH_HALO_COLOR = "#0A0A0B";
/** Display pixels. The halo is drawn under every stroke and fill. */
export const GLYPH_STROKE_WIDTH = 2;
export const GLYPH_HALO_WIDTH = 4;
/** Dash and gap lengths in display pixels for `dashed` strokes. */
export const GLYPH_DASH: readonly [number, number] = [6, 4];
/**
 * CSS pixels of the report gallery stage, which uses border-box sizing. A
 * gallery preview is at most the height less both paddings, and the type
 * glyph keeps its tag whole at that height.
 */
export const GALLERY_STAGE_HEIGHT = 170;
export const GALLERY_STAGE_PADDING = 10;
