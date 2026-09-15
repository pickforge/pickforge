import zlib from "node:zlib";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crcOf(type: Buffer, data: Buffer): number {
  return zlib.crc32(data, zlib.crc32(type)) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crcOf(typeBuf, data));
  return Buffer.concat([length, typeBuf, data, crc]);
}

/** Test-only 8-bit RGB PNG writer, including optional ancillary chunks. */
export function encodePng(
  width: number,
  height: number,
  rgb: Buffer,
  extraChunks: ReadonlyArray<{ type: string; data: Buffer }> = [],
): Buffer {
  if (rgb.length !== width * height * 3) throw new Error("RGB buffer does not match dimensions");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const parts = [PNG_MAGIC, chunk("IHDR", ihdr)];
  for (const extra of extraChunks) parts.push(chunk(extra.type, extra.data));
  parts.push(chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}
