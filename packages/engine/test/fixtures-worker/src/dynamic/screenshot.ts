// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { Hono } from "hono";

const WIDTH = 2100;
const HEIGHT = 2100;
const BYTES_PER_PIXEL = 3;
const FILTER_BYTES = 1;
const ROW_BYTES = WIDTH * BYTES_PER_PIXEL + FILTER_BYTES;
const RAW_BYTES = HEIGHT * ROW_BYTES;
const STORED_BLOCK_BYTES = 5;
const STORED_BLOCK_MAX = 65_535;
const DEFLATE_HEADER_BYTES = 2;
const ADLER32_BYTES = 4;
const PNG_SIGNATURE_BYTES = 8;
const PNG_CHUNK_OVERHEAD_BYTES = 12;
const PNG_IHDR_BYTES = 13;
const ZLIB_STREAM_BYTES =
  DEFLATE_HEADER_BYTES +
  RAW_BYTES +
  Math.ceil(RAW_BYTES / STORED_BLOCK_MAX) * STORED_BLOCK_BYTES +
  ADLER32_BYTES;

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function writeChunk(
  output: Uint8Array,
  view: DataView,
  offset: number,
  type: string,
  length: number,
  writeData: (dataOffset: number) => void,
): number {
  view.setUint32(offset, length);
  for (let i = 0; i < 4; i++) output[offset + 4 + i] = type.charCodeAt(i);
  const dataOffset = offset + 8;
  writeData(dataOffset);
  view.setUint32(dataOffset + length, crc32(output.subarray(offset + 4, dataOffset + length)));
  return dataOffset + length + 4;
}

function screenshotNoisePng(): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(
    PNG_SIGNATURE_BYTES +
      PNG_CHUNK_OVERHEAD_BYTES +
      PNG_IHDR_BYTES +
      PNG_CHUNK_OVERHEAD_BYTES +
      ZLIB_STREAM_BYTES +
      PNG_CHUNK_OVERHEAD_BYTES,
  );
  output.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(output.buffer);
  let offset = writeChunk(
    output,
    view,
    PNG_SIGNATURE_BYTES,
    "IHDR",
    PNG_IHDR_BYTES,
    (dataOffset) => {
      view.setUint32(dataOffset, WIDTH);
      view.setUint32(dataOffset + 4, HEIGHT);
      output[dataOffset + 8] = 8;
      output[dataOffset + 9] = 2;
      output[dataOffset + 10] = 0;
      output[dataOffset + 11] = 0;
      output[dataOffset + 12] = 0;
    },
  );
  offset = writeChunk(output, view, offset, "IDAT", ZLIB_STREAM_BYTES, (dataOffset) => {
    let compressedOffset = dataOffset;
    output[compressedOffset++] = 0x78;
    output[compressedOffset++] = 0x01;
    let rawOffset = 0;
    let seed = 42;
    let adlerA = 1;
    let adlerB = 0;
    while (rawOffset < RAW_BYTES) {
      const blockLength = Math.min(STORED_BLOCK_MAX, RAW_BYTES - rawOffset);
      output[compressedOffset++] = rawOffset + blockLength === RAW_BYTES ? 1 : 0;
      output[compressedOffset++] = blockLength & 0xff;
      output[compressedOffset++] = blockLength >>> 8;
      const complement = ~blockLength & 0xffff;
      output[compressedOffset++] = complement & 0xff;
      output[compressedOffset++] = complement >>> 8;
      for (let i = 0; i < blockLength; i++) {
        const rowOffset = (rawOffset + i) % ROW_BYTES;
        let byte = 0;
        if (rowOffset !== 0) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          byte = seed >>> 24;
        }
        output[compressedOffset++] = byte;
        adlerA += byte;
        adlerB += adlerA;
        if ((rawOffset + i + 1) % 5552 === 0) {
          adlerA %= 65_521;
          adlerB %= 65_521;
        }
      }
      rawOffset += blockLength;
    }
    adlerA %= 65_521;
    adlerB %= 65_521;
    view.setUint32(compressedOffset, ((adlerB << 16) | adlerA) >>> 0);
  });
  writeChunk(output, view, offset, "IEND", 0, () => {});
  return output;
}

export const screenshot = new Hono();

screenshot.get("/oversized-image.html", (c) =>
  c.html(
    `<!doctype html><html><body style="margin:0"><img width="${WIDTH}" height="${HEIGHT}" src="/__fixtures/screenshot-noise-2100.png"></body></html>`,
  ),
);

screenshot.get("/screenshot-noise-2100.png", (c) =>
  c.body(screenshotNoisePng(), 200, {
    "content-type": "image/png",
    "cache-control": "no-store",
  }),
);
