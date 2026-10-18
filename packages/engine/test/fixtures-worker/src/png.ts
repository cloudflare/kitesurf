// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// PNG encoding constants (RFC 2083).
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHUNK_LENGTH_BYTES = 4;
const CHUNK_TYPE_BYTES = 4;
const CHUNK_CRC_BYTES = 4;
const IHDR_BYTES = 13;
const BIT_DEPTH = 8;
const COLOR_TYPE_RGBA = 6;
const FILTER_NONE = 0;
const BYTES_PER_PIXEL = 4;
const MAX_CHANNEL = 255;

const CRC32_POLYNOMIAL = 0xedb88320;
const CRC_TABLE = Array.from({ length: 256 }, (_, byte) => {
  let crc = byte;
  for (let bit = 0; bit < 8; bit++) {
    crc = crc & 1 ? CRC32_POLYNOMIAL ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeStart = CHUNK_LENGTH_BYTES;
  const dataStart = typeStart + CHUNK_TYPE_BYTES;
  const out = new Uint8Array(dataStart + data.length + CHUNK_CRC_BYTES);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < CHUNK_TYPE_BYTES; i++) out[typeStart + i] = type.charCodeAt(i);
  out.set(data, dataStart);
  view.setUint32(dataStart + data.length, crc32(out.subarray(typeStart, dataStart + data.length)));
  return out;
}

const KNUTH_HASH = 2654435761;
const DISC_COUNT = 8;
const MIN_DISC_RADIUS = 40;

export async function bigPngBytes(
  side: number,
  seed: number,
  noise: boolean,
): Promise<Uint8Array<ArrayBuffer>> {
  const stride = 1 + side * BYTES_PER_PIXEL;
  const raw = new Uint8Array(side * stride);
  const discs = Array.from({ length: DISC_COUNT }, (_, index) => ({
    x: ((seed * 97 + index * 131071) >>> 0) % side,
    y: ((seed * 61 + index * 524287) >>> 0) % side,
    radius: MIN_DISC_RADIUS + ((((seed + index) * 8191) >>> 0) % (side / 4)),
    shade: ((seed * 37 + index * 77) >>> 0) & MAX_CHANNEL,
  }));
  for (let y = 0; y < side; y++) {
    const row = y * stride;
    raw[row] = FILTER_NONE;
    for (let x = 0; x < side; x++) {
      const pixel = row + 1 + x * BYTES_PER_PIXEL;
      if (noise) {
        const hash = (x * KNUTH_HASH + y * 40503 + seed * 97) >>> 0;
        raw[pixel] = (hash ^ (seed * 37)) & MAX_CHANNEL;
        raw[pixel + 1] = (hash >>> 8) & MAX_CHANNEL;
        raw[pixel + 2] = (hash >>> 16) & MAX_CHANNEL;
        raw[pixel + 3] = MAX_CHANNEL;
        continue;
      }
      let r = ((x * MAX_CHANNEL) / side) | 0;
      let g = ((y * MAX_CHANNEL) / side) | 0;
      let b = (seed * 53) & MAX_CHANNEL;
      for (const disc of discs) {
        const dx = x - disc.x;
        const dy = y - disc.y;
        if (dx * dx + dy * dy < disc.radius * disc.radius) {
          r = disc.shade;
          g = MAX_CHANNEL - disc.shade;
          b = (disc.shade * 3) & MAX_CHANNEL;
          break;
        }
      }
      raw[pixel] = r;
      raw[pixel + 1] = g;
      raw[pixel + 2] = b;
      raw[pixel + 3] = MAX_CHANNEL;
    }
  }

  const compressed = new Uint8Array(
    await new Response(
      new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate")),
    ).arrayBuffer(),
  );

  const ihdr = new Uint8Array(IHDR_BYTES);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, side);
  view.setUint32(4, side);
  ihdr[8] = BIT_DEPTH;
  ihdr[9] = COLOR_TYPE_RGBA;
  const parts = [
    Uint8Array.from(PNG_SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("IDAT", compressed),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
