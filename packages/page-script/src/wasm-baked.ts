// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Matches page WebAssembly requests to baked modules by URL or byte content.

import { bakedWasm, manifest, emptyModule } from "./__ks_wasm_registry.js";
import type { BakedWasmModule } from "./__ks_wasm_registry.js";
import { state } from "./state.ts";

const EMPTY_WASM = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

interface DecodedEntry {
  url: string;
  size: number;
  sha256: string;
  head16: Uint8Array;
  tail16: Uint8Array;
  bytes: Uint8Array | null;
}

let decodedCache: DecodedEntry[] | null = null;

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodedEntries(): DecodedEntry[] {
  if (decodedCache) return decodedCache;
  decodedCache = Object.entries(manifest).map(([url, e]) => ({
    url,
    size: e.size,
    sha256: e.sha256,
    head16: b64ToBytes(e.head16),
    tail16: b64ToBytes(e.tail16),
    bytes: e.bytesB64 ? b64ToBytes(e.bytesB64) : null,
  }));
  return decodedCache;
}

function toU8(src: unknown): Uint8Array | null {
  if (src instanceof Uint8Array) return src;
  if (src instanceof ArrayBuffer) return new Uint8Array(src);
  if (ArrayBuffer.isView(src)) {
    const view = src as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return null;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function matchWasmByUrl(url: unknown): BakedWasmModule | null {
  if (typeof url !== "string" || url.length === 0) return null;
  if (hasBakedUrl(url)) return bakedWasm[url];
  return matchAbsoluteWasmUrl(url);
}

function hasBakedUrl(url: string): boolean {
  return Object.prototype.hasOwnProperty.call(bakedWasm, url);
}

function matchAbsoluteWasmUrl(url: string): BakedWasmModule | null {
  try {
    const abs = new URL(url, state.pageUrl || undefined).toString();
    if (hasBakedUrl(abs)) return bakedWasm[abs];
  } catch {}
  return null;
}

function fingerprintCandidates(u8: Uint8Array): DecodedEntry[] {
  const WASM_FINGERPRINT_EDGE_BYTES = 16;
  return decodedEntries().filter((e) => {
    if (e.size !== u8.length) return false;
    const head = u8.subarray(0, Math.min(WASM_FINGERPRINT_EDGE_BYTES, u8.length));
    const tail = u8.subarray(Math.max(0, u8.length - WASM_FINGERPRINT_EDGE_BYTES));
    return bytesEqual(e.head16, head) && bytesEqual(e.tail16, tail);
  });
}

export function matchWasmByBytesSync(src: unknown): BakedWasmModule | null {
  const u8 = toU8(src);
  if (!u8) return null;
  if (isEmptyWasm(u8)) return emptyModule;
  return moduleForCandidates(u8, fingerprintCandidates(u8));
}

function isEmptyWasm(bytes: Uint8Array): boolean {
  return bytes.length === EMPTY_WASM.length && bytesEqual(bytes, Uint8Array.from(EMPTY_WASM));
}

function moduleForCandidates(
  bytes: Uint8Array,
  candidates: DecodedEntry[],
): BakedWasmModule | null {
  for (const entry of candidates) {
    if (entry.bytes && !bytesEqual(entry.bytes, bytes)) continue;
    return bakedWasm[entry.url] ?? null;
  }
  return null;
}

export async function matchWasmByBytes(src: unknown): Promise<BakedWasmModule | null> {
  const u8 = toU8(src);
  if (!u8) return null;
  if (u8.length === EMPTY_WASM.length && bytesEqual(u8, Uint8Array.from(EMPTY_WASM))) {
    return emptyModule;
  }
  const candidates = fingerprintCandidates(u8);
  if (candidates.length === 0) return null;
  const copy = new Uint8Array(u8);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  const d8 = new Uint8Array(digest);
  const WASM_DIGEST_HEX_RADIX = 16;
  const WASM_DIGEST_HEX_BYTE_WIDTH = 2;
  let hex = "";
  for (let i = 0; i < d8.length; i++) {
    hex += d8[i].toString(WASM_DIGEST_HEX_RADIX).padStart(WASM_DIGEST_HEX_BYTE_WIDTH, "0");
  }
  for (const e of candidates) {
    if (e.sha256 === hex) return bakedWasm[e.url] ?? null;
  }
  return null;
}
