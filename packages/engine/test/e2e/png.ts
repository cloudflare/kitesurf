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

export async function decodePng(bytes: Uint8Array): Promise<DecodedPng> {
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
    if (type === "IHDR") {
      width = view.getUint32(off + 8);
      height = view.getUint32(off + 12);
      const bitDepth = byteAt(bytes, off + 16);
      colorType = byteAt(bytes, off + 17);
      const interlace = byteAt(bytes, off + 20);
      if (bitDepth !== 8 || interlace !== 0 || (colorType !== 6 && colorType !== 2)) {
        throw new Error(
          `unsupported PNG: depth=${bitDepth} color=${colorType} interlace=${interlace}`,
        );
      }
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }

  const total = idat.reduce((n, c) => n + c.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const c of idat) {
    joined.set(c, at);
    at += c.length;
  }
  const raw = await inflate(joined);

  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const out = new Uint8Array(width * height * 4);
  const line = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  let src = 0;
  for (let y = 0; y < height; y++) {
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
    src += stride;
    for (let x = 0; x < width; x++) {
      const s = x * bpp;
      const d = (y * width + x) * 4;
      out[d] = byteAt(line, s);
      out[d + 1] = byteAt(line, s + 1);
      out[d + 2] = byteAt(line, s + 2);
      out[d + 3] = bpp === 4 ? byteAt(line, s + 3) : 255;
    }
    prev.set(line);
  }
  return { width, height, data: out };
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
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (let y = y0; y < Math.min(y1, png.height); y++) {
    for (let x = x0; x < Math.min(x1, png.width); x++) {
      const i = (y * png.width + x) * 4;
      if (pred(byteAt(png.data, i), byteAt(png.data, i + 1), byteAt(png.data, i + 2))) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY - y0, w: maxX - minX + 1, h: maxY - minY + 1 };
}
