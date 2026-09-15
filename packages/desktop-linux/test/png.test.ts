import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { runCommand } from "@pickforge/lab-core";
import { pngPixelDigest, readPngImageSize } from "../src/png.js";
import { screenshotMetadata } from "../src/screenshot.js";
import { findOnPath } from "../src/util.js";
import { encodePng } from "./png-fixture.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-png-"));
const hasRaster = findOnPath("convert") !== null || findOnPath("magick") !== null;
afterEach(() => {
  for (const name of fs.readdirSync(tmp)) {
    fs.rmSync(path.join(tmp, name), { force: true });
  }
});

function rgbFill(width: number, height: number, r: number, g: number, b: number): Buffer {
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
  }
  return rgb;
}

it("derives scale 1 only when display and image sizes match", () => {
  expect(screenshotMetadata({ width: 8, height: 8 })).toEqual({
    imageSize: { width: 8, height: 8 },
    displaySize: { width: 8, height: 8 },
    scale: 1,
    inputCoordinates: "image-pixels",
  });
  expect(() => screenshotMetadata({ width: 8, height: 8 }, { width: 1280, height: 800 })).toThrow(/dimensions do not match/);
});

it("reads IHDR dimensions from a valid PNG and rejects a signature-only file", async () => {
  const file = path.join(tmp, "ok.png");
  fs.writeFileSync(file, encodePng(2, 3, rgbFill(2, 3, 10, 20, 30)));
  expect(await readPngImageSize(file)).toEqual({ width: 2, height: 3 });
  const stub = path.join(tmp, "stub.png");
  fs.writeFileSync(stub, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  await expect(readPngImageSize(stub)).rejects.toThrow(/too small|IHDR|signature/);
});

it.skipIf(!hasRaster)("hashes pixels with dimensions and ignores ancillary PNG metadata", async () => {
  const pixels = rgbFill(2, 1, 1, 2, 3);
  const plain = path.join(tmp, "plain.png");
  const annotated = path.join(tmp, "annotated.png");
  fs.writeFileSync(plain, encodePng(2, 1, pixels));
  fs.writeFileSync(
    annotated,
    encodePng(2, 1, pixels, [{ type: "tEXt", data: Buffer.from("Comment\0changed-at") }]),
  );
  expect(fs.readFileSync(plain).equals(fs.readFileSync(annotated))).toBe(false);
  expect(await pngPixelDigest(plain)).toBe(await pngPixelDigest(annotated));
  const other = path.join(tmp, "other.png");
  fs.writeFileSync(other, encodePng(2, 1, rgbFill(2, 1, 9, 9, 9)));
  expect(await pngPixelDigest(other)).not.toBe(await pngPixelDigest(plain));
});

it.skipIf(!hasRaster)("rasterizes 16-bit capture-like PNGs through ImageMagick", async () => {
  const file = path.join(tmp, "deep.png");
  const tool = findOnPath("convert") !== null ? "convert" : "magick";
  const written = await runCommand(
    tool,
    ["-size", "2x1", "xc:red", "-depth", "16", `png:${file}`],
    { timeoutMs: 5_000 },
  );
  expect(written.ok).toBe(true);
  expect(await readPngImageSize(file)).toEqual({ width: 2, height: 1 });
  expect(await pngPixelDigest(file)).toMatch(/^[0-9a-f]{64}$/);
});
