// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { deflateSync, inflateSync } from "node:zlib";

export interface DecodedPng {
  width: number;
  height: number;
  pixels: Uint8Array;
}

interface PngChunks {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  idat: Uint8Array[];
}

function parseChunks(buf: Uint8Array): PngChunks {
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Uint8Array[] = [];
  while (off < buf.length) {
    const len = (buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3];
    const type = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
    const data = buf.subarray(off + 8, off + 8 + len);
    switch (type) {
      case "IHDR":
        width = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
        height = (data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7];
        bitDepth = data[8];
        colorType = data[9];
        break;
      case "IDAT":
        idat.push(data);
        break;
      case "IEND":
        return { width, height, bitDepth, colorType, idat };
    }
    off += 8 + len + 4;
  }
  return { width, height, bitDepth, colorType, idat };
}

function assertSupportedShape(bitDepth: number, colorType: number): void {
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(`unsupported PNG shape: depth=${bitDepth} color=${colorType}`);
  }
}

function restoreByte(filter: number, value: number, a: number, b: number, c: number): number {
  switch (filter) {
    case 1:
      return (value + a) & 0xff;
    case 2:
      return (value + b) & 0xff;
    case 3:
      return (value + ((a + b) >> 1)) & 0xff;
    case 4: {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      return (value + pred) & 0xff;
    }
    default:
      return value;
  }
}

function restoreLine(
  filter: number,
  line: Uint8Array,
  previous: Uint8Array,
  current: Uint8Array,
  bpp: number,
): void {
  for (let i = 0; i < current.length; i++) {
    const a = i >= bpp ? current[i - bpp] : 0;
    const b = previous[i];
    const c = i >= bpp ? previous[i - bpp] : 0;
    current[i] = restoreByte(filter, line[i], a, b, c);
  }
}

function writeRgbaLine(
  pixels: Uint8Array,
  current: Uint8Array,
  width: number,
  y: number,
  bpp: number,
): void {
  for (let x = 0; x < width; x++) {
    const si = x * bpp;
    const di = (y * width + x) * 4;
    pixels[di] = current[si];
    pixels[di + 1] = current[si + 1];
    pixels[di + 2] = current[si + 2];
    pixels[di + 3] = bpp === 4 ? current[si + 3] : 255;
  }
}

function decodeRows(raw: Uint8Array, width: number, height: number, bpp: number): Uint8Array {
  const stride = width * bpp;
  const pixels = new Uint8Array(width * height * 4);
  const previous = new Uint8Array(stride);
  const current = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    restoreLine(filter, line, previous, current, bpp);
    writeRgbaLine(pixels, current, width, y, bpp);
    previous.set(current);
  }
  return pixels;
}

export function decodePng(buf: Uint8Array): DecodedPng {
  const { width, height, bitDepth, colorType, idat } = parseChunks(buf);
  assertSupportedShape(bitDepth, colorType);
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat.map((d) => Buffer.from(d))));
  return { width, height, pixels: decodeRows(raw, width, height, bpp) };
}

export function sample(png: DecodedPng, x: number, y: number): [number, number, number] {
  const i = (Math.round(y) * png.width + Math.round(x)) * 4;
  return [png.pixels[i], png.pixels[i + 1], png.pixels[i + 2]];
}

export function near(
  actual: [number, number, number],
  want: [number, number, number],
  tolerance = 12,
): boolean {
  return (
    Math.abs(actual[0] - want[0]) <= tolerance &&
    Math.abs(actual[1] - want[1]) <= tolerance &&
    Math.abs(actual[2] - want[2]) <= tolerance
  );
}

function makeCrcTable(): number[] {
  const crcTable: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  return crcTable;
}

function crc32(bytes: Uint8Array, crcTable: number[]): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array, crcTable: number[]): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length), crcTable));
  return out;
}

export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const crcTable = makeCrcTable();
  const ihdr = new Uint8Array(13);
  const ihdrDv = new DataView(ihdr.buffer);
  ihdrDv.setUint32(0, width);
  ihdrDv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (1 + width * 4) + 1);
  }
  const idat = new Uint8Array(deflateSync(raw));
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [
    sig,
    chunk("IHDR", ihdr, crcTable),
    chunk("IDAT", idat, crcTable),
    chunk("IEND", new Uint8Array(0), crcTable),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
