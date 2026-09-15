import crypto from "node:crypto";
import fs from "node:fs";
import zlib from "node:zlib";
import { ObservationTimeoutError, observationBudget, runCommand, type EnvLike } from "@pickforge/lab-core";
import { findOnPath } from "./util.js";

export const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const MAX_DIM = 16_384;
const MAX_RGB_BYTES = 64 * 1024 * 1024;
const DEFAULT_DIGEST_TIMEOUT_MS = 20_000;

export interface PngImageSize {
  width: number;
  height: number;
}

export interface PixelDigestOptions {
  env?: EnvLike;
  timeoutMs?: number;
}

function pngError(path: string, detail: string): Error {
  return new Error(`Invalid PNG at ${path}: ${detail}`);
}

function crcOf(type: Buffer, data: Buffer): number {
  return zlib.crc32(data, zlib.crc32(type)) >>> 0;
}

/** IHDR width/height only. Bit depth and interlace are left to the raster tool. */
export async function readPngImageSize(filePath: string): Promise<PngImageSize> {
  const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw pngError(filePath, "not a regular file");
    if (stat.size < PNG_MAGIC.length + 25) throw pngError(filePath, "file too small to contain IHDR");
    const header = Buffer.alloc(PNG_MAGIC.length + 25);
    await handle.read(header, 0, header.length, 0);
    if (!header.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
      throw pngError(filePath, "missing PNG signature");
    }
    const length = header.readUInt32BE(PNG_MAGIC.length);
    const typeBuf = header.subarray(PNG_MAGIC.length + 4, PNG_MAGIC.length + 8);
    if (length !== 13 || typeBuf.toString("binary") !== "IHDR") {
      throw pngError(filePath, "IHDR must be first");
    }
    const data = header.subarray(PNG_MAGIC.length + 8, PNG_MAGIC.length + 21);
    const crc = header.readUInt32BE(PNG_MAGIC.length + 21);
    if (crc !== crcOf(typeBuf, data)) throw pngError(filePath, "bad IHDR checksum");
    const width = data.readUInt32BE(0);
    const height = data.readUInt32BE(4);
    if (width < 1 || height < 1 || width > MAX_DIM || height > MAX_DIM) {
      throw pngError(filePath, "unsupported PNG dimensions");
    }
    return { width, height };
  } finally {
    await handle.close();
  }
}

function rasterTool(env: EnvLike): { cmd: string; args: (file: string) => string[] } | null {
  const pngFile = (file: string): string => `png:${file}`;
  if (findOnPath("convert", env) !== null) {
    return {
      cmd: "convert",
      args: (file) => ["-quiet", pngFile(file), "-alpha", "off", "-depth", "8", "rgb:-"],
    };
  }
  if (findOnPath("magick", env) !== null) {
    return {
      cmd: "magick",
      args: (file) => ["-quiet", pngFile(file), "-alpha", "off", "-depth", "8", "rgb:-"],
    };
  }
  return null;
}

/**
 * Pixel identity for wait comparisons: 8-bit RGB plus dimensions, ignoring
 * PNG timestamps and ancillary encoding. Requires ImageMagick `convert` or
 * `magick` (the same raster tools the xwd screenshot path already needs).
 */
export async function pngPixelDigest(
  filePath: string,
  opts: PixelDigestOptions = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DIGEST_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  observationBudget(deadline);
  const env = opts.env ?? process.env;
  const tool = rasterTool(env);
  if (tool === null) {
    throw new Error(
      "Pixel wait requires ImageMagick `convert` or `magick` on PATH",
    );
  }
  const size = await readPngImageSize(filePath);
  const expected = size.width * size.height * 3;
  if (expected > MAX_RGB_BYTES) throw pngError(filePath, "raster too large");
  const result = await runCommand(tool.cmd, tool.args(filePath), {
    env,
    timeoutMs: observationBudget(deadline),
    maxOutputBytes: expected,
    binary: true,
  });
  if (result.timedOut) {
    throw new ObservationTimeoutError(`timed out comparing ${filePath}`);
  }
  if (!result.ok || result.stdoutBuffer === undefined) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`ImageMagick failed to rasterize ${filePath}: ${detail}`);
  }
  if (result.stdoutBuffer.length !== expected) {
    throw pngError(
      filePath,
      `raster size ${result.stdoutBuffer.length} did not match ${size.width}x${size.height}`,
    );
  }
  return crypto
    .createHash("sha256")
    .update(`${size.width}x${size.height}\0`)
    .update(result.stdoutBuffer)
    .digest("hex");
}
