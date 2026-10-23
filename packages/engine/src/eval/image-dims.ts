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
function u24le(b: Uint8Array, at: number): number {
  return (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16);
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

type JpegStep = { next: number } | { dims: ImageDims } | { stop: true };

function isStandaloneJpegMarker(marker: number): boolean {
  return marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

function isJpegEndMarker(marker: number): boolean {
  return marker === 0xda || marker === 0xd9;
}

function isJpegSofMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function jpegSofStep(bytes: Uint8Array, at: number): JpegStep {
  if (at + 9 > bytes.length) return { stop: true };
  return { dims: { width: u16be(bytes, at + 7), height: u16be(bytes, at + 5) } };
}

function jpegStep(bytes: Uint8Array, at: number): JpegStep {
  if (bytes[at] !== 0xff) return { next: at + 1 };
  const marker = bytes[at + 1] ?? 0;
  return jpegMarkerStep(bytes, at, marker);
}

function jpegMarkerStep(bytes: Uint8Array, at: number, marker: number): JpegStep {
  if (isStandaloneJpegMarker(marker)) return { next: at + 2 };
  if (isJpegEndMarker(marker)) return { stop: true };
  const len = u16be(bytes, at + 2);
  if (len < 2) return { stop: true };
  if (isJpegSofMarker(marker)) return jpegSofStep(bytes, at);
  return { next: at + 2 + len };
}

function sniffJpeg(b: Uint8Array): ImageDims | null {
  if (!startsWithJpeg(b)) return null;
  let at = 2;
  while (at + 4 <= b.length) {
    const step = jpegStep(b, at);
    if ("dims" in step) return step.dims;
    if ("stop" in step) return null;
    at = step.next;
  }
  return null;
}

function startsWithJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

function sniffWebp(b: Uint8Array): ImageDims | null {
  if (b.length < 30) return null;
  if (ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return null;
  return sniffWebpChunk(b, ascii(b, 12, 4));
}

function sniffWebpChunk(bytes: Uint8Array, chunk: string): ImageDims | null {
  if (chunk === "VP8X") return sniffWebpExtended(bytes);
  if (chunk === "VP8L") return sniffWebpLossless(bytes);
  if (chunk === "VP8 ") return sniffWebpLossy(bytes);
  return null;
}

function sniffWebpExtended(bytes: Uint8Array): ImageDims {
  const width = u24le(bytes, 24) + 1;
  const height = u24le(bytes, 27) + 1;
  return { width, height };
}

function sniffWebpLossless(bytes: Uint8Array): ImageDims | null {
  const bits = u32le(bytes, 21);
  if ((bytes[20] ?? 0) !== 0x2f) return null;
  return {
    width: (bits & 0x3fff) + 1,
    height: ((bits >>> 14) & 0x3fff) + 1,
  };
}

function sniffWebpLossy(bytes: Uint8Array): ImageDims | null {
  if (!matches(bytes, 23, [0x9d, 0x01, 0x2a])) return null;
  return {
    width: u16le(bytes, 26) & 0x3fff,
    height: u16le(bytes, 28) & 0x3fff,
  };
}

const MAX_ISOBMFF_SCAN_BYTES = 64 * 1024;
const ISOBMFF_IMAGE_BRANDS = new Set(["avif", "avis", "heic", "heix", "mif1", "msf1"]);

function sniffIsobmff(b: Uint8Array): ImageDims | null {
  if (b.length < 12 || ascii(b, 4, 4) !== "ftyp") return null;
  const brand = ascii(b, 8, 4);
  if (!ISOBMFF_IMAGE_BRANDS.has(brand)) return null;
  return sniffIsobmffDimensions(b);
}

function sniffIsobmffDimensions(bytes: Uint8Array): ImageDims | null {
  const limit = Math.min(bytes.length - 12, MAX_ISOBMFF_SCAN_BYTES);
  for (let at = 12; at < limit; at++) {
    if (ascii(bytes, at, 4) !== "ispe") continue;
    return { width: u32be(bytes, at + 8), height: u32be(bytes, at + 12) };
  }
  return null;
}

type SvgProbe =
  | { kind: "next"; index: number }
  | { kind: "root"; matches: boolean }
  | { kind: "end" };

function svgStartIndex(bytes: Uint8Array): number {
  return bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
}

function skipXmlSpace(bytes: Uint8Array, at: number, limit: number): number {
  while (at < limit && isXmlSpace(bytes[at])) at++;
  return at;
}

function isMarkupStart(bytes: Uint8Array, at: number, limit: number): boolean {
  return at < limit && bytes[at] === 0x3c;
}

function readSvgProbe(bytes: Uint8Array, at: number, limit: number): SvgProbe {
  const start = skipXmlSpace(bytes, at, limit);
  if (!isMarkupStart(bytes, start, limit)) return { kind: "end" };
  const next = skipIgnoredMarkup(bytes, start, limit);
  if (next === null) {
    return { kind: "root", matches: isSvgRootName(bytes, start + 1, limit) };
  }
  return next < 0 ? { kind: "end" } : { kind: "next", index: next };
}

export function looksLikeSvg(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, MAX_SVG_SNIFF_BYTES);
  let i = svgStartIndex(bytes);
  while (i < limit) {
    const probe = readSvgProbe(bytes, i, limit);
    if (probe.kind === "root") return probe.matches;
    if (probe.kind === "end") return false;
    i = probe.index;
  }
  return false;
}

function isXmlSpace(b: number | undefined): boolean {
  return b === 0x20 || b === 0x09 || b === 0x0d || b === 0x0a;
}

function isXmlNameEnd(b: number | undefined): boolean {
  return isXmlSpace(b) || b === 0x2f || b === 0x3e;
}

function xmlNameEnd(bytes: Uint8Array, at: number, limit: number): number {
  let end = at;
  while (end < limit && !isXmlNameEnd(bytes[end])) end++;
  return end;
}

function isSvgRootName(bytes: Uint8Array, at: number, limit: number): boolean {
  const end = xmlNameEnd(bytes, at, limit);
  if (end === at || end >= limit) return false;
  return isSvgName(ascii(bytes, at, end - at).toLowerCase());
}

function isSvgName(name: string): boolean {
  return name === "svg" || name.endsWith(":svg");
}

function skipProcessingInstruction(bytes: Uint8Array, at: number, limit: number): number {
  const end = indexOfAscii(bytes, "?>", at + 2, limit);
  return end < 0 ? -1 : end + 2;
}

function skipComment(bytes: Uint8Array, at: number, limit: number): number {
  const end = indexOfAscii(bytes, "-->", at + 4, limit);
  return end < 0 ? -1 : end + 3;
}

function skipDoctype(bytes: Uint8Array, at: number, limit: number): number {
  let scanFrom = at + 2;
  const open = indexOfAscii(bytes, "[", scanFrom, limit);
  if (open >= 0) {
    const close = indexOfAscii(bytes, "]", open + 1, limit);
    if (close < 0) return -1;
    scanFrom = close + 1;
  }
  const end = indexOfByte(bytes, 0x3e, scanFrom, limit);
  return end < 0 ? -1 : end + 1;
}

function skipMarkupDeclaration(bytes: Uint8Array, at: number, limit: number): number {
  return matchesAscii(bytes, at + 2, "--")
    ? skipComment(bytes, at, limit)
    : skipDoctype(bytes, at, limit);
}

function skipIgnoredMarkup(bytes: Uint8Array, at: number, limit: number): number | null {
  const next = bytes[at + 1];
  if (next === 0x3f) return skipProcessingInstruction(bytes, at, limit);
  if (next === 0x21) return skipMarkupDeclaration(bytes, at, limit);
  return null;
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
  const dims = sniffKnownImageFormat(bytes);
  if (!dims || !hasValidDimensions(dims)) return null;
  return dims;
}

function sniffKnownImageFormat(bytes: Uint8Array): ImageDims | null {
  return sniffStandardImageFormat(bytes) ?? sniffIsobmff(bytes);
}

function sniffStandardImageFormat(bytes: Uint8Array): ImageDims | null {
  return (
    sniffPng(bytes) ?? sniffGif(bytes) ?? sniffJpeg(bytes) ?? sniffWebp(bytes) ?? sniffBmp(bytes)
  );
}

function hasValidDimensions(dims: ImageDims): boolean {
  const { width, height } = dims;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return false;
  return isDimensionInRange(width) && isDimensionInRange(height);
}

function isDimensionInRange(value: number): boolean {
  return value > 0 && value <= MAX_IMAGE_DIMENSION;
}
