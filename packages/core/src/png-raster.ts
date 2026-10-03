import { deflateSync, inflateSync, crc32 } from "node:zlib";
import { completePngSize, MAX_SHARE_IMAGE_BYTES, PNG_SIGNATURE } from "./evidence-png.js";
import {
  GLYPH_COLOR, GLYPH_HALO_COLOR, GLYPH_STROKE_WIDTH, GLYPH_HALO_WIDTH, GLYPH_DASH,
  type GlyphPart, type GlyphPoint, type PointerGlyph,
} from "./evidence-glyphs.js";

/** Each RGBA or scanline buffer is bounded to about 32 MiB. */
export const MAX_RASTER_PIXELS = 8 * 1024 * 1024;
export interface PngRaster { width: number; height: number; pixels: Buffer }

export function assertRasterSize(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > MAX_RASTER_PIXELS) {
    throw new Error("PNG exceeds raster pixel cap or has invalid dimensions");
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c);
  return da <= db && da <= dc ? a : db <= dc ? b : c;
}

function unfilter(raw: Buffer, width: number, height: number, channels: number): Buffer {
  const stride = width * channels;
  const decoded = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride, input = y * (stride + 1), filter = raw[input]!;
    if (filter > 4) throw new Error("Unsupported PNG row filter");
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? decoded[row + x - channels]! : 0;
      const b = y > 0 ? decoded[row + x - stride]! : 0;
      const c = y > 0 && x >= channels ? decoded[row + x - stride - channels]! : 0;
      const predictor = [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][filter]!;
      decoded[row + x] = (raw[input + x + 1]! + predictor) & 255;
    }
  }
  return decoded;
}

/** Decode 8-bit RGB/RGBA, non-interlaced PNGs. Other layouts fail explicitly. */
export function decodePng(bytes: Buffer): PngRaster {
  if (bytes.length > MAX_SHARE_IMAGE_BYTES) throw new Error("PNG exceeds compressed byte cap");
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.length < 33) throw new Error("Invalid PNG");
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  assertRasterSize(width, height);
  if (completePngSize(bytes) === undefined) throw new Error("Invalid PNG");
  const color = bytes[25];
  if (bytes[24] !== 8 || (color !== 2 && color !== 6) || bytes[28] !== 0) throw new Error("Unsupported PNG raster layout");
  const channels = color === 2 ? 3 : 4;
  const parts: Buffer[] = [];
  let transparent: Buffer | undefined;
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IDAT") parts.push(data);
    if (type === "tRNS") transparent = data;
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(parts), { maxOutputLength: height * (width * channels + 1) });
  const decoded = unfilter(raw, width, height, channels);
  return { width, height, pixels: rgbaPixels(decoded, channels, transparent) };
}

function rgbaPixels(decoded: Buffer, channels: number, transparent: Buffer | undefined): Buffer {
  const count = decoded.length / channels;
  const pixels = Buffer.alloc(count * 4);
  for (let i = 0; i < count; i += 1) {
    decoded.copy(pixels, i * 4, i * channels, i * channels + 3);
    const transparentRgb = channels === 3 && transparent?.length === 6 &&
      [0, 1, 2].every((c) => decoded[i * channels + c] === transparent!.readUInt16BE(c * 2));
    pixels[i * 4 + 3] = channels === 4 ? decoded[i * 4 + 3]! : transparentRgb ? 0 : 255;
  }
  return pixels;
}

function chunk(type: string, data: Buffer): Buffer {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  result.write(type, 4, 4, "ascii");
  data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)) >>> 0, result.length - 4);
  return result;
}

/** Deterministic RGBA encoding, with filter zero and a fixed zlib level. */
export function encodePng(raster: PngRaster): Buffer {
  const { width, height, pixels } = raster;
  assertRasterSize(width, height);
  if (pixels.length !== width * height * 4) throw new Error("Invalid raster buffer length");
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const stride = width * 4, raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

type Geometry = { bounds: [number, number, number, number]; distance: (x: number, y: number) => number };
const dashOn = (length: number) => {
  const period = GLYPH_DASH[0] + GLYPH_DASH[1];
  return ((length % period) + period) % period < GLYPH_DASH[0];
};

function segment(from: GlyphPoint, to: GlyphPoint, x: number, y: number): { distance: number; along: number } {
  const dx = to.x - from.x, dy = to.y - from.y, length = Math.hypot(dx, dy);
  const along = length === 0 ? 0 : Math.max(0, Math.min(length, ((x - from.x) * dx + (y - from.y) * dy) / length));
  return { distance: Math.hypot(x - from.x - (length === 0 ? 0 : dx * along / length), y - from.y - (length === 0 ? 0 : dy * along / length)), along };
}

function strokes(points: GlyphPoint[], dashed: boolean): Geometry {
  return {
    bounds: [Math.min(...points.map(p => p.x)), Math.min(...points.map(p => p.y)), Math.max(...points.map(p => p.x)), Math.max(...points.map(p => p.y))],
    distance: (x, y) => {
      let best = Infinity, offset = 0;
      for (let i = 1; i < points.length; i += 1) {
        const from = points[i - 1]!, to = points[i]!, hit = segment(from, to, x, y);
        if (!dashed || dashOn(offset + hit.along)) best = Math.min(best, hit.distance - GLYPH_STROKE_WIDTH / 2);
        offset += Math.hypot(to.x - from.x, to.y - from.y);
      }
      return best;
    },
  };
}

function arrow(part: Extract<GlyphPart, { shape: "arrow" }>): Geometry {
  const length = Math.hypot(part.dx, part.dy), ux = part.dx / length, uy = part.dy / length;
  const tip = { x: part.at.x + ux * part.offset, y: part.at.y + uy * part.offset };
  const base = { x: tip.x - ux * part.size, y: tip.y - uy * part.size };
  const left = { x: base.x - uy * part.size / 2, y: base.y + ux * part.size / 2 };
  const right = { x: base.x + uy * part.size / 2, y: base.y - ux * part.size / 2 };
  const points = [tip, left, right, tip];
  return { bounds: strokes(points, false).bounds, distance: (x, y) => {
    const localX = (x - base.x) * ux + (y - base.y) * uy;
    const localY = -(x - base.x) * uy + (y - base.y) * ux;
    const inside = localX >= 0 && localX <= part.size && Math.abs(localY) <= (part.size - localX) / 2;
    const distance = Math.min(...points.slice(1).map((p, i) => segment(points[i]!, p, x, y).distance));
    return inside ? -distance : distance;
  } };
}

function geometry(part: GlyphPart): Geometry {
  if (part.shape === "ring" || part.shape === "dot") {
    const { at, radius } = part;
    return { bounds: [at.x - radius, at.y - radius, at.x + radius, at.y + radius], distance: (x, y) => {
      const dx = x - at.x, dy = y - at.y;
      if (part.shape === "dot") return Math.hypot(dx, dy) - radius;
      const angle = (Math.atan2(dy, dx) + Math.PI * 2) % (Math.PI * 2);
      return part.dashed && !dashOn(angle * radius) ? Infinity : Math.abs(Math.hypot(dx, dy) - radius) - GLYPH_STROKE_WIDTH / 2;
    } };
  }
  if (part.shape === "line") return strokes([part.from, part.to], part.dashed);
  if (part.shape === "arrow") return arrow(part);
  if (part.shape === "box") {
    const { x, y, width: w, height: h } = part;
    return strokes([{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x, y }], part.dashed);
  }
  const { at, size } = part, top = at.y - size / 2, bottom = at.y + size / 2, cap = size / 6;
  const pieces = [strokes([{ x: at.x, y: top }, { x: at.x, y: bottom }], false),
    strokes([{ x: at.x - cap, y: top }, { x: at.x + cap, y: top }], false),
    strokes([{ x: at.x - cap, y: bottom }, { x: at.x + cap, y: bottom }], false)];
  return { bounds: [at.x - cap, top, at.x + cap, bottom], distance: (x, y) => Math.min(...pieces.map(p => p.distance(x, y))) };
}

function blend(pixels: Buffer, index: number, color: number[], coverage: number): void {
  const sourceAlpha = coverage / 16, destAlpha = pixels[index + 3]! / 255;
  const alpha = sourceAlpha + destAlpha * (1 - sourceAlpha);
  for (let c = 0; c < 3; c += 1) pixels[index + c] = Math.round((color[c]! * sourceAlpha + pixels[index + c]! * destAlpha * (1 - sourceAlpha)) / alpha);
  pixels[index + 3] = Math.round(alpha * 255);
}

function drawLayer(raster: PngRaster, shape: Geometry, color: string, expansion: number): void {
  const rgb = [1, 3, 5].map(i => Number.parseInt(color.slice(i, i + 2), 16));
  const [left, top, right, bottom] = shape.bounds, margin = GLYPH_HALO_WIDTH;
  for (let y = Math.max(0, Math.floor(top - margin)); y < Math.min(raster.height, Math.ceil(bottom + margin)); y += 1) {
    for (let x = Math.max(0, Math.floor(left - margin)); x < Math.min(raster.width, Math.ceil(right + margin)); x += 1) {
      const coverage = sampleCoverage(shape, x, y, expansion);
      if (coverage > 0) blend(raster.pixels, (y * raster.width + x) * 4, rgb, coverage);
    }
  }
}

function sampleCoverage(shape: Geometry, x: number, y: number, expansion: number): number {
  let coverage = 0;
  for (let sy = 0; sy < 4; sy += 1) for (let sx = 0; sx < 4; sx += 1) {
    if (shape.distance(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4) <= expansion) coverage += 1;
  }
  return coverage;
}

/** Four-by-four coverage sampling. Labels are deliberately excluded. */
export function drawPointerGlyph(raster: PngRaster, glyph: PointerGlyph): void {
  assertRasterSize(raster.width, raster.height);
  if (glyph.width !== raster.width || glyph.height !== raster.height) throw new Error("Glyph size differs from PNG size");
  for (const part of glyph.parts) {
    const shape = geometry(part);
    const filled = part.shape === "dot" || part.shape === "arrow";
    drawLayer(raster, shape, GLYPH_HALO_COLOR, filled ? GLYPH_HALO_WIDTH / 2 : (GLYPH_HALO_WIDTH - GLYPH_STROKE_WIDTH) / 2);
    drawLayer(raster, shape, GLYPH_COLOR, 0);
  }
}
