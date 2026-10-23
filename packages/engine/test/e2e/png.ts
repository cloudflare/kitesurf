// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

export interface DecodedPng {
  width: number;
  height: number;
  data: Uint8Array;
}

async function inflate(chunks: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([chunks as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate"));
  const parts: Uint8Array[] = [];
  const reader = stream.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value as Uint8Array);
    total += (value as Uint8Array).length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function byteAt(buf: Uint8Array, i: number): number {
  return buf[i] ?? 0;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

interface PngChunks {
  width: number;
  height: number;
  colorType: number;
  idat: Uint8Array[];
}

function parseHeader(
  bytes: Uint8Array,
  view: DataView,
  off: number,
): Pick<PngChunks, "width" | "height" | "colorType"> {
  const width = view.getUint32(off + 8);
  const height = view.getUint32(off + 12);
  const bitDepth = byteAt(bytes, off + 16);
  const colorType = byteAt(bytes, off + 17);
  const interlace = byteAt(bytes, off + 20);
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(`unsupported PNG: depth=${bitDepth} color=${colorType} interlace=${interlace}`);
  }
  return { width, height, colorType };
}

function parseChunks(bytes: Uint8Array): PngChunks {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 8;
  let width = 0;
  let height = 0;
  let colorType = 6;
  const idat: Uint8Array[] = [];
  while (off < bytes.length) {
    const len = view.getUint32(off);
    const type = String.fromCharCode(...bytes.subarray(off + 4, off + 8));
    const body = bytes.subarray(off + 8, off + 8 + len);
    switch (type) {
      case "IHDR": {
        const header = parseHeader(bytes, view, off);
        width = header.width;
        height = header.height;
        colorType = header.colorType;
        break;
      }
      case "IDAT":
        idat.push(body);
        break;
      case "IEND":
        return { width, height, colorType, idat };
    }
    off += 12 + len;
  }
  return { width, height, colorType, idat };
}

function unfilterLine(
  raw: Uint8Array,
  src: number,
  stride: number,
  bpp: number,
  line: Uint8Array,
  prev: Uint8Array,
): number {
  const filter = byteAt(raw, src++);
  for (let i = 0; i < stride; i++) {
    const x = byteAt(raw, src + i);
    const a = i >= bpp ? byteAt(line, i - bpp) : 0;
    const b = byteAt(prev, i);
    const c = i >= bpp ? byteAt(prev, i - bpp) : 0;
    let value: number;
    switch (filter) {
      case 0:
        value = x;
        break;
      case 1:
        value = x + a;
        break;
      case 2:
        value = x + b;
        break;
      case 3:
        value = x + ((a + b) >> 1);
        break;
      case 4:
        value = x + paeth(a, b, c);
        break;
      default:
        throw new Error(`bad PNG filter ${filter}`);
    }
    line[i] = value & 0xff;
  }
  return src + stride;
}

function writeRgbaLine(
  out: Uint8Array,
  line: Uint8Array,
  width: number,
  y: number,
  bpp: number,
): void {
  for (let x = 0; x < width; x++) {
    const s = x * bpp;
    const d = (y * width + x) * 4;
    out[d] = byteAt(line, s);
    out[d + 1] = byteAt(line, s + 1);
    out[d + 2] = byteAt(line, s + 2);
    out[d + 3] = bpp === 4 ? byteAt(line, s + 3) : 255;
  }
}

function updateBounds(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  x: number,
  y: number,
): void {
  if (x < bounds.minX) bounds.minX = x;
  if (x > bounds.maxX) bounds.maxX = x;
  if (y < bounds.minY) bounds.minY = y;
  if (y > bounds.maxY) bounds.maxY = y;
}

function makeBounds(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  y0: number,
): { x: number; y: number; w: number; h: number } | null {
  return bounds.maxX < 0
    ? null
    : {
        x: bounds.minX,
        y: bounds.minY - y0,
        w: bounds.maxX - bounds.minX + 1,
        h: bounds.maxY - bounds.minY + 1,
      };
}

function scanBounds(
  png: DecodedPng,
  y0: number,
  y1: number,
  pred: (r: number, g: number, b: number) => boolean,
  x0: number,
  x1: number,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
): void {
  for (let y = y0; y < Math.min(y1, png.height); y++) {
    for (let x = x0; x < Math.min(x1, png.width); x++) {
      const i = (y * png.width + x) * 4;
      if (pred(byteAt(png.data, i), byteAt(png.data, i + 1), byteAt(png.data, i + 2))) {
        updateBounds(bounds, x, y);
      }
    }
  }
}

export async function decodePng(bytes: Uint8Array): Promise<DecodedPng> {
  const chunks = parseChunks(bytes);
  const total = chunks.idat.reduce((n, c) => n + c.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const c of chunks.idat) {
    joined.set(c, at);
    at += c.length;
  }
  const raw = await inflate(joined);

  const bpp = chunks.colorType === 6 ? 4 : 3;
  const stride = chunks.width * bpp;
  const out = new Uint8Array(chunks.width * chunks.height * 4);
  const line = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  let src = 0;
  for (let y = 0; y < chunks.height; y++) {
    src = unfilterLine(raw, src, stride, bpp, line, prev);
    writeRgbaLine(out, line, chunks.width, y, bpp);
    prev.set(line);
  }
  return { width: chunks.width, height: chunks.height, data: out };
}

/** Bounding box of pixels matching `pred` within the given vertical and horizontal bounds. */
export function bbox(
  png: DecodedPng,
  y0: number,
  y1: number,
  pred: (r: number, g: number, b: number) => boolean,
  x0 = 0,
  x1 = png.width,
): { x: number; y: number; w: number; h: number } | null {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -1, maxY: -1 };
  scanBounds(png, y0, y1, pred, x0, x1, bounds);
  return makeBounds(bounds, y0);
}
