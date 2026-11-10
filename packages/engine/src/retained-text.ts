// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Keeps rarely read engine text (document source, script sources, response bodies) compressed.

import {
  brotliCompressSync,
  brotliDecompressSync,
  constants,
  createBrotliCompress,
  createGzip,
  gunzipSync,
  gzipSync,
} from "node:zlib";

type PackedKind = "gzip" | "brotli";

export type RetainedTextCodec =
  | { kind: "none" }
  | { kind: PackedKind; level: number; stream: boolean };

const DEFAULT_LEVEL: Record<PackedKind, number> = { gzip: 6, brotli: 4 };
const LEVEL_RANGE: Record<PackedKind, [number, number]> = { gzip: [1, 9], brotli: [0, 11] };
// Below this the zlib call and the Uint8Array header cost more than the text they save.
const MIN_PACKED_CHARS = 4 * 1024;
// UTF-16 units encoded per streamed chunk: at most 96 KiB of UTF-8 in flight.
const STREAM_CHUNK_UNITS = 32 * 1024;
// UTF-8 input packed between yields: about 2 ms at brotli 4. Counted in bytes, not time, because
// deployed Workers stop performance.now() during CPU work, so a time budget would never end.
const STREAM_SLICE_BYTES = 512 * 1024;

// Background brotli 4: the best size per CPU millisecond measured, and it never blocks I/O.
const DEFAULT_CODEC: RetainedTextCodec = { kind: "brotli", level: 4, stream: true };

let codec: RetainedTextCodec = DEFAULT_CODEC;

/**
 * Parses `none`, `gzip[:1-9]`, `brotli[:0-11]`, each optionally `-stream` (background, sliced).
 * Empty input is the default, `brotli-stream:4`; anything else unrecognised is `none`.
 */
export function parseRetainedTextCodec(raw: string | undefined): RetainedTextCodec {
  const trimmed = (raw ?? "").trim().toLowerCase();
  if (trimmed === "") return DEFAULT_CODEC;
  const [name = "", levelText] = trimmed.split(":", 2);
  const stream = name.endsWith("-stream");
  const kind = stream ? name.slice(0, -"-stream".length) : name;
  if (kind !== "gzip" && kind !== "brotli") return { kind: "none" };
  const level = levelText === undefined ? Number.NaN : Number.parseInt(levelText, 10);
  const [min, max] = LEVEL_RANGE[kind];
  const ok = Number.isInteger(level) && level >= min && level <= max;
  return { kind, level: ok ? level : DEFAULT_LEVEL[kind], stream };
}

export function setRetainedTextCodec(next: RetainedTextCodec): void {
  codec = next;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Data = { kind: "none"; text: string } | { kind: PackedKind; packed: Uint8Array[] };

/** Text kept compressed when a codec is set; `text()` inflates a fresh copy on every read. */
export class RetainedText {
  readonly length: number;
  /** Settles once a streamed pack has replaced the string, or failed and kept it. */
  readonly settled: Promise<void>;
  #data: Data;

  /** Pass `compressible: false` for text that is already compressed data, such as base64. */
  constructor(text: string, compressible = true) {
    this.length = text.length;
    const active = codec;
    if (!compressible || active.kind === "none" || text.length < MIN_PACKED_CHARS) {
      this.#data = { kind: "none", text };
      this.settled = Promise.resolve();
    } else if (!active.stream) {
      this.#data = { kind: active.kind, packed: [packSync(text, active.kind, active.level)] };
      this.settled = Promise.resolve();
    } else {
      this.#data = { kind: "none", text };
      this.settled = packStream(text, active.kind, active.level).then(
        (packed) => {
          this.#data = { kind: active.kind, packed };
        },
        (err: unknown) => {
          console.warn(`[kitesurf-retained-text] streamed ${active.kind} pack failed:`, err);
        },
      );
    }
  }

  /** Bytes this value keeps alive, counting a plain string at two bytes per unit. */
  get retainedBytes(): number {
    const data = this.#data;
    if (data.kind === "none") return this.length * 2;
    return data.packed.reduce((n, chunk) => n + chunk.byteLength, 0);
  }

  text(): string {
    const data = this.#data;
    if (data.kind === "none") return data.text;
    const packed = joinChunks(data.packed);
    const bytes = data.kind === "brotli" ? brotliDecompressSync(packed) : gunzipSync(packed);
    return decoder.decode(bytes);
  }
}

function brotliParams(level: number, sizeHint: number): Record<number, number> {
  return {
    [constants.BROTLI_PARAM_QUALITY]: level,
    [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
    [constants.BROTLI_PARAM_SIZE_HINT]: sizeHint,
  };
}

function packSync(text: string, kind: PackedKind, level: number): Uint8Array {
  const utf8 = encoder.encode(text);
  if (kind === "gzip") return gzipSync(utf8, { level });
  return brotliCompressSync(utf8, { params: brotliParams(level, utf8.byteLength) });
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// workerd's zlib stream processes each write before returning and never yields on its own, so
// this yields every STREAM_SLICE_BYTES to let CDP, RPC and fetch callbacks run between slices.
// It starts after the current task and never holds the whole text as UTF-8.
async function packStream(text: string, kind: PackedKind, level: number): Promise<Uint8Array[]> {
  await yieldToEventLoop();
  const z =
    kind === "gzip"
      ? createGzip({ level })
      : createBrotliCompress({ params: brotliParams(level, text.length) });
  const out: Uint8Array[] = [];
  z.on("data", (chunk: Uint8Array) => out.push(chunk));
  const finished = new Promise<void>((resolve, reject) => {
    z.once("end", resolve);
    z.once("error", reject);
  });
  let sinceYield = 0;
  for (let at = 0; at < text.length;) {
    let end = Math.min(text.length, at + STREAM_CHUNK_UNITS);
    // Keep a surrogate pair in one chunk; split, each half would encode as U+FFFD.
    if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end--;
    const chunk = encoder.encode(text.slice(at, end));
    const flowing = z.write(chunk);
    at = end;
    if (!flowing) await new Promise<void>((resolve) => z.once("drain", resolve));
    sinceYield += chunk.byteLength;
    if (sinceYield >= STREAM_SLICE_BYTES) {
      sinceYield = 0;
      await yieldToEventLoop();
    }
  }
  z.end();
  await finished;
  return out;
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function joinChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1 && chunks[0]) return chunks[0];
  const out = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.byteLength, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}
