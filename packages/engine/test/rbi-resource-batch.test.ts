// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import { ENGINE_KEY_MARKER } from "../src/eval/resource-store.ts";
import {
  dropAlreadySent,
  engineOwnedBytes,
  noteDelivered,
  DeliveredKeys,
  supplyEngineResources,
  typedArrayLength,
} from "../src/rbi-protocol.ts";

const KIND_IMAGE = 2;
const KIND_FONT_DATA = 3;
const FORMAT_ENCODED = 2;
const FORMAT_ENGINE_REF = 3;
const REF_BLOB = 0;
const REF_ASSET = 1;
const ENGINE_KEY = ENGINE_KEY_MARKER;

const noImage = () => null;
const noFont = () => null;

function imageRef(hash: bigint, w = 6, h = 4, hintW = w, hintH = h): Uint8Array {
  const e = new Uint8Array(13 + 17);
  const dv = new DataView(e.buffer);
  e[0] = KIND_IMAGE;
  dv.setBigUint64(1, hash, true);
  dv.setUint32(9, 17, true);
  dv.setUint32(13, w, true);
  dv.setUint32(17, h, true);
  e[21] = FORMAT_ENGINE_REF;
  dv.setUint32(22, hintW, true);
  dv.setUint32(26, hintH, true);
  return e;
}

function fontData(hash: bigint, name: string, refType = REF_ASSET, faceIndex = 0): Uint8Array {
  const body = new TextEncoder().encode(name);
  const e = new Uint8Array(13 + 5 + body.length);
  const dv = new DataView(e.buffer);
  e[0] = KIND_FONT_DATA;
  dv.setBigUint64(1, hash, true);
  dv.setUint32(9, 5 + body.length, true);
  e[13] = refType;
  dv.setUint32(14, faceIndex, true);
  e.set(body, 18);
  return e;
}

function batchOf(...entries: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(4 + entries.reduce((n, e) => n + e.length, 0));
  new DataView(out.buffer).setUint32(0, entries.length, true);
  let o = 4;
  for (const e of entries) {
    out.set(e, o);
    o += e.length;
  }
  return out;
}

function at<T>(list: T[], i: number): T {
  const v = list[i];
  if (v === undefined) throw new Error(`no entry at ${i}`);
  return v;
}

function entries(batch: Uint8Array) {
  const dv = new DataView(batch.buffer, batch.byteOffset, batch.byteLength);
  const count = dv.getUint32(0, true);
  const out: Array<{
    kind: number;
    hash: bigint;
    format: number;
    dims: number[];
    body: Uint8Array;
    refType: number;
    faceIndex: number;
    fontBody: Uint8Array;
  }> = [];
  let p = 4;
  for (let n = 0; n < count; n++) {
    const len = dv.getUint32(p + 9, true);
    const kind = dv.getUint8(p);
    const image = kind === KIND_IMAGE && len >= 17;
    out.push({
      kind,
      hash: dv.getBigUint64(p + 1, true),
      format: image ? dv.getUint8(p + 13 + 8) : -1,
      dims: image ? [0, 4, 9, 13].map((o) => dv.getUint32(p + 13 + o, true)) : [],
      body: image ? batch.subarray(p + 13 + 17, p + 13 + len) : new Uint8Array(0),
      refType: dv.getUint8(p + 13),
      faceIndex: dv.getUint32(p + 13 + 1, true),
      fontBody: batch.subarray(p + 13 + 5, p + 13 + len),
    });
    p += 13 + len;
  }
  expect(p).toBe(batch.length);
  return out;
}

describe("supplyEngineResources: images", () => {
  it("substitutes a ref with the engine's bytes, keeping dims and hint", () => {
    const key = 0x8000000000001234n;
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
    const batch = batchOf(fontData(11n, "/fonts/Inter-Regular.ttf"), imageRef(key, 6, 4, 3, 2));

    const got = entries(supplyEngineResources(batch, (h) => (h === key ? payload : null), noFont));

    expect(got).toHaveLength(2);
    expect(at(got, 0).kind).toBe(KIND_FONT_DATA);
    expect(at(got, 1).kind).toBe(KIND_IMAGE);
    expect(at(got, 1).hash).toBe(key);
    expect(at(got, 1).format).toBe(FORMAT_ENCODED);
    expect(at(got, 1).body).toEqual(payload);
    expect(at(got, 1).dims).toEqual([6, 4, 3, 2]);
  });

  it("substitutes every ref in a batch", () => {
    const a = 0x8000000000000001n;
    const b = 0x8000000000000002n;
    const batch = batchOf(imageRef(a), fontData(9n, "/fonts/x.ttf"), imageRef(b));
    const bytes = new Uint8Array([9, 9]);

    const got = entries(supplyEngineResources(batch, () => bytes, noFont));

    expect(got.map((e) => e.kind)).toEqual([KIND_IMAGE, KIND_FONT_DATA, KIND_IMAGE]);
    expect(at(got, 0).format).toBe(FORMAT_ENCODED);
    expect(at(got, 2).format).toBe(FORMAT_ENCODED);
    expect(at(got, 0).body).toEqual(bytes);
    expect(at(got, 2).body).toEqual(bytes);
  });

  it("leaves a ref the store cannot answer alone, for the client to retire", () => {
    const batch = batchOf(imageRef(0x8000000000009999n));
    expect(supplyEngineResources(batch, noImage, noFont)).toEqual(batch);
    expect(supplyEngineResources(batch, () => new Uint8Array(0), noFont)).toEqual(batch);
  });

  it("leaves entries that are not engine refs untouched", () => {
    const inline = imageRef(0x8000000000000003n);
    inline[21] = FORMAT_ENCODED;
    const batch = batchOf(inline, fontData(4n, "/fonts/y.ttf"));
    expect(supplyEngineResources(batch, () => new Uint8Array([7]), noFont)).toEqual(batch);
  });

  it("rejects a truncated batch instead of reading past it", () => {
    const batch = batchOf(imageRef(0x8000000000000005n)).subarray(0, 20);
    expect(supplyEngineResources(batch, () => new Uint8Array([7]), noFont)).toHaveLength(0);
    expect(supplyEngineResources(new Uint8Array(2), noImage, noFont)).toHaveLength(0);
  });
});

describe("supplyEngineResources: fonts", () => {
  it("turns a key-shaped asset-ref into a blob, keeping the face index", () => {
    const key = ENGINE_KEY | 0x4321n;
    const bytes = new Uint8Array([0x4f, 0x54, 0x54, 0x4f, 1, 2]);
    const batch = batchOf(imageRef(1n), fontData(77n, key.toString(), REF_ASSET, 3));

    const got = entries(supplyEngineResources(batch, noImage, (k) => (k === key ? bytes : null)));

    expect(got).toHaveLength(2);
    expect(at(got, 1).kind).toBe(KIND_FONT_DATA);
    expect(at(got, 1).hash).toBe(77n);
    expect(at(got, 1).refType).toBe(REF_BLOB);
    expect(at(got, 1).faceIndex).toBe(3);
    expect(at(got, 1).fontBody).toEqual(bytes);
  });

  it("leaves a UA asset path alone, which the client fetches itself", () => {
    const batch = batchOf(fontData(5n, "/fonts/NotoSans.ttf"));
    expect(supplyEngineResources(batch, noImage, () => new Uint8Array([1]))).toEqual(batch);
  });

  it("leaves a url-shaped ref alone", () => {
    const batch = batchOf(fontData(6n, "https://fonts.gstatic.com/s/a.woff2"));
    expect(supplyEngineResources(batch, noImage, () => new Uint8Array([1]))).toEqual(batch);
  });

  it("leaves a decimal name without the engine marker alone", () => {
    const batch = batchOf(fontData(7n, "1234"));
    expect(supplyEngineResources(batch, noImage, () => new Uint8Array([1]))).toEqual(batch);
  });

  it("leaves a 20-digit name that overshoots u64 alone", () => {
    const tooBig = (1n << 64n) | ENGINE_KEY;
    expect(tooBig.toString().length).toBe(20);
    expect(tooBig & ENGINE_KEY).toBeTruthy();
    const batch = batchOf(fontData(11n, tooBig.toString()));
    expect(supplyEngineResources(batch, noImage, () => new Uint8Array([1]))).toEqual(batch);
  });

  it("leaves a blob entry alone", () => {
    const batch = batchOf(fontData(8n, "already-bytes", REF_BLOB));
    expect(supplyEngineResources(batch, noImage, () => new Uint8Array([1]))).toEqual(batch);
  });

  it("leaves a key the store cannot answer, and an empty answer", () => {
    const batch = batchOf(fontData(9n, (ENGINE_KEY | 7n).toString()));
    expect(supplyEngineResources(batch, noImage, noFont)).toEqual(batch);
    expect(supplyEngineResources(batch, noImage, () => new Uint8Array(0))).toEqual(batch);
  });

  it("substitutes an image ref and a font ref in the same batch", () => {
    const img = 0x8000000000000011n;
    const key = ENGINE_KEY | 0x22n;
    const batch = batchOf(fontData(1n, key.toString(), REF_ASSET, 1), imageRef(img));
    const fontBytes = new Uint8Array([1, 1, 1]);
    const imgBytes = new Uint8Array([2, 2]);

    const got = entries(
      supplyEngineResources(
        batch,
        (h) => (h === img ? imgBytes : null),
        (k) => (k === key ? fontBytes : null),
      ),
    );

    expect(at(got, 0).refType).toBe(REF_BLOB);
    expect(at(got, 0).fontBody).toEqual(fontBytes);
    expect(at(got, 1).format).toBe(FORMAT_ENCODED);
    expect(at(got, 1).body).toEqual(imgBytes);
  });
});

describe("inline resource dedupe", () => {
  const someBytes = () => new Uint8Array([1, 2, 3, 4]);

  function deliver(batch: Uint8Array, sent: DeliveredKeys): Uint8Array {
    const fresh = dropAlreadySent(batch, sent);
    if (fresh.length === 0) return fresh;
    const supplied = supplyEngineResources(fresh, someBytes, someBytes);
    noteDelivered(supplied, sent);
    return supplied;
  }

  it("ships a resource once and drops the whole repeat batch", () => {
    const sent = new DeliveredKeys();
    const scene = () => batchOf(imageRef(7n | ENGINE_KEY));
    expect(deliver(scene(), sent).length).toBeGreaterThan(0);
    expect(deliver(scene(), sent).length).toBe(0);
  });

  it("keeps only the entry the client has not seen, and rewrites the count", () => {
    const sent = new DeliveredKeys();
    const seen = imageRef(1n | ENGINE_KEY);
    const fresh = imageRef(2n | ENGINE_KEY);
    deliver(batchOf(seen), sent);
    const got = entries(deliver(batchOf(seen, fresh), sent));
    expect(got.length).toBe(1);
    expect(at(got, 0).hash).toBe(2n | ENGINE_KEY);
  });

  it("re-pushes an image ref the engine store could not fill", () => {
    const sent = new DeliveredKeys();
    const scene = () => batchOf(imageRef(9n | ENGINE_KEY));
    const supplied = supplyEngineResources(dropAlreadySent(scene(), sent), noImage, noFont);
    noteDelivered(supplied, sent);
    expect(sent.size).toBe(0);
    expect(entries(dropAlreadySent(scene(), sent)).length).toBe(1);
  });

  it("re-pushes a font asset-ref the engine store could not fill", () => {
    const sent = new DeliveredKeys();
    const scene = () => batchOf(fontData(4n, `${8n | ENGINE_KEY}`));
    const supplied = supplyEngineResources(dropAlreadySent(scene(), sent), noImage, noFont);
    noteDelivered(supplied, sent);
    expect(sent.size).toBe(0);
    expect(entries(dropAlreadySent(scene(), sent)).length).toBe(1);
  });

  it("records a font that already carried its blob", () => {
    const sent = new DeliveredKeys();
    const scene = () => batchOf(fontData(5n, "abcd", REF_BLOB));
    deliver(scene(), sent);
    expect(deliver(scene(), sent).length).toBe(0);
  });

  it("packs delivered keys per kind, little-endian", () => {
    const sent = new DeliveredKeys();
    deliver(batchOf(imageRef(7n | ENGINE_KEY), fontData(5n, "abcd", REF_BLOB)), sent);
    const { images, fonts } = sent.pack();
    const read = (b: Uint8Array) =>
      [...Array(b.length / 8).keys()].map((i) =>
        new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(i * 8, true),
      );
    expect(read(images)).toEqual([7n | ENGINE_KEY]);
    expect(read(fonts)).toEqual([5n]);
  });

  it("packs nothing while nothing has been delivered", () => {
    const { images, fonts } = new DeliveredKeys().pack();
    expect(images.length).toBe(0);
    expect(fonts.length).toBe(0);
  });

  it("reuses the packed lists until a key changes", () => {
    const sent = new DeliveredKeys();
    deliver(batchOf(imageRef(7n | ENGINE_KEY)), sent);
    const first = sent.pack();
    expect(sent.pack()).toBe(first);
    deliver(batchOf(imageRef(8n | ENGINE_KEY)), sent);
    expect(sent.pack()).not.toBe(first);
    expect(sent.pack().images.length).toBe(16);
  });

  it("caps the delivered set, dropping the oldest key first", () => {
    const sent = new DeliveredKeys();
    for (let i = 0; i < 4100; i++) deliver(batchOf(imageRef(BigInt(i) | ENGINE_KEY)), sent);
    expect(sent.size).toBe(4096);
    expect(entries(dropAlreadySent(batchOf(imageRef(0n | ENGINE_KEY)), sent)).length).toBe(1);
    expect(dropAlreadySent(batchOf(imageRef(4099n | ENGINE_KEY)), sent).length).toBe(0);
  });

  it("keeps the packed lists in step with an eviction", () => {
    const sent = new DeliveredKeys();
    deliver(batchOf(fontData(5n, "abcd", REF_BLOB)), sent);
    for (let i = 0; i < 4096; i++) deliver(batchOf(imageRef(BigInt(i) | ENGINE_KEY)), sent);
    const { images, fonts } = sent.pack();
    expect(fonts.length).toBe(0);
    expect(images.length / 8).toBe(4096);
    expect(images.length / 8 + fonts.length / 8).toBe(sent.size);
  });
});

describe("untrusted resource batches", () => {
  it("bounds the expanded batch and leaves a refused expansion as its original ref", () => {
    const key = 0x8000000000007777n;
    const body = new Uint8Array(8 * 1024 * 1024);
    const batch = batchOf(...Array.from({ length: 6 }, () => imageRef(key)));

    const got = supplyEngineResources(batch, () => body, noFont);

    expect(got.length).toBeLessThanOrEqual(48 * 1024 * 1024);
    const parsed = entries(got);
    expect(parsed).toHaveLength(6);
    expect(parsed.slice(0, 5).map((e) => e.format)).toEqual(Array(5).fill(FORMAT_ENCODED));
    expect(at(parsed, 5).format).toBe(FORMAT_ENGINE_REF);
  });

  it("rejects a forged view without calling its methods", () => {
    let calls = 0;
    // An RPC reply is not type-checked; this is the forged value the decoder must reject.
    const forged = {
      length: 64,
      byteOffset: 0,
      byteLength: 64,
      buffer: new ArrayBuffer(64),
      subarray: () => {
        calls++;
        return new Uint8Array(0);
      },
      slice: () => {
        calls++;
        return new Uint8Array(0);
      },
    };
    // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- forged RPC batch.
    const value = forged as unknown as Uint8Array;

    const got = supplyEngineResources(value, () => new Uint8Array([1]), noFont);

    expect(got).toHaveLength(0);
    expect(calls).toBe(0);
  });

  it("refuses a detached view instead of throwing while copying it", () => {
    const detached = new Uint8Array([1, 2, 3, 4]);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    expect(typedArrayLength(detached)).toBe(0);

    expect(engineOwnedBytes(detached, 1024)).toBeNull();
    expect(supplyEngineResources(detached, noImage, noFont)).toHaveLength(0);
  });
});
