import { crc32, deflateSync } from "node:zlib";
import { expect, it } from "vitest";
import {
  assertRasterSize,
  decodePng,
  drawPointerGlyph,
  encodePng,
  MAX_RASTER_PIXELS,
  type PngRaster,
} from "../src/png-raster.js";
import {
  GLYPH_COLOR,
  GLYPH_HALO_COLOR,
  type GlyphPart,
  type PointerGlyph,
} from "../src/evidence-glyphs.js";
import { PNG_SIGNATURE } from "../src/evidence-png.js";

const raster = (width = 64, height = 64): PngRaster => ({
  width,
  height,
  pixels: Buffer.alloc(width * height * 4, 255),
});
const rgb = (image: PngRaster, x: number, y: number) =>
  "#" +
  image.pixels
    .subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3)
    .toString("hex")
    .toUpperCase();
const glyph = (parts: GlyphPart[], width = 64, height = 64): PointerGlyph => ({
  version: 1,
  kind: "click",
  width,
  height,
  phase: "after",
  state: "completed",
  parts,
  label: "never drawn",
});
function draw(parts: GlyphPart[]): PngRaster {
  const image = raster();
  drawPointerGlyph(image, glyph(parts));
  return image;
}
function chunk(type: string, data: Buffer): Buffer {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length);
  bytes.write(type, 4);
  data.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)) >>> 0, bytes.length - 4);
  return bytes;
}
interface PngOptions {
  color?: number;
  depth?: number;
  interlace?: number;
  transparency?: Buffer;
  palette?: Buffer;
}
function png(raw: Buffer, width: number, height: number, options: PngOptions = {}): Buffer {
  const { color = 2, depth = 8, interlace = 0, transparency } = options;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = depth;
  header[9] = color;
  header[12] = interlace;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", header),
    ...(options.palette ? [chunk("PLTE", options.palette)] : []),
    ...(transparency ? [chunk("tRNS", transparency)] : []),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

it("round trips RGBA bytes and encodes deterministically", () => {
  const image = raster(13, 7);
  for (let i = 0; i < image.pixels.length; i += 1) {
    image.pixels[i] = (i * 71) % 256;
  }
  const bytes = encodePng(image);
  expect(decodePng(bytes)).toEqual(image);
  expect(encodePng(image)).toEqual(bytes);
});
it("decodes RGB and every PNG filter, including transparent RGB", () => {
  // Five identical RGB pixels, each row encoded with one different filter.
  const bytes = png(
    Buffer.from([0, 20, 30, 40, 1, 20, 30, 40, 2, 0, 0, 0, 3, 10, 15, 20, 4, 0, 0, 0]),
    1,
    5,
  );
  const image = decodePng(bytes);
  for (let y = 0; y < 5; y += 1) {
    expect([...image.pixels.subarray(y * 4, y * 4 + 4)]).toEqual([20, 30, 40, 255]);
  }
  const transparent = Buffer.from([0, 20, 0, 30, 0, 40]);
  expect(
    decodePng(png(Buffer.from([0, 20, 30, 40]), 1, 1, { transparency: transparent })).pixels[3],
  ).toBe(0);
});
it("rejects corrupt and excessive inputs", () => {
  expect(() => decodePng(Buffer.from("invalid"))).toThrow("Invalid PNG");
  const invalid = encodePng(raster(1, 1));
  invalid[invalid.length - 1] ^= 1;
  expect(() => decodePng(invalid)).toThrow("Invalid PNG");
  expect(() => decodePng(png(Buffer.from([5, 1, 2, 3]), 1, 1))).toThrow("filter");
  expect(() => assertRasterSize(MAX_RASTER_PIXELS + 1, 1)).toThrow("cap");
  expect(() => assertRasterSize(0, 1)).toThrow();
  expect(() => encodePng({ width: 1, height: 1, pixels: Buffer.alloc(3) })).toThrow("length");
  expect(() => drawPointerGlyph(raster(1, 1), glyph([]))).toThrow("size");
});
it("draws a hollow ring with a halo beneath its stroke", () => {
  const image = draw([{ shape: "ring", at: { x: 20.5, y: 20.5 }, radius: 8.5, dashed: false }]);
  expect(rgb(image, 20, 20)).toBe("#FFFFFF");
  expect(rgb(image, 28, 20)).toBe(GLYPH_COLOR);
  expect(rgb(image, 30, 20)).toBe(GLYPH_HALO_COLOR);
});
it("draws a filled dot with its halo", () => {
  const image = draw([{ shape: "dot", at: { x: 20, y: 20 }, radius: 4 }]);
  expect(rgb(image, 20, 20)).toBe(GLYPH_COLOR);
  expect(rgb(image, 24, 20)).toBe(GLYPH_HALO_COLOR);
});
it("draws straight strokes and dashed gaps", () => {
  const image = draw([
    { shape: "line", from: { x: 2.5, y: 12.5 }, to: { x: 42.5, y: 12.5 }, dashed: true },
  ]);
  expect(rgb(image, 4, 12)).toBe(GLYPH_COLOR);
  expect(rgb(image, 10, 12)).toBe("#FFFFFF");
  expect(rgb(image, 4, 13)).not.toBe("#FFFFFF");
  const line = draw([
    { shape: "line", from: { x: 3.5, y: 5.5 }, to: { x: 3.5, y: 5.5 }, dashed: false },
  ]);
  expect(rgb(line, 3, 5)).toBe(GLYPH_COLOR);
});
it("draws arrow fill and halo for an unnormalised direction", () => {
  const image = draw([
    { shape: "arrow", at: { x: 10, y: 20 }, dx: 3, dy: 0, offset: 20, size: 12 },
  ]);
  expect(rgb(image, 21, 20)).toBe(GLYPH_COLOR);
  expect(rgb(image, 17, 20)).toBe(GLYPH_HALO_COLOR);
  expect(rgb(image, 31, 20)).not.toBe(GLYPH_COLOR);
});
it("draws rectangle outlines, corners and dashed gaps", () => {
  const box: GlyphPart = { shape: "box", x: 10, y: 10, width: 30, height: 25, dashed: false };
  const image = draw([box]);
  expect(rgb(image, 10, 10)).toBe(GLYPH_COLOR);
  expect(rgb(image, 20, 10)).toBe(GLYPH_COLOR);
  expect(rgb(image, 20, 20)).toBe("#FFFFFF");
  expect(rgb(image, 20, 11)).toBe(GLYPH_HALO_COLOR);
  expect(rgb(draw([{ ...box, dashed: true }]), 18, 10)).toBe("#FFFFFF");
});
it("draws caret stem and caps", () => {
  const image = draw([{ shape: "caret", at: { x: 20, y: 20 }, size: 24 }]);
  expect(rgb(image, 20, 20)).toBe(GLYPH_COLOR);
  expect(rgb(image, 17, 8)).toBe(GLYPH_COLOR);
  expect(rgb(image, 17, 20)).toBe("#FFFFFF");
  expect(rgb(image, 21, 20)).toBe(GLYPH_HALO_COLOR);
});
it("clips at edges and anti-aliases fractional anchors deterministically", () => {
  const parts: GlyphPart[] = [
    { shape: "dot", at: { x: 0.25, y: 0.25 }, radius: 0.5 },
    { shape: "ring", at: { x: 20.2, y: 20.7 }, radius: 9.3, dashed: true },
  ];
  const first = draw(parts);
  const second = draw(parts);
  expect(first.pixels).toEqual(second.pixels);
  expect(first.pixels.length).toBe(64 * 64 * 4);
  expect(rgb(first, 0, 0)).not.toBe(GLYPH_COLOR);
  expect(rgb(first, 0, 0)).not.toBe("#FFFFFF");
  expect(rgb(first, 63, 63)).toBe("#FFFFFF");
  const colors = new Set(
    Array.from({ length: 64 * 64 }, (_, i) =>
      first.pixels.subarray(i * 4, i * 4 + 3).toString("hex"),
    ),
  );
  expect(colors.size).toBeGreaterThan(4);
});
it("composites coverage onto transparent pixels", () => {
  const image = raster();
  image.pixels.fill(0);
  drawPointerGlyph(image, glyph([{ shape: "dot", at: { x: 20.5, y: 20.5 }, radius: 3 }]));
  expect([...image.pixels.subarray((20 * 64 + 20) * 4, (20 * 64 + 20) * 4 + 4)]).toEqual([
    255, 122, 26, 255,
  ]);
  expect(image.pixels[3]).toBe(0);
});

it("draws each part's halo before its own colour, in part order", () => {
  const horizontal: GlyphPart = {
    shape: "line",
    from: { x: 5, y: 20 },
    to: { x: 45, y: 20 },
    dashed: false,
  };
  const vertical: GlyphPart = {
    shape: "line",
    from: { x: 20, y: 5 },
    to: { x: 20, y: 45 },
    dashed: false,
  };
  expect(rgb(draw([horizontal, vertical]), 21, 20)).toBe(GLYPH_HALO_COLOR);
  expect(rgb(draw([vertical, horizontal]), 21, 20)).toBe(GLYPH_COLOR);
});
it("uses butt caps for dashed strokes and halos, and round caps for solid strokes", () => {
  const line: GlyphPart = {
    shape: "line",
    from: { x: 10, y: 10 },
    to: { x: 24, y: 10 },
    dashed: true,
  };
  const dashed = draw([line]);
  expect(rgb(dashed, 9, 10)).toBe("#FFFFFF"); // No halo before a butt-capped path.
  expect(rgb(dashed, 24, 10)).toBe("#FFFFFF"); // No halo after its final dash.
  expect(rgb(dashed, 15, 11)).toBe(GLYPH_HALO_COLOR);
  expect(rgb(dashed, 16, 10)).toBe("#FFFFFF");
  expect(rgb(dashed, 16, 11)).toBe("#FFFFFF"); // The halo has the same gap.
  expect(rgb(draw([{ ...line, dashed: false }]), 24, 10)).toBe("#D16517");
});
it("uses square miter joins at solid and uninterrupted dashed box corners", () => {
  const box: GlyphPart = { shape: "box", x: 20, y: 20, width: 14, height: 13, dashed: false };
  const solid = draw([box]);
  expect(rgb(solid, 19, 19)).toBe(GLYPH_COLOR);
  expect(rgb(solid, 18, 18)).toBe(GLYPH_HALO_COLOR);
  const dashed = draw([{ ...box, dashed: true }]);
  expect(rgb(dashed, 34, 19)).toBe(GLYPH_COLOR);
  expect(rgb(dashed, 35, 18)).toBe(GLYPH_HALO_COLOR);
  const shortDash = draw([{ ...box, width: 15, dashed: true }]);
  expect(rgb(shortDash, 36, 18)).toBe(GLYPH_HALO_COLOR); // The outer miter still joins.
  expect(rgb(shortDash, 36, 21)).toBe("#FFFFFF"); // The join does not extend the next dash's butt cap.
});
it("draws half-height caret serifs with round caps", () => {
  const image = draw([{ shape: "caret", at: { x: 20, y: 20 }, size: 24 }]);
  expect(rgb(image, 14, 8)).toBe(GLYPH_COLOR); // The serif begins at 20 - 24/4.
  expect(rgb(image, 25, 8)).toBe(GLYPH_COLOR);
  expect(rgb(image, 26, 8)).toBe("#D16517"); // Rounded right serif cap.
  expect(rgb(image, 28, 8)).toBe("#FFFFFF");
});
it("starts ring dashes at the rightmost point, clockwise on screen", () => {
  const image = draw([{ shape: "ring", at: { x: 30, y: 30 }, radius: 14.2, dashed: true }]);
  expect(rgb(image, 44, 31)).toBe(GLYPH_COLOR); // First dash, just below the origin.
  expect(rgb(image, 44, 28)).toBe("#FFFFFF"); // Last arc is a gap, just above the origin.
  expect(rgb(image, 42, 38)).toBe("#FFFFFF"); // Clockwise arc length is in the first gap.
});
it("starts box dashes at top-left and carries their phase clockwise through corners", () => {
  const image = draw([{ shape: "box", x: 10, y: 10, width: 13, height: 20, dashed: true }]);
  expect(rgb(image, 10, 10)).toBe(GLYPH_COLOR);
  expect(rgb(image, 16, 10)).toBe("#FFFFFF");
  expect(rgb(image, 23, 11)).toBe(GLYPH_COLOR); // Perimeter position 14 is a dash.
  expect(rgb(image, 23, 13)).toBe("#FFFFFF"); // Position 16 is a gap, not a restarted dash.
  expect(rgb(image, 10, 29)).toBe(GLYPH_COLOR); // The bottom-left corner carries position 46.
});
it("limits fill halos to half the halo-stroke width, with round polygon joins", () => {
  const dot = draw([{ shape: "dot", at: { x: 20, y: 20 }, radius: 4 }]);
  expect(rgb(dot, 24, 20)).toBe(GLYPH_HALO_COLOR);
  expect(rgb(dot, 25, 20)).toBe("#FFFFFF");
  const arrow = draw([
    { shape: "arrow", at: { x: 10, y: 20 }, dx: 1, dy: 0, offset: 20, size: 12 },
  ]);
  expect(rgb(arrow, 17, 20)).toBe(GLYPH_HALO_COLOR);
  expect(rgb(arrow, 16, 20)).toBe("#FFFFFF");
  expect(rgb(arrow, 30, 20)).not.toBe("#FFFFFF"); // Round halo at the triangle tip.
  expect(rgb(arrow, 31, 20)).toBe("#FFFFFF");
});

function sampleRow(values: number[], depth: number): Buffer {
  const row = Buffer.alloc(Math.ceil((values.length * depth) / 8));
  values.forEach((value, i) => {
    if (depth === 16) {
      row.writeUInt16BE(value, i * 2);
    } else if (depth === 8) {
      row[i] = value;
    } else {
      row[Math.floor((i * depth) / 8)]! |= value << (8 - depth - ((i * depth) % 8));
    }
  });
  return Buffer.concat([Buffer.from([0]), row]);
}

it.each([1, 2, 4, 8, 16])("decodes grayscale depth %i and transparent samples", (depth) => {
  const max = 2 ** depth - 1;
  const transparent = Buffer.alloc(2);
  transparent.writeUInt16BE(max);
  const bytes = png(sampleRow([0, max, 0], depth), 3, 1, {
    color: 0,
    depth,
    transparency: transparent,
  });
  expect([...decodePng(bytes).pixels]).toEqual([0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 0, 255]);
});

it.each([1, 2, 4, 8])("decodes indexed depth %i with palette transparency", (depth) => {
  const bytes = png(sampleRow([0, 1, 0], depth), 3, 1, {
    color: 3,
    depth,
    palette: Buffer.from([10, 20, 30, 80, 90, 100]),
    transparency: Buffer.from([128, 0]),
  });
  expect([...decodePng(bytes).pixels]).toEqual([10, 20, 30, 128, 80, 90, 100, 0, 10, 20, 30, 128]);
  const opaque = png(sampleRow([1], depth), 1, 1, {
    color: 3,
    depth,
    palette: Buffer.from([10, 20, 30, 80, 90, 100]),
  });
  expect([...decodePng(opaque).pixels]).toEqual([80, 90, 100, 255]);
});

it.each([
  [4, 8],
  [4, 16],
  [2, 16],
  [6, 16],
])("decodes colour %i at depth %i", (color, depth) => {
  const max = 2 ** depth - 1;
  const values = color === 4 ? [max, 0] : color === 2 ? [max, 0, max] : [max, 0, max, 0];
  const bytes = png(sampleRow(values, depth), 1, 1, { color, depth });
  const expected = color === 4 ? [255, 255, 255, 0] : [255, 0, 255, color === 2 ? 255 : 0];
  expect([...decodePng(bytes).pixels]).toEqual(expected);
});

function adam7Rows(width: number, height: number, depth: number): Buffer {
  const steps = [
    [0, 0, 8, 8],
    [4, 0, 8, 8],
    [0, 4, 4, 8],
    [2, 0, 4, 4],
    [0, 2, 2, 4],
    [1, 0, 2, 2],
    [0, 1, 1, 2],
  ];
  const rows: Buffer[] = [];
  for (const [startX, startY, dx, dy] of steps) {
    for (let y = startY!; y < height; y += dy!) {
      const values: number[] = [];
      for (let x = startX!; x < width; x += dx!) {
        values.push((x + y) % 2 === 0 ? 0 : 2 ** depth - 1);
      }
      if (values.length > 0) {
        rows.push(sampleRow(values, depth));
      }
    }
  }
  return Buffer.concat(rows);
}

it.each([1, 2, 4, 8, 16])(
  "scatters all Adam7 passes at depth %i, including empty passes",
  (depth) => {
    for (const [width, height] of [
      [9, 9],
      [1, 1],
      [2, 3],
    ]) {
      const bytes = png(adam7Rows(width!, height!, depth), width!, height!, {
        depth,
        color: 0,
        interlace: 1,
      });
      const decoded = decodePng(bytes);
      for (let y = 0; y < height!; y += 1) {
        for (let x = 0; x < width!; x += 1) {
          expect(rgb(decoded, x, y)).toBe((x + y) % 2 === 0 ? "#000000" : "#FFFFFF");
        }
      }
    }
  },
);

it("rejects missing palettes, invalid indices and truncated scanlines", () => {
  expect(() => decodePng(png(Buffer.from([0, 0]), 1, 1, { color: 3 }))).toThrow("palette");
  expect(() =>
    decodePng(
      png(Buffer.from([0, 1]), 1, 1, {
        color: 3,
        palette: Buffer.from([0, 0, 0]),
      }),
    ),
  ).toThrow("index");
  expect(() => decodePng(png(Buffer.from([0]), 1, 1))).toThrow();
});

it("decodes real ImageMagick convert grayscale1 and RGB16 images", () => {
  // convert -size 2x2 xc:black -depth 1 -strip png:-.
  const grayscale = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQAAAABazTCJAAAADElEQVQI12NgYGAAAAAEAAEn" +
      "NCcKAAAAAElFTkSuQmCC",
    "base64",
  );
  expect(grayscale[24]).toBe(1);
  expect(decodePng(grayscale).pixels).toEqual(
    Buffer.from([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]),
  );
  // convert -size 2x1 xc:red -depth 16 PNG48:-.
  const converted = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABEAIAAAAr0DSeAAAAIGNIUk0AAHomAACAhAAA+gAAAIDo" +
      "AAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRP///////wlY99wAAAAldEVYdGRhdGU6Y3Jl" +
      "YXRlADIwMjYtMTAtMDNUMTk6MDg6MzQrMDA6MDBBTztcAAAAJXRFWHRkYXRlOm1vZGlmeQAy" +
      "MDI2LTEwLTAzVDE5OjA4OjM0KzAwOjAwMBKD4AAAACh0RVh0ZGF0ZTp0aW1lc3RhbXAAMjAy" +
      "Ni0xMC0wM1QxOTowODozNCswMDowMGcHoj8AAAANSURBVAjXY/z/nwEOABcDAgAtuq71AAAA" +
      "AElFTkSuQmCC",
    "base64",
  );
  expect(converted[24]).toBe(16);
  expect([...decodePng(converted).pixels]).toEqual([255, 0, 0, 255, 255, 0, 0, 255]);
});

function colorAdam7Rows(options: PngOptions): Buffer {
  const steps = [
    [0, 0, 8, 8],
    [4, 0, 8, 8],
    [0, 4, 4, 8],
    [2, 0, 4, 4],
    [0, 2, 2, 4],
    [1, 0, 2, 2],
    [0, 1, 1, 2],
  ];
  const depth = options.depth!;
  const maximum = 2 ** depth - 1;
  const values =
    options.color === 3
      ? [1]
      : options.color === 4
        ? [maximum, 0]
        : options.color === 6
          ? [maximum, 0, maximum, 0]
          : [maximum, 0, maximum];
  const rows: Buffer[] = [];
  for (const [x, y, dx, dy] of steps) {
    const count = Math.max(0, Math.ceil((9 - x!) / dx!));
    for (let row = y!; row < 9; row += dy!) {
      if (count > 0) {
        rows.push(sampleRow(Array.from({ length: count }, () => values).flat(), depth));
      }
    }
  }
  return Buffer.concat(rows);
}

it.each([
  [2, 8],
  [2, 16],
  [4, 8],
  [4, 16],
  [6, 8],
  [6, 16],
  [3, 1],
  [3, 2],
  [3, 4],
  [3, 8],
])("decodes Adam7 colour %i depth %i with multiple samples and palette alpha", (color, depth) => {
  const options = {
    color,
    depth,
    interlace: 1,
    palette: Buffer.from([0, 0, 0, 255, 0, 255]),
    transparency: Buffer.from([255, 0]),
  };
  const decoded = decodePng(png(colorAdam7Rows(options), 9, 9, options));
  const expected = color === 4 ? [255, 255, 255, 0] : [255, 0, 255, color === 2 ? 255 : 0];
  for (let index = 0; index < decoded.pixels.length; index += 4) {
    expect([...decoded.pixels.subarray(index, index + 4)]).toEqual(expected);
  }
  expect(decodePng(encodePng(decoded))).toEqual(decoded);
});

it("uses byte filter spacing for packed grayscale and RGB16 samples", () => {
  const packed = decodePng(png(Buffer.from([1, 0xaa, 0xab]), 16, 1, { color: 0, depth: 1 }));
  expect(Array.from(packed.pixels.filter((_, i) => i % 4 === 0))).toEqual([
    255, 0, 255, 0, 255, 0, 255, 0, 0, 255, 0, 255, 0, 255, 0, 255,
  ]);
  const raw = Buffer.from([1, 255, 255, 0, 0, 255, 255, 0, 0, 0, 0, 0, 0]);
  expect([...decodePng(png(raw, 2, 1, { depth: 16 })).pixels]).toEqual([
    255, 0, 255, 255, 255, 0, 255, 255,
  ]);
});

it("rounds 16-bit samples and compares transparency before downsampling", () => {
  const transparency = Buffer.alloc(2);
  transparency.writeUInt16BE(257);
  const bytes = png(sampleRow([257, 258, 32768], 16), 3, 1, {
    color: 0,
    depth: 16,
    transparency,
  });
  expect([...decodePng(bytes).pixels]).toEqual([1, 1, 1, 0, 1, 1, 1, 255, 128, 128, 128, 255]);
});

it("copies RGBA8 rows directly after every filter without losing alpha", () => {
  const rows = Buffer.from([
    0, 20, 30, 40, 50, 1, 20, 30, 40, 50, 2, 0, 0, 0, 0, 3, 10, 15, 20, 25, 4, 0, 0, 0, 0,
  ]);
  const decoded = decodePng(png(rows, 1, 5, { color: 6 }));
  expect([...decoded.pixels]).toEqual(Array.from({ length: 5 }, () => [20, 30, 40, 50]).flat());
});
