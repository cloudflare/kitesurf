// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Rewrites RBI image and font references and tracks resources already sent to clients. Scenes
// reference glyphs, fonts and images by hash; the client fetches missing ones with
// `Kitesurf.getSceneResources` and receives a resource batch in this format.

// A batch is [count u32 LE] then entries of [kind u8][hash u64 LE][length u32 LE][payload].
const RBI_BATCH_HEAD = 4;
const RBI_ENTRY_HEAD = 13;
const RBI_ENTRY_ID_OFFSET = 1;
const RBI_ENTRY_LENGTH_OFFSET = 9;
// Kind 0 is a glyph outline path (f32, font design units). Kind 1 is font metrics: [glyphs u32]
// [cmap count u32][(codepoint u32, glyph u16) × count], then a u16 LE advance per glyph.
const RBI_KIND_IMAGE = 2;
// Image payloads start with width, height and format. Formats 2 and 3 add an 8-byte decode hint;
// format 3 is an engine-store reference with no body, which the client cannot fetch itself.
const IMAGE_FORMAT_ENCODED = 2;
const IMAGE_FORMAT_ENGINE_REF = 3;
const IMAGE_REF_PAYLOAD = 17;
const IMAGE_REF_FORMAT_OFFSET = 8;

// Font data is [reference type u8][face index u32] then inline bytes (blob) or a reference string.
// Asset references for UA fonts are fetched from `/rbi/fonts/*`.
const RBI_KIND_FONT_DATA = 3;
const FONT_DATA_REF_BLOB = 0;
const FONT_DATA_REF_ASSET = 1;
const FONT_ENTRY_HEAD = 5;

import { ENGINE_KEY_MARKER } from "./eval/resource-store.ts";

// A missing-resource request is [count u32 LE] then [kind u8][hash u64 LE] per item.
export const MISSING_RESOURCE_LIST_HEADER_BYTES = 4;
export const MISSING_RESOURCE_LIST_KIND_BYTES = 1;
export const MISSING_RESOURCE_LIST_ENTRY_BYTES = 9;
export const MAX_MISSING_RESOURCE_LIST_B64_CHARS = 64 * 1024;

const U64_MAX = (1n << 64n) - 1n;
const MAX_FONT_KEY_DECIMAL_DIGITS = 20;

function engineFontKey(batch: Uint8Array, from: number, to: number): bigint | null {
  if (to <= from || to - from > MAX_FONT_KEY_DECIMAL_DIGITS) return null;
  let key = 0n;
  for (let i = from; i < to; i++) {
    const byte = batch[i];
    if (byte === undefined || byte < 48 || byte > 57) return null;
    key = key * 10n + BigInt(byte - 48);
  }
  if (key > U64_MAX) return null;
  return key & ENGINE_KEY_MARKER ? key : null;
}

// Inlines engine-store image and font references before sending, because the client cannot
// resolve engine-store keys.
export function supplyEngineResources(
  batch: Uint8Array,
  image: (hash: bigint) => Uint8Array | null,
  font: (key: bigint) => Uint8Array | null,
): Uint8Array {
  if (batch.length < RBI_BATCH_HEAD) return batch;
  const dv = new DataView(batch.buffer, batch.byteOffset, batch.byteLength);
  const count = dv.getUint32(0, true);
  const out: Uint8Array[] = [batch.subarray(0, RBI_BATCH_HEAD)];
  let p = RBI_BATCH_HEAD;
  let rewrote = false;
  for (let n = 0; n < count && p + RBI_ENTRY_HEAD <= batch.length; n++) {
    const len = dv.getUint32(p + RBI_ENTRY_LENGTH_OFFSET, true);
    const payload = p + RBI_ENTRY_HEAD;
    const end = payload + len;
    if (end > batch.length) break;
    const kind = batch[p];
    let head: Uint8Array | null = null;
    let bytes: Uint8Array | null = null;
    if (
      kind === RBI_KIND_IMAGE &&
      len === IMAGE_REF_PAYLOAD &&
      batch[payload + IMAGE_REF_FORMAT_OFFSET] === IMAGE_FORMAT_ENGINE_REF
    ) {
      bytes = image(dv.getBigUint64(p + RBI_ENTRY_ID_OFFSET, true));
      if (bytes && bytes.length > 0) {
        head = batch.slice(p, payload + IMAGE_REF_PAYLOAD);
        new DataView(head.buffer).setUint32(
          RBI_ENTRY_LENGTH_OFFSET,
          IMAGE_REF_PAYLOAD + bytes.length,
          true,
        );
        head[RBI_ENTRY_HEAD + IMAGE_REF_FORMAT_OFFSET] = IMAGE_FORMAT_ENCODED;
      }
    } else if (
      kind === RBI_KIND_FONT_DATA &&
      len > FONT_ENTRY_HEAD &&
      batch[payload] === FONT_DATA_REF_ASSET
    ) {
      const key = engineFontKey(batch, payload + FONT_ENTRY_HEAD, end);
      bytes = key === null ? null : font(key);
      if (bytes && bytes.length > 0) {
        head = batch.slice(p, payload + FONT_ENTRY_HEAD);
        new DataView(head.buffer).setUint32(
          RBI_ENTRY_LENGTH_OFFSET,
          FONT_ENTRY_HEAD + bytes.length,
          true,
        );
        head[RBI_ENTRY_HEAD] = FONT_DATA_REF_BLOB;
      }
    }
    if (head && bytes) {
      out.push(head, bytes);
      rewrote = true;
    } else {
      out.push(batch.subarray(p, end));
    }
    p = end;
  }
  if (!rewrote) return batch;
  if (p < batch.length) out.push(batch.subarray(p));
  const merged = new Uint8Array(out.reduce((n, s) => n + s.length, 0));
  let o = 0;
  for (const s of out) {
    merged.set(s, o);
    o += s.length;
  }
  return merged;
}

function scanEntries(batch: Uint8Array) {
  const found: {
    start: number;
    end: number;
    key: string;
    kind: number;
    id: bigint;
    hasBytes: boolean;
  }[] = [];
  if (batch.length < RBI_BATCH_HEAD) return found;
  const dv = new DataView(batch.buffer, batch.byteOffset, batch.byteLength);
  const count = dv.getUint32(0, true);
  let p = RBI_BATCH_HEAD;
  for (let n = 0; n < count && p + RBI_ENTRY_HEAD <= batch.length; n++) {
    const len = dv.getUint32(p + RBI_ENTRY_LENGTH_OFFSET, true);
    const payload = p + RBI_ENTRY_HEAD;
    const end = payload + len;
    if (end > batch.length) break;
    const kind = dv.getUint8(p);
    const imageRef =
      kind === RBI_KIND_IMAGE &&
      len === IMAGE_REF_PAYLOAD &&
      batch[payload + IMAGE_REF_FORMAT_OFFSET] === IMAGE_FORMAT_ENGINE_REF;
    const fontRef =
      kind === RBI_KIND_FONT_DATA &&
      len > FONT_ENTRY_HEAD &&
      batch[payload] === FONT_DATA_REF_ASSET;
    const id = dv.getBigUint64(p + RBI_ENTRY_ID_OFFSET, true);
    found.push({
      start: p,
      end,
      key: `${kind}:${id}`,
      kind,
      id,
      hasBytes: !imageRef && !fontRef,
    });
    p = end;
  }
  return found;
}

function rebuild(batch: Uint8Array, keep: { start: number; end: number }[]): Uint8Array {
  const head = new Uint8Array(RBI_BATCH_HEAD);
  new DataView(head.buffer).setUint32(0, keep.length, true);
  const parts = [head, ...keep.map((e) => batch.subarray(e.start, e.end))];
  const merged = new Uint8Array(parts.reduce((n, s) => n + s.length, 0));
  let o = 0;
  for (const s of parts) {
    merged.set(s, o);
    o += s.length;
  }
  return merged;
}

export function dropAlreadySent(batch: Uint8Array, sent: DeliveredKeys): Uint8Array {
  const entries = scanEntries(batch);
  const keep = entries.filter((e) => !sent.has(e.key));
  if (keep.length === entries.length) return batch;
  return keep.length === 0 ? new Uint8Array(0) : rebuild(batch, keep);
}

export function noteDelivered(batch: Uint8Array, sent: DeliveredKeys): void {
  for (const e of scanEntries(batch)) {
    // Unresolved engine references stay retryable; only byte-backed entries count as delivered.
    if (e.hasBytes) sent.add(e.key, e.kind, e.id);
  }
}

// Per-stream delivery ledger, FIFO-bounded. It is separate from `getSceneResources` requests.
const DELIVERED_CAP = 4096;

export class DeliveredKeys {
  private readonly keys = new Map<string, { kind: number; id: bigint }>();
  private packed: { images: Uint8Array; fonts: Uint8Array } | null = null;
  private imageCount = 0;
  private fontCount = 0;

  has(key: string): boolean {
    return this.keys.has(key);
  }

  add(key: string, kind: number, id: bigint): void {
    if (this.keys.has(key)) return;
    this.keys.set(key, { kind, id });
    this.#count(kind, 1);
    if (this.keys.size > DELIVERED_CAP) {
      const oldest = this.keys.keys().next().value;
      if (oldest !== undefined) {
        const evicted = this.keys.get(oldest);
        this.keys.delete(oldest);
        if (evicted !== undefined) this.#count(evicted.kind, -1);
      }
    }
    this.packed = null;
  }

  #count(kind: number, by: number): void {
    if (kind === RBI_KIND_IMAGE) this.imageCount += by;
    else if (kind === RBI_KIND_FONT_DATA) this.fontCount += by;
  }

  get size(): number {
    return this.keys.size;
  }

  pack(): { images: Uint8Array; fonts: Uint8Array } {
    if (this.packed) return this.packed;
    const images = new Uint8Array(this.imageCount * 8);
    const fonts = new Uint8Array(this.fontCount * 8);
    const iv = new DataView(images.buffer);
    const fv = new DataView(fonts.buffer);
    let io = 0;
    let fo = 0;
    for (const e of this.keys.values()) {
      if (e.kind === RBI_KIND_IMAGE) {
        iv.setBigUint64(io, e.id, true);
        io += 8;
      } else if (e.kind === RBI_KIND_FONT_DATA) {
        fv.setBigUint64(fo, e.id, true);
        fo += 8;
      }
    }
    this.packed = { images, fonts };
    return this.packed;
  }
}
