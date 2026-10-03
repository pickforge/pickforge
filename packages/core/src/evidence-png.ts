import path from "node:path";
import zlib, { crc32 } from "node:zlib";
import { readBoundedFileIn } from "./bounded-read.js";
import type { DirHandle } from "./dir-handle.js";
import { isSafeScreenshotPath as safeScreenshotPath } from "./evidence-sanitize.js";

/** Bounded PNG validation and safe screenshot reads shared by reports and exports. */

export const MAX_SHARE_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_SHARE_INFLATED_IMAGE_BYTES = 1024 * 1024 * 1024;

export interface PngSize {
  width: number;
  height: number;
}

export function formatShareBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

interface PngChunk {
  type: string;
  data: Buffer;
  end: number;
}

function readPngChunk(bytes: Buffer, offset: number): PngChunk | undefined {
  if (offset + 12 > bytes.length) return undefined;
  const length = bytes.readUInt32BE(offset);
  const end = offset + 12 + length;
  if (end > bytes.length) return undefined;
  const type = bytes.toString("latin1", offset + 4, offset + 8);
  if (!/^[A-Za-z]{4}$/.test(type)) return undefined;
  const checksum = crc32(bytes.subarray(offset + 4, end - 4)) >>> 0;
  if (checksum !== bytes.readUInt32BE(end - 4)) return undefined;
  return { type, data: bytes.subarray(offset + 8, end - 4), end };
}

const PNG_COLOR_FORMATS: Readonly<Record<number, { depths: readonly number[]; samples: number }>> = {
  0: { depths: [1, 2, 4, 8, 16], samples: 1 },
  2: { depths: [8, 16], samples: 3 },
  3: { depths: [1, 2, 4, 8], samples: 1 },
  4: { depths: [8, 16], samples: 2 },
  6: { depths: [8, 16], samples: 4 },
};

// Each pass gives the first pixel (x, y) and the spacing (dx, dy).
const ADAM7_PASSES = [
  [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
  [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
] as const;

interface PngLayout {
  width: number;
  height: number;
  bitsPerPixel: number;
  interlaced: boolean;
}

function readPngLayout(data: Buffer): PngLayout | undefined {
  if (data.length !== 13) return undefined;
  const width = data.readUInt32BE(0);
  const height = data.readUInt32BE(4);
  if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) return undefined;
  const format = PNG_COLOR_FORMATS[data[9]];
  if (format === undefined || !format.depths.includes(data[8])) return undefined;
  if (data[10] !== 0 || data[11] !== 0 || data[12] > 1) return undefined;
  return { width, height, bitsPerPixel: data[8] * format.samples, interlaced: data[12] === 1 };
}

function pngRawSize(layout: PngLayout): number | undefined {
  const { width, height, bitsPerPixel } = layout;
  const passes = layout.interlaced ? ADAM7_PASSES : [[0, 0, 1, 1]] as const;
  let size = 0;
  for (const [x, y, dx, dy] of passes) {
    const columns = Math.max(0, Math.ceil((width - x) / dx));
    const rows = Math.max(0, Math.ceil((height - y) / dy));
    if (columns === 0 || rows === 0) continue;
    size += rows * (1 + Math.ceil(columns * bitsPerPixel / 8));
    if (size > MAX_SHARE_INFLATED_IMAGE_BYTES) return undefined;
  }
  return size;
}

function validPngStream(parts: readonly Buffer[], expectedSize: number): boolean {
  if (parts.length === 0) return false;
  const compressed = Buffer.concat(parts);
  try {
    // Node's info option returns this shape, but its typings only declare Buffer.
    const result = zlib.inflateSync(compressed, {
      info: true, maxOutputLength: expectedSize + 1,
    }) as unknown as { buffer: Buffer; engine: zlib.Inflate };
    return result.buffer.length === expectedSize && result.engine.bytesWritten === compressed.length;
  } catch {
    return false;
  }
}

/** Validate framing, checksums and bounded image data without changing evidence bytes. */
function completePng(bytes: Buffer, layout: PngLayout, start: number): boolean {
  const expectedSize = pngRawSize(layout);
  if (expectedSize === undefined) return false;
  let offset = start;
  const imageData: Buffer[] = [];
  while (offset < bytes.length) {
    const chunk = readPngChunk(bytes, offset);
    if (chunk === undefined || chunk.type === "IHDR") return false;
    if (chunk.type === "IEND") {
      return chunk.data.length === 0 && chunk.end === bytes.length && validPngStream(imageData, expectedSize);
    }
    if (chunk.type === "IDAT") imageData.push(chunk.data);
    offset = chunk.end;
  }
  return false;
}

function readPngHeader(bytes: Buffer): { layout: PngLayout; end: number } | undefined {
  const header = readPngChunk(bytes, 8);
  const layout = header?.type === "IHDR" ? readPngLayout(header.data) : undefined;
  return layout === undefined ? undefined : { layout, end: header!.end };
}

/** Size from IHDR alone; only for bytes that already passed full validation. */
export function headerSize(bytes: Buffer): PngSize {
  const { width, height } = readPngHeader(bytes)!.layout;
  return { width, height };
}

/** The actual size of a PNG that passes full validation after its signature; otherwise unknown. */
export function completePngSize(bytes: Buffer): PngSize | undefined {
  const header = readPngHeader(bytes);
  if (header === undefined || !completePng(bytes, header.layout, header.end)) return undefined;
  return { width: header.layout.width, height: header.layout.height };
}

function shareScreenshotPathReason(relative: string): string | undefined {
  const unsafe = "Unsafe or unsupported screenshot path; only screenshots/*.png are included";
  if (path.isAbsolute(relative) || relative.includes("\\") || relative.includes("\0")) return unsafe;
  if (relative.split("/").some((part) => part === "" || part === "." || part === "..")) return unsafe;
  if (!relative.startsWith("screenshots/")) return "Not a screenshot; only screenshots/*.png are embedded";
  return safeScreenshotPath(relative) ? undefined : unsafe;
}

/** Classify one candidate before reading through the held screenshot directory. */
export async function readShareScreenshot(
  screenshots: DirHandle | undefined, relative: string,
): Promise<Buffer | string> {
  const pathReason = shareScreenshotPathReason(relative);
  if (pathReason !== undefined) return pathReason;
  if (screenshots === undefined) {
    return "Screenshot directory missing or unsafe";
  }
  const name = relative.slice("screenshots/".length);
  const stat = await screenshots.lstatChild(name);
  if (stat === undefined) {
    return "Missing file";
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    return "Unsafe file; requires a regular file without symlinks or hardlinks";
  }
  if (stat.size > MAX_SHARE_IMAGE_BYTES) {
    return `Over per-image cap (${formatShareBytes(MAX_SHARE_IMAGE_BYTES)})`;
  }
  return readBoundedFileIn(screenshots, name, Date.now() + 30_000, {
    maxBytes: MAX_SHARE_IMAGE_BYTES, singleLink: true,
  });
}

export async function openScreenshotsDir(
  runDir: DirHandle,
): Promise<DirHandle | undefined> {
  const stat = await runDir.lstatChild("screenshots");
  if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()) {
    return undefined;
  }
  return runDir.openChild("screenshots");
}
