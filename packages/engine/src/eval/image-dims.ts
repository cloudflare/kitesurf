// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Sniffs supported image dimensions and SVG markers directly from response bytes.

export interface ImageDims {
  width: number;
  height: number;
}

const MAX_IMAGE_DIMENSION = 65_535;
const MAX_SVG_SNIFF_BYTES = 2_048;

function u16be(b: Uint8Array, at: number): number {
  return ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
}
function u32be(b: Uint8Array, at: number): number {
  return (
    ((b[at] ?? 0) << 24) | ((b[at + 1] ?? 0) << 16) | ((b[at + 2] ?? 0) << 8) | (b[at + 3] ?? 0)
  );
}
function u16le(b: Uint8Array, at: number): number {
  return (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
}
function u32le(b: Uint8Array, at: number): number {
  return (
    (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16) | ((b[at + 3] ?? 0) << 24)
  );
}

function matches(b: Uint8Array, at: number, sig: number[]): boolean {
  for (let i = 0; i < sig.length; i++) {
    if (b[at + i] !== sig[i]) return false;
  }
  return true;
}

function ascii(b: Uint8Array, at: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(b[at + i] ?? 0);
  return s;
}

function sniffPng(b: Uint8Array): ImageDims | null {
  if (b.length < 24) return null;
  if (!matches(b, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return null;
  }
  if (ascii(b, 12, 4) !== "IHDR") return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

function sniffGif(b: Uint8Array): ImageDims | null {
  if (b.length < 10) return null;
  if (ascii(b, 0, 3) !== "GIF") return null;
  return { width: u16le(b, 6), height: u16le(b, 8) };
}

function sniffBmp(b: Uint8Array): ImageDims | null {
  if (b.length < 26) return null;
  if (b[0] !== 0x42 || b[1] !== 0x4d) return null;
  const headerSize = u32le(b, 14);
  if (headerSize === 12) {
    return { width: u16le(b, 18), height: u16le(b, 20) };
  }
  const h = u32le(b, 22) | 0;
  return { width: u32le(b, 18) | 0, height: Math.abs(h) };
}

function sniffJpeg(b: Uint8Array): ImageDims | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) {
      at++;
      continue;
    }
    const marker = b[at + 1] ?? 0;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return null;
    const len = u16be(b, at + 2);
    if (len < 2) return null;
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (at + 9 > b.length) return null;
      return { width: u16be(b, at + 7), height: u16be(b, at + 5) };
    }
    at += 2 + len;
  }
  return null;
}

function sniffWebp(b: Uint8Array): ImageDims | null {
  if (b.length < 30) return null;
  if (ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8X") {
    const w = ((b[24] ?? 0) | ((b[25] ?? 0) << 8) | ((b[26] ?? 0) << 16)) + 1;
    const h = ((b[27] ?? 0) | ((b[28] ?? 0) << 8) | ((b[29] ?? 0) << 16)) + 1;
    return { width: w, height: h };
  }
  if (chunk === "VP8L") {
    const bits = (b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) << 24);
    if ((b[20] ?? 0) !== 0x2f) return null;
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    };
  }
  if (chunk === "VP8 ") {
    if (!matches(b, 23, [0x9d, 0x01, 0x2a])) return null;
    return {
      width: u16le(b, 26) & 0x3fff,
      height: u16le(b, 28) & 0x3fff,
    };
  }
  return null;
}

const MAX_ISOBMFF_SCAN_BYTES = 64 * 1024;
function sniffIsobmff(b: Uint8Array): ImageDims | null {
  if (b.length < 12 || ascii(b, 4, 4) !== "ftyp") return null;
  const brand = ascii(b, 8, 4);
  if (
    brand !== "avif" &&
    brand !== "avis" &&
    brand !== "heic" &&
    brand !== "heix" &&
    brand !== "mif1" &&
    brand !== "msf1"
  ) {
    return null;
  }
  const limit = Math.min(b.length - 12, MAX_ISOBMFF_SCAN_BYTES);
  for (let at = 12; at < limit; at++) {
    if (ascii(b, at, 4) !== "ispe") continue;
    return { width: u32be(b, at + 8), height: u32be(b, at + 12) };
  }
  return null;
}

export function looksLikeSvg(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, MAX_SVG_SNIFF_BYTES);
  let i = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
  for (;;) {
    while (i < limit && isXmlSpace(bytes[i])) i++;
    if (i >= limit || bytes[i] !== 0x3c) return false;
    const next = bytes[i + 1];
    if (next === 0x3f) {
      const end = indexOfAscii(bytes, "?>", i + 2, limit);
      if (end < 0) return false;
      i = end + 2;
      continue;
    }
    if (next === 0x21) {
      if (matchesAscii(bytes, i + 2, "--")) {
        const end = indexOfAscii(bytes, "-->", i + 4, limit);
        if (end < 0) return false;
        i = end + 3;
        continue;
      }
      let at = i + 2;
      const open = indexOfAscii(bytes, "[", at, limit);
      if (open >= 0) {
        const close = indexOfAscii(bytes, "]", open + 1, limit);
        if (close < 0) return false;
        at = close + 1;
      }
      const end = indexOfByte(bytes, 0x3e, at, limit);
      if (end < 0) return false;
      i = end + 1;
      continue;
    }
    return isSvgRootName(bytes, i + 1, limit);
  }
}

function isXmlSpace(b: number | undefined): boolean {
  return b === 0x20 || b === 0x09 || b === 0x0d || b === 0x0a;
}

function isSvgRootName(bytes: Uint8Array, at: number, limit: number): boolean {
  let end = at;
  while (end < limit) {
    const b = bytes[end] ?? 0;
    if (isXmlSpace(b) || b === 0x2f || b === 0x3e) break;
    end++;
  }
  if (end === at || end >= limit) return false;
  let name = "";
  for (let i = at; i < end; i++) {
    name += String.fromCharCode(bytes[i] ?? 0);
  }
  name = name.toLowerCase();
  return name === "svg" || name.endsWith(":svg");
}

function matchesAscii(bytes: Uint8Array, at: number, needle: string): boolean {
  for (let i = 0; i < needle.length; i++) {
    if (bytes[at + i] !== needle.charCodeAt(i)) return false;
  }
  return true;
}

function indexOfAscii(bytes: Uint8Array, needle: string, from: number, limit: number): number {
  for (let i = from; i + needle.length <= limit; i++) {
    if (matchesAscii(bytes, i, needle)) return i;
  }
  return -1;
}

function indexOfByte(bytes: Uint8Array, byte: number, from: number, limit: number): number {
  for (let i = from; i < limit; i++) if (bytes[i] === byte) return i;
  return -1;
}

export function sniffImageDims(bytes: Uint8Array): ImageDims | null {
  const dims =
    sniffPng(bytes) ??
    sniffGif(bytes) ??
    sniffJpeg(bytes) ??
    sniffWebp(bytes) ??
    sniffBmp(bytes) ??
    sniffIsobmff(bytes);
  if (!dims) return null;
  const { width, height } = dims;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width <= 0 || height <= 0 || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    return null;
  }
  return dims;
}
