import { crc32, deflateSync } from "node:zlib";
import { expect, it } from "vitest";
import { assertRasterSize, decodePng, drawPointerGlyph, encodePng, MAX_RASTER_PIXELS, type PngRaster } from "../src/png-raster.js";
import { GLYPH_COLOR, GLYPH_HALO_COLOR, type GlyphPart, type PointerGlyph } from "../src/evidence-glyphs.js";
import { PNG_SIGNATURE } from "../src/evidence-png.js";

const raster = (width = 64, height = 64): PngRaster => ({ width, height, pixels: Buffer.alloc(width * height * 4, 255) });
const rgb = (image: PngRaster, x: number, y: number) => "#" + image.pixels.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3).toString("hex").toUpperCase();
const glyph = (parts: GlyphPart[], width = 64, height = 64): PointerGlyph => ({ version: 1, kind: "click", width, height, phase: "after", state: "completed", parts, label: "never drawn" });
function draw(parts: GlyphPart[]): PngRaster { const image = raster(); drawPointerGlyph(image, glyph(parts)); return image; }
function chunk(type: string, data: Buffer): Buffer {
  const bytes = Buffer.alloc(data.length + 12); bytes.writeUInt32BE(data.length); bytes.write(type, 4); data.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)) >>> 0, bytes.length - 4); return bytes;
}
function png(raw: Buffer, width: number, height: number, color = 2, depth = 8, interlace = 0, transparency?: Buffer): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = depth; header[9] = color; header[12] = interlace;
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", header), ...(transparency ? [chunk("tRNS", transparency)] : []), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

it("round trips RGBA bytes and encodes deterministically", () => {
  const image = raster(13, 7);
  for (let i = 0; i < image.pixels.length; i += 1) image.pixels[i] = (i * 71) % 256;
  const bytes = encodePng(image); expect(decodePng(bytes)).toEqual(image); expect(encodePng(image)).toEqual(bytes);
});
it("decodes RGB and every PNG filter, including transparent RGB", () => {
  // Five identical RGB pixels, each row encoded with one different filter.
  const bytes = png(Buffer.from([0, 20, 30, 40, 1, 20, 30, 40, 2, 0, 0, 0, 3, 10, 15, 20, 4, 0, 0, 0]), 1, 5);
  const image = decodePng(bytes);
  for (let y = 0; y < 5; y += 1) expect([...image.pixels.subarray(y * 4, y * 4 + 4)]).toEqual([20, 30, 40, 255]);
  const transparent = Buffer.from([0, 20, 0, 30, 0, 40]);
  expect(decodePng(png(Buffer.from([0, 20, 30, 40]), 1, 1, 2, 8, 0, transparent)).pixels[3]).toBe(0);
});
it("rejects corrupt, unsupported and excessive inputs", () => {
  expect(() => decodePng(Buffer.from("invalid"))).toThrow("Invalid PNG");
  const invalid = encodePng(raster(1, 1)); invalid[invalid.length - 1] ^= 1;
  expect(() => decodePng(invalid)).toThrow("Invalid PNG");
  expect(() => decodePng(png(Buffer.from([0, 1]), 1, 1, 0))).toThrow("Unsupported PNG raster layout");
  expect(() => decodePng(png(Buffer.from([5, 1, 2, 3]), 1, 1))).toThrow("filter");
  expect(() => assertRasterSize(MAX_RASTER_PIXELS + 1, 1)).toThrow("cap");
  expect(() => assertRasterSize(0, 1)).toThrow();
  expect(() => encodePng({ width: 1, height: 1, pixels: Buffer.alloc(3) })).toThrow("length");
  expect(() => drawPointerGlyph(raster(1, 1), glyph([]))).toThrow("size");
});
it("draws a hollow ring with a halo beneath its stroke", () => {
  const image = draw([{ shape: "ring", at: { x: 20.5, y: 20.5 }, radius: 8.5, dashed: false }]);
  expect(rgb(image, 20, 20)).toBe("#FFFFFF"); expect(rgb(image, 28, 20)).toBe(GLYPH_COLOR);
  expect(rgb(image, 30, 20)).toBe(GLYPH_HALO_COLOR);
});
it("draws a filled dot with its halo", () => {
  const image = draw([{ shape: "dot", at: { x: 20.5, y: 20.5 }, radius: 4 }]);
  expect(rgb(image, 20, 20)).toBe(GLYPH_COLOR); expect(rgb(image, 25, 20)).toBe(GLYPH_HALO_COLOR);
});
it("draws straight strokes and dashed gaps", () => {
  const image = draw([{ shape: "line", from: { x: 2.5, y: 12.5 }, to: { x: 42.5, y: 12.5 }, dashed: true }]);
  expect(rgb(image, 4, 12)).toBe(GLYPH_COLOR); expect(rgb(image, 10, 12)).toBe("#FFFFFF");
  expect(rgb(image, 4, 13)).not.toBe("#FFFFFF");
  const line = draw([{ shape: "line", from: { x: 3.5, y: 5.5 }, to: { x: 3.5, y: 5.5 }, dashed: false }]);
  expect(rgb(line, 3, 5)).toBe(GLYPH_COLOR);
});
it("draws arrow fill and halo for an unnormalised direction", () => {
  const image = draw([{ shape: "arrow", at: { x: 10.5, y: 20.5 }, dx: 3, dy: 0, offset: 20, size: 12 }]);
  expect(rgb(image, 21, 20)).toBe(GLYPH_COLOR); expect(rgb(image, 17, 20)).toBe(GLYPH_HALO_COLOR);
  expect(rgb(image, 31, 20)).not.toBe(GLYPH_COLOR);
});
it("draws rectangle outlines, corners and dashed gaps", () => {
  const box: GlyphPart = { shape: "box", x: 10, y: 10, width: 30, height: 25, dashed: false };
  const image = draw([box]);
  expect(rgb(image, 10, 10)).toBe(GLYPH_COLOR); expect(rgb(image, 20, 10)).toBe(GLYPH_COLOR);
  expect(rgb(image, 20, 20)).toBe("#FFFFFF"); expect(rgb(image, 20, 11)).toBe(GLYPH_HALO_COLOR);
  expect(rgb(draw([{ ...box, dashed: true }]), 18, 10)).toBe("#FFFFFF");
});
it("draws caret stem and caps", () => {
  const image = draw([{ shape: "caret", at: { x: 20, y: 20 }, size: 24 }]);
  expect(rgb(image, 20, 20)).toBe(GLYPH_COLOR); expect(rgb(image, 17, 8)).toBe(GLYPH_COLOR);
  expect(rgb(image, 17, 20)).toBe("#FFFFFF"); expect(rgb(image, 21, 20)).toBe(GLYPH_HALO_COLOR);
});
it("clips at edges and anti-aliases fractional anchors deterministically", () => {
  const parts: GlyphPart[] = [{ shape: "dot", at: { x: 0.25, y: 0.25 }, radius: 0.5 },
    { shape: "ring", at: { x: 20.2, y: 20.7 }, radius: 9.3, dashed: true }];
  const first = draw(parts), second = draw(parts);
  expect(first.pixels).toEqual(second.pixels); expect(first.pixels.length).toBe(64 * 64 * 4);
  expect(rgb(first, 0, 0)).not.toBe(GLYPH_COLOR); expect(rgb(first, 0, 0)).not.toBe("#FFFFFF");
  expect(rgb(first, 63, 63)).toBe("#FFFFFF");
  const colors = new Set(Array.from({ length: 64 * 64 }, (_, i) => first.pixels.subarray(i * 4, i * 4 + 3).toString("hex")));
  expect(colors.size).toBeGreaterThan(4);
});
it("composites coverage onto transparent pixels", () => {
  const image = raster(); image.pixels.fill(0);
  drawPointerGlyph(image, glyph([{ shape: "dot", at: { x: 20.5, y: 20.5 }, radius: 3 }]));
  expect([...image.pixels.subarray((20 * 64 + 20) * 4, (20 * 64 + 20) * 4 + 4)]).toEqual([255, 122, 26, 255]);
  expect(image.pixels[3]).toBe(0);
});
