// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";

import { looksLikeSvg, sniffImageDims } from "../src/eval/image-dims.ts";

function bytes(...parts: (number[] | Uint8Array | string)[]): Uint8Array {
  const flat: number[] = [];
  for (const p of parts) {
    if (typeof p === "string") {
      for (let i = 0; i < p.length; i++) flat.push(p.charCodeAt(i));
    } else {
      for (const b of p) flat.push(b);
    }
  }
  return new Uint8Array(flat);
}

const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const be16 = (n: number) => [(n >>> 8) & 0xff, n & 0xff];
const le16 = (n: number) => [n & 0xff, (n >>> 8) & 0xff];
const le32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function png(w: number, h: number): Uint8Array {
  return bytes(PNG_SIG, be32(13), "IHDR", be32(w), be32(h), [8, 6, 0, 0, 0]);
}

describe("image header dimension sniff", () => {
  it("reads PNG from IHDR", () => {
    expect(sniffImageDims(png(1280, 720))).toEqual({
      width: 1280,
      height: 720,
    });
  });

  it("reads GIF little-endian screen descriptor", () => {
    const g = bytes("GIF89a", le16(640), le16(480), [0xf7, 0x00, 0x00]);
    expect(sniffImageDims(g)).toEqual({ width: 640, height: 480 });
  });

  it("walks JPEG APPn segments to reach SOF0", () => {
    const app0 = bytes(
      [0xff, 0xe0],
      be16(16),
      "JFIF\0",
      [0x01, 0x02, 0x00],
      le16(72),
      le16(72),
      [0x00, 0x00],
    );
    const sof0 = bytes(
      [0xff, 0xc0],
      be16(17),
      [8],
      be16(333),
      be16(444),
      [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
    );
    expect(sniffImageDims(bytes([0xff, 0xd8], app0, sof0))).toEqual({
      width: 444,
      height: 333,
    });
  });

  it("treats a progressive JPEG's SOF2 as a size marker", () => {
    const sof2 = bytes([0xff, 0xc2], be16(11), [8], be16(20), be16(30), [1, 1, 0x11, 0]);
    expect(sniffImageDims(bytes([0xff, 0xd8], sof2))).toEqual({
      width: 30,
      height: 20,
    });
  });

  it("does not mistake DHT for a size marker", () => {
    const dht = bytes([0xff, 0xc4], be16(6), [0, 1, 2, 3]);
    const sof0 = bytes([0xff, 0xc0], be16(11), [8], be16(7), be16(9), [1, 1, 0x11, 0]);
    expect(sniffImageDims(bytes([0xff, 0xd8], dht, sof0))).toEqual({
      width: 9,
      height: 7,
    });
  });

  it("gives up on a JPEG whose scan starts before any SOFn", () => {
    const sos = bytes([0xff, 0xda], be16(8), [1, 1, 0, 0, 63, 0]);
    expect(sniffImageDims(bytes([0xff, 0xd8], sos))).toBeNull();
  });

  it("reads all three WebP sub-formats", () => {
    const vp8x = bytes(
      "RIFF",
      le32(30),
      "WEBP",
      "VP8X",
      le32(10),
      [0x10, 0, 0, 0],
      [(200 - 1) & 0xff, 0, 0],
      [(100 - 1) & 0xff, 0, 0],
    );
    expect(sniffImageDims(vp8x)).toEqual({ width: 200, height: 100 });

    const packed = (64 - 1) | ((48 - 1) << 14);
    const vp8l = bytes(
      "RIFF",
      le32(30),
      "WEBP",
      "VP8L",
      le32(10),
      [0x2f],
      le32(packed),
      [0, 0, 0, 0, 0],
    );
    expect(sniffImageDims(vp8l)).toEqual({ width: 64, height: 48 });

    const vp8 = bytes(
      "RIFF",
      le32(30),
      "WEBP",
      "VP8 ",
      le32(12),
      [0, 0, 0],
      [0x9d, 0x01, 0x2a],
      le16(320),
      le16(240),
      [0, 0],
    );
    expect(sniffImageDims(vp8)).toEqual({ width: 320, height: 240 });
  });

  it("reads BMP, and a bottom-up negative height as positive", () => {
    const bmp = bytes(
      "BM",
      le32(200),
      le16(0),
      le16(0),
      le32(54),
      le32(40),
      le32(50),
      le32(0xffffffe2),
      le16(1),
      le16(24),
    );
    expect(sniffImageDims(bmp)).toEqual({ width: 50, height: 30 });
  });

  it("finds AVIF dimensions in the nested ispe box", () => {
    const avif = bytes(
      be32(24),
      "ftyp",
      "avif",
      "avifmif1miaf",
      be32(20),
      "ispe",
      be32(0),
      be32(96),
      be32(64),
    );
    expect(sniffImageDims(avif)).toEqual({ width: 96, height: 64 });
  });

  it("returns null for SVG so its bytes keep flowing to usvg", () => {
    const svg = bytes('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    expect(sniffImageDims(svg)).toBeNull();
  });

  it("rejects degenerate and absurd dimensions", () => {
    expect(sniffImageDims(png(0, 10))).toBeNull();
    expect(sniffImageDims(png(10, 0))).toBeNull();
    expect(sniffImageDims(png(70000, 10))).toBeNull();
  });

  it("returns null on a truncated header or unknown container", () => {
    expect(sniffImageDims(bytes(PNG_SIG))).toBeNull();
    expect(sniffImageDims(new Uint8Array(0))).toBeNull();
    expect(sniffImageDims(bytes("not an image at all"))).toBeNull();
  });
});

describe("SVG body sniff", () => {
  it("accepts SVG behind a BOM, XML declaration, doctype or comment", () => {
    expect(looksLikeSvg(bytes('<svg xmlns="x"/>'))).toBe(true);
    expect(looksLikeSvg(bytes([0xef, 0xbb, 0xbf], "<svg/>"))).toBe(true);
    expect(looksLikeSvg(bytes('<?xml version="1.0"?>\n<svg/>'))).toBe(true);
    expect(looksLikeSvg(bytes("<!DOCTYPE svg PUBLIC 'x' 'y'>\n<svg/>"))).toBe(true);
    expect(looksLikeSvg(bytes("<!-- generated -->\n  <SVG/>"))).toBe(true);
  });

  it("accepts a namespace-prefixed root and a doctype internal subset", () => {
    expect(looksLikeSvg(bytes('<s:svg xmlns:s="x"/>'))).toBe(true);
    expect(looksLikeSvg(bytes("<!DOCTYPE svg [ <!ENTITY a 'b<c>d'> ]>\n<svg/>"))).toBe(true);
  });

  it("rejects bodies that are not standalone SVG documents", () => {
    expect(looksLikeSvg(bytes('{"secret":"value"}'))).toBe(false);
    expect(looksLikeSvg(bytes("<!doctype html><html><body>hi"))).toBe(false);
    expect(looksLikeSvg(bytes("body { color: red }"))).toBe(false);
    expect(looksLikeSvg(new Uint8Array(0))).toBe(false);
  });

  it("requires the ROOT element, not `<svg` somewhere in the head", () => {
    expect(looksLikeSvg(bytes('<!doctype html><html><body><svg viewBox="0 0 1 1">'))).toBe(false);
    expect(looksLikeSvg(bytes('{"icon":"<svg/>","secret":"value"}'))).toBe(false);
    expect(looksLikeSvg(bytes("<html><svg/></html>"))).toBe(false);
    expect(looksLikeSvg(bytes("<svgx/>"))).toBe(false);
    expect(looksLikeSvg(bytes("<svg-icon/>"))).toBe(false);
    expect(looksLikeSvg(bytes("secret<svg/>"))).toBe(false);
    expect(looksLikeSvg(bytes('<?xml version="1.0"\n<svg/>'))).toBe(false);
    expect(looksLikeSvg(bytes("<!-- <svg/> "))).toBe(false);
  });

  it("only scans a bounded head", () => {
    const padded = bytes("x".repeat(4096), "<svg/>");
    expect(looksLikeSvg(padded)).toBe(false);
  });
});
