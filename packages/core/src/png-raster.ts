import { deflateSync, inflateSync, crc32 } from "node:zlib";
import { completePngSize, MAX_SHARE_IMAGE_BYTES, PNG_SIGNATURE } from "./evidence-png.js";
import {
  GLYPH_COLOR,
  GLYPH_HALO_COLOR,
  GLYPH_STROKE_WIDTH,
  GLYPH_HALO_WIDTH,
  GLYPH_DASH,
} from "./evidence-glyph-style.js";
import type { GlyphPart, GlyphPoint, PointerGlyph } from "./evidence-glyphs.js";

/** RGBA buffers are capped at 32 MiB; filtered scanlines at 72 MiB. */
export const MAX_RASTER_PIXELS = 8 * 1024 * 1024;
export interface PngRaster {
  width: number;
  height: number;
  pixels: Buffer;
}

function validRasterDimension(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function assertRasterSize(width: number, height: number): void {
  if (
    !validRasterDimension(width) ||
    !validRasterDimension(height) ||
    width * height > MAX_RASTER_PIXELS
  ) {
    throw new Error("PNG exceeds raster pixel cap or has invalid dimensions");
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const da = Math.abs(p - a);
  const db = Math.abs(p - b);
  const dc = Math.abs(p - c);
  return da <= db && da <= dc ? a : db <= dc ? b : c;
}

function unfilter(raw: Buffer, stride: number, height: number, channels: number): Buffer {
  for (let y = 0; y < height; y += 1) {
    const input = y * (stride + 1);
    const row = input + 1;
    const filter = raw[input]!;
    if (filter > 4) {
      throw new Error("Unsupported PNG row filter");
    }
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? raw[row + x - channels]! : 0;
      const b = y > 0 ? raw[row + x - stride - 1]! : 0;
      const c = y > 0 && x >= channels ? raw[row + x - stride - 1 - channels]! : 0;
      const predictor = [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][filter]!;
      raw[row + x] = (raw[input + x + 1]! + predictor) & 255;
    }
  }
  return raw;
}

interface PngLayout {
  width: number;
  height: number;
  depth: number;
  color: number;
  samples: number;
  palette?: Buffer;
  transparent?: Buffer;
  compressed: Buffer[];
}
interface PngPass {
  x: number;
  y: number;
  dx: number;
  dy: number;
  width: number;
  height: number;
  stride: number;
}

function pngLayout(bytes: Buffer): PngLayout {
  const color = bytes[25]!;
  const layout: PngLayout = {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    depth: bytes[24]!,
    color,
    samples: ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color]!,
    compressed: [],
  };
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IDAT") {
      layout.compressed.push(data);
    } else if (type === "PLTE") {
      layout.palette = data;
    } else if (type === "tRNS") {
      layout.transparent = data;
    }
    offset += 12 + length;
  }
  return layout;
}

function pngPasses(layout: PngLayout, interlaced: boolean): PngPass[] {
  const steps = interlaced
    ? [
        [0, 0, 8, 8],
        [4, 0, 8, 8],
        [0, 4, 4, 8],
        [2, 0, 4, 4],
        [0, 2, 2, 4],
        [1, 0, 2, 2],
        [0, 1, 1, 2],
      ]
    : [[0, 0, 1, 1]];
  return steps
    .map(([x, y, dx, dy]) => {
      const width = Math.max(0, Math.ceil((layout.width - x!) / dx!));
      const height = Math.max(0, Math.ceil((layout.height - y!) / dy!));
      return {
        x: x!,
        y: y!,
        dx: dx!,
        dy: dy!,
        width,
        height,
        stride: Math.ceil((width * layout.samples * layout.depth) / 8),
      };
    })
    .filter((pass) => pass.width > 0 && pass.height > 0);
}

function sample(row: Buffer, index: number, depth: number): number {
  if (depth === 16) {
    return row.readUInt16BE(index * 2);
  }
  if (depth === 8) {
    return row[index]!;
  }
  const bit = index * depth;
  return (row[Math.floor(bit / 8)]! >> (8 - depth - (bit % 8))) & ((1 << depth) - 1);
}

function indexedPixel(index: number, layout: PngLayout): number[] {
  const palette = layout.palette;
  if (palette === undefined || palette.length % 3 !== 0 || palette.length > 768) {
    throw new Error("Invalid PNG palette");
  }
  if (index * 3 + 2 >= palette.length) {
    throw new Error("PNG palette index out of range");
  }
  return [
    palette[index * 3]!,
    palette[index * 3 + 1]!,
    palette[index * 3 + 2]!,
    layout.transparent?.[index] ?? 255,
  ];
}

function rgbaSample(values: number[], layout: PngLayout): number[] {
  if (layout.color === 3) {
    return indexedPixel(values[0]!, layout);
  }
  // Scale the full sample range, rounding 16-bit values to the nearest byte.
  const maximum = 2 ** layout.depth - 1;
  const scaled = values.map((value) => Math.round((value * 255) / maximum));
  const gray = layout.color === 0 || layout.color === 4;
  const rgb = gray ? [scaled[0]!, scaled[0]!, scaled[0]!] : scaled.slice(0, 3);
  if (layout.color === 4 || layout.color === 6) {
    return [...rgb, scaled.at(-1)!];
  }
  const transparent = layout.transparent;
  const hidden =
    transparent?.length === (gray ? 2 : 6) &&
    values.every((value, i) => value === transparent.readUInt16BE(i * 2));
  return [...rgb, hidden ? 0 : 255];
}

function decodePass(raw: Buffer, pass: PngPass, layout: PngLayout, pixels: Buffer): void {
  const bpp = Math.max(1, Math.ceil((layout.samples * layout.depth) / 8));
  const decoded = unfilter(raw, pass.stride, pass.height, bpp);
  for (let y = 0; y < pass.height; y += 1) {
    const row = decoded.subarray(y * (pass.stride + 1) + 1, (y + 1) * (pass.stride + 1));
    for (let x = 0; x < pass.width; x += 1) {
      const values = Array.from({ length: layout.samples }, (_, i) =>
        sample(row, x * layout.samples + i, layout.depth),
      );
      const index = ((pass.y + y * pass.dy) * layout.width + pass.x + x * pass.dx) * 4;
      pixels.set(rgbaSample(values, layout), index);
    }
  }
}

/** Decode all PNG colour depths and Adam7 passes into bounded RGBA8 buffers. */
export function decodePng(bytes: Buffer): PngRaster {
  if (bytes.length > MAX_SHARE_IMAGE_BYTES) {
    throw new Error("PNG exceeds compressed byte cap");
  }
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.length < 33) {
    throw new Error("Invalid PNG");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  assertRasterSize(width, height);
  if (completePngSize(bytes) === undefined) {
    throw new Error("Invalid PNG");
  }
  const layout = pngLayout(bytes);
  const passes = pngPasses(layout, bytes[28] === 1);
  const length = passes.reduce((sum, pass) => sum + pass.height * (pass.stride + 1), 0);
  if (length > 9 * MAX_RASTER_PIXELS) {
    throw new Error("PNG exceeds scanline memory cap");
  }
  const raw = inflateSync(Buffer.concat(layout.compressed), { maxOutputLength: length });
  if (raw.length !== length) {
    throw new Error("Invalid PNG scanline length");
  }
  const pixels = Buffer.alloc(width * height * 4);
  let offset = 0;
  for (const pass of passes) {
    const end = offset + pass.height * (pass.stride + 1);
    decodePass(raw.subarray(offset, end), pass, layout, pixels);
    offset = end;
  }
  return { width, height, pixels };
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
  if (pixels.length !== width * height * 4) {
    throw new Error("Invalid raster buffer length");
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

type Geometry = {
  bounds: [number, number, number, number];
  distance: (x: number, y: number) => number;
  distanceBound?: (x: number, y: number) => number;
};
const dashOn = (length: number) => {
  const period = GLYPH_DASH[0] + GLYPH_DASH[1];
  return ((length % period) + period) % period < GLYPH_DASH[0];
};

function segment(
  from: GlyphPoint,
  to: GlyphPoint,
  x: number,
  y: number,
): {
  distance: number;
  along: number;
  projection: number;
  length: number;
} {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  const projection = length === 0 ? 0 : ((x - from.x) * dx + (y - from.y) * dy) / length;
  const along = Math.max(0, Math.min(length, projection));
  return {
    distance: Math.hypot(
      x - from.x - (length === 0 ? 0 : (dx * along) / length),
      y - from.y - (length === 0 ? 0 : (dy * along) / length),
    ),
    along,
    projection,
    length,
  };
}

function strokes(points: GlyphPoint[], dashed: boolean, butt = dashed): Geometry {
  return {
    bounds: [
      Math.min(...points.map((p) => p.x)),
      Math.min(...points.map((p) => p.y)),
      Math.max(...points.map((p) => p.x)),
      Math.max(...points.map((p) => p.y)),
    ],
    distanceBound: (x, y) =>
      Math.min(
        ...points
          .slice(1)
          .map((to, i) => segment(points[i]!, to, x, y).distance - GLYPH_STROKE_WIDTH / 2),
      ),
    distance: (x, y) => {
      let best = Infinity;
      let offset = 0;
      for (let i = 1; i < points.length; i += 1) {
        const from = points[i - 1]!;
        const to = points[i]!;
        const hit = segment(from, to, x, y);
        const within =
          !butt || (hit.length > 0 && hit.projection >= 0 && hit.projection <= hit.length);
        if (within && (!dashed || dashOn(offset + hit.along))) {
          best = Math.min(best, hit.distance - GLYPH_STROKE_WIDTH / 2);
        }
        offset += Math.hypot(to.x - from.x, to.y - from.y);
      }
      return best;
    },
  };
}

/** Rectangles use miter joins; only uninterrupted dashes join at a corner. */
function box(
  part: Extract<
    GlyphPart,
    {
      shape: "box";
    }
  >,
): Geometry {
  const { x, y, width: w, height: h, dashed } = part;
  const points = [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
    { x, y },
  ];
  const edges = strokes(points, dashed, true);
  const perimeter = 2 * (w + h);
  const phases = [0, w, w + h, 2 * w + h];
  const corners = points
    .slice(0, 4)
    .map((point, index) => ({ point, index }))
    .filter(({ index: i }) => {
      const before = i === 0 ? perimeter : phases[i]!;
      return !dashed || (dashOn(before - 1e-7) && dashOn(phases[i]! + 1e-7));
    });
  return {
    bounds: edges.bounds,
    distanceBound: (px, py) =>
      Math.min(
        edges.distanceBound!(px, py),
        ...points
          .slice(0, 4)
          .map((p) => Math.max(Math.abs(px - p.x), Math.abs(py - p.y)) - GLYPH_STROKE_WIDTH / 2),
      ),
    distance: (px, py) =>
      Math.min(
        edges.distance(px, py),
        ...corners.map(({ point: p, index }) => {
          const outsideX = index === 0 || index === 3 ? px < p.x : px > p.x;
          const outsideY = index < 2 ? py < p.y : py > p.y;
          return outsideX && outsideY
            ? Math.max(Math.abs(px - p.x), Math.abs(py - p.y)) - GLYPH_STROKE_WIDTH / 2
            : Infinity;
        }),
      ),
  };
}

function arrow(
  part: Extract<
    GlyphPart,
    {
      shape: "arrow";
    }
  >,
): Geometry {
  const length = Math.hypot(part.dx, part.dy);
  const ux = part.dx / length;
  const uy = part.dy / length;
  const tip = { x: part.at.x + ux * part.offset, y: part.at.y + uy * part.offset };
  const base = { x: tip.x - ux * part.size, y: tip.y - uy * part.size };
  const left = { x: base.x - (uy * part.size) / 2, y: base.y + (ux * part.size) / 2 };
  const right = { x: base.x + (uy * part.size) / 2, y: base.y - (ux * part.size) / 2 };
  const points = [tip, left, right, tip];
  return {
    bounds: strokes(points, false).bounds,
    distance: (x, y) => {
      const localX = (x - base.x) * ux + (y - base.y) * uy;
      const localY = -(x - base.x) * uy + (y - base.y) * ux;
      const inside =
        localX >= 0 && localX <= part.size && Math.abs(localY) <= (part.size - localX) / 2;
      const distance = Math.min(
        ...points.slice(1).map((p, i) => segment(points[i]!, p, x, y).distance),
      );
      return inside ? -distance : distance;
    },
  };
}

function geometry(part: GlyphPart): Geometry {
  if (part.shape === "ring" || part.shape === "dot") {
    const { at, radius } = part;
    return {
      bounds: [at.x - radius, at.y - radius, at.x + radius, at.y + radius],
      distanceBound: (x, y) =>
        part.shape === "dot"
          ? Math.hypot(x - at.x, y - at.y) - radius
          : Math.abs(Math.hypot(x - at.x, y - at.y) - radius) - GLYPH_STROKE_WIDTH / 2,
      distance: (x, y) => {
        const dx = x - at.x;
        const dy = y - at.y;
        if (part.shape === "dot") {
          return Math.hypot(dx, dy) - radius;
        }
        const angle = (Math.atan2(dy, dx) + Math.PI * 2) % (Math.PI * 2);
        return part.dashed && !dashOn(angle * radius)
          ? Infinity
          : Math.abs(Math.hypot(dx, dy) - radius) - GLYPH_STROKE_WIDTH / 2;
      },
    };
  }
  if (part.shape === "line") {
    return strokes([part.from, part.to], part.dashed);
  }
  if (part.shape === "arrow") {
    return arrow(part);
  }
  if (part.shape === "box") {
    return box(part);
  }
  const { at, size } = part;
  const top = at.y - size / 2;
  const bottom = at.y + size / 2;
  const cap = size / 4;
  const pieces = [
    strokes(
      [
        { x: at.x, y: top },
        { x: at.x, y: bottom },
      ],
      false,
    ),
    strokes(
      [
        { x: at.x - cap, y: top },
        { x: at.x + cap, y: top },
      ],
      false,
    ),
    strokes(
      [
        { x: at.x - cap, y: bottom },
        { x: at.x + cap, y: bottom },
      ],
      false,
    ),
  ];
  return {
    bounds: [at.x - cap, top, at.x + cap, bottom],
    distance: (x, y) => Math.min(...pieces.map((p) => p.distance(x, y))),
  };
}

function blend(pixels: Buffer, index: number, color: number[], coverage: number): void {
  const sourceAlpha = coverage / 16;
  const destAlpha = pixels[index + 3]! / 255;
  const alpha = sourceAlpha + destAlpha * (1 - sourceAlpha);
  for (let c = 0; c < 3; c += 1) {
    pixels[index + c] = Math.round(
      (color[c]! * sourceAlpha + pixels[index + c]! * destAlpha * (1 - sourceAlpha)) / alpha,
    );
  }
  pixels[index + 3] = Math.round(alpha * 255);
}

function drawLayer(raster: PngRaster, shape: Geometry, color: string, expansion: number): void {
  const rgb = [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16));
  const [left, top, right, bottom] = shape.bounds;
  const margin = GLYPH_HALO_WIDTH;
  for (
    let y = Math.max(0, Math.floor(top - margin));
    y < Math.min(raster.height, Math.ceil(bottom + margin));
    y += 1
  ) {
    for (
      let x = Math.max(0, Math.floor(left - margin));
      x < Math.min(raster.width, Math.ceil(right + margin));
      x += 1
    ) {
      // Dash gaps are discontinuous. Use the continuous stroke as a lower bound.
      const bound = shape.distanceBound ?? shape.distance;
      if (bound(x + 0.5, y + 0.5) > expansion + 1) {
        continue;
      }
      const coverage = sampleCoverage(shape, x, y, expansion);
      if (coverage > 0) {
        blend(raster.pixels, (y * raster.width + x) * 4, rgb, coverage);
      }
    }
  }
}

function sampleCoverage(shape: Geometry, x: number, y: number, expansion: number): number {
  let coverage = 0;
  for (let sy = 0; sy < 4; sy += 1) {
    for (let sx = 0; sx < 4; sx += 1) {
      if (shape.distance(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4) <= expansion) {
        coverage += 1;
      }
    }
  }
  return coverage;
}

/** Four-by-four coverage sampling. Labels are deliberately excluded. */
export function drawPointerGlyph(raster: PngRaster, glyph: PointerGlyph): void {
  assertRasterSize(raster.width, raster.height);
  if (glyph.width !== raster.width || glyph.height !== raster.height) {
    throw new Error("Glyph size differs from PNG size");
  }
  for (const part of glyph.parts) {
    const shape = geometry(part);
    drawLayer(raster, shape, GLYPH_HALO_COLOR, (GLYPH_HALO_WIDTH - GLYPH_STROKE_WIDTH) / 2);
    drawLayer(raster, shape, GLYPH_COLOR, 0);
  }
}
