// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Reads response streams under per-body and shared in-flight byte budgets.

export type CappedFailure = "cap" | "budget" | "error";

export type CappedRead =
  | { bytes: Uint8Array<ArrayBuffer>; rest: null; failure: null }
  | {
      bytes: null;
      rest: ReadableStream<Uint8Array>;
      failure: CappedFailure;
    };

export const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;

export const MAX_STYLESHEET_BYTES = 8 * 1024 * 1024;

export const MAX_CONCURRENT_READ_BYTES = 48 * 1024 * 1024;

let inFlightBytes = 0;
let peakInFlightBytes = 0;

export function inFlightReadBytes(): number {
  return inFlightBytes;
}

export function peakInFlightReadBytes(): number {
  return peakInFlightBytes;
}

export function resetPeakInFlightReadBytes(): void {
  peakInFlightBytes = inFlightBytes;
}

/**
 * Buffers a stream up to `cap`; partial reads return `rest` with consumed chunks replayed.
 * The caller must consume or cancel `rest` to finish owning the source stream.
 */
export async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  cap: number,
  onCharge?: (delta: number) => boolean,
): Promise<CappedRead> {
  if (!body) return { bytes: new Uint8Array(0), rest: null, failure: null };
  const reader = body.getReader();
  const state = { chunks: [] as Uint8Array[], total: 0 };
  const failure = await fillCappedChunks(reader, state, cap, onCharge);
  if (failure) return failure;
  return concatenateChunks(state.chunks, state.total);
}

interface ChunkState {
  chunks: Uint8Array[];
  total: number;
}

type CappedChunkRead = { done: true } | { done: false; failure: CappedRead | null };

function recordChunk(
  value: Uint8Array,
  state: ChunkState,
  cap: number,
  onCharge: ((delta: number) => boolean) | undefined,
  reader: ReadableStreamDefaultReader<Uint8Array>,
): CappedRead | null {
  state.chunks.push(value);
  state.total += value.byteLength;
  if (onCharge && !onCharge(value.byteLength)) {
    return { bytes: null, rest: replayFrom(state.chunks, reader), failure: "budget" };
  }
  if (state.total > cap) {
    return { bytes: null, rest: replayFrom(state.chunks, reader), failure: "cap" };
  }
  return null;
}

async function fillCappedChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: ChunkState,
  cap: number,
  onCharge: ((delta: number) => boolean) | undefined,
): Promise<CappedRead | null> {
  try {
    for (;;) {
      const next = await readCappedChunk(reader, state, cap, onCharge);
      if (next.done) break;
      if (next.failure !== null) return next.failure;
    }
  } catch {
    return { bytes: null, rest: replayFrom(state.chunks, reader), failure: "error" };
  }
  return null;
}

async function readCappedChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: ChunkState,
  cap: number,
  onCharge: ((delta: number) => boolean) | undefined,
): Promise<CappedChunkRead> {
  const { done, value } = await reader.read();
  if (done) return { done: true };
  if (!value) return { done: false, failure: null };
  return { done: false, failure: recordChunk(value, state, cap, onCharge, reader) };
}

function concatenateChunks(chunks: Uint8Array[], total: number): CappedRead {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return { bytes: out, rest: null, failure: null };
}

function replayFrom(
  head: Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of head) c.enqueue(chunk);
    },
    async pull(c) {
      try {
        const { done, value } = await reader.read();
        if (done) c.close();
        else if (value) c.enqueue(value);
      } catch (e) {
        c.error(e);
      }
    },
    cancel(reason) {
      // Cancelling an errored reader can reject; keep that cleanup rejection handled.
      void reader.cancel(reason).catch(() => {});
    },
  });
}

export function declaredOverCap(headers: Headers, cap: number): boolean {
  const raw = headers.get("content-length");
  if (!raw) return false;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > cap;
}

export type CappedBody =
  | { ok: true; bytes: Uint8Array<ArrayBuffer> }
  | { ok: false; failure: CappedFailure };

/** Reads a response under `cap` and the shared byte budget; it cancels the body on failure. */
export async function readCappedBytes(resp: Response, cap: number): Promise<CappedBody> {
  if (inFlightBytes >= MAX_CONCURRENT_READ_BYTES) {
    await cancelBody(resp);
    return { ok: false, failure: "budget" };
  }
  if (declaredOverCap(resp.headers, cap)) {
    await cancelBody(resp);
    return { ok: false, failure: "cap" };
  }
  let charged = 0;
  try {
    // Charge each chunk; concurrent readers can all pass the early budget check.
    const got = await readCapped(resp.body, cap, (delta) => {
      charged += delta;
      inFlightBytes += delta;
      if (inFlightBytes > peakInFlightBytes) peakInFlightBytes = inFlightBytes;
      return inFlightBytes <= MAX_CONCURRENT_READ_BYTES;
    });
    if (got.bytes === null) {
      await got.rest.cancel().catch(() => {});
      return { ok: false, failure: got.failure };
    }
    return { ok: true, bytes: got.bytes };
  } finally {
    inFlightBytes -= charged;
  }
}

export async function readCappedText(
  resp: Response,
  cap: number,
): Promise<{ ok: true; text: string } | { ok: false; failure: CappedFailure }> {
  const got = await readCappedBytes(resp, cap);
  if (!got.ok) return got;
  return { ok: true, text: new TextDecoder().decode(got.bytes) };
}

export function cappedErrorText(failure: CappedFailure): string {
  switch (failure) {
    case "cap":
      return "net::ERR_FILE_TOO_BIG";
    case "budget":
      return "net::ERR_INSUFFICIENT_RESOURCES";
    case "error":
      return "net::ERR_CONNECTION_CLOSED";
  }
}

async function cancelBody(resp: Response): Promise<void> {
  try {
    await resp.body?.cancel();
  } catch {}
}

/** Wraps a body stream with an `ms` deadline; expiry errors the wrapper and cancels its source. */
export function withDeadline(
  body: ReadableStream<Uint8Array>,
  ms: number,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setTimeout(() => {
        expired = true;
        controller.error(new Error(`kitesurf: body deadline after ${ms}ms`));
        void reader.cancel("deadline").catch(() => {});
      }, ms);
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (expired) return;
        if (done) {
          clearTimeout(timer);
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        clearTimeout(timer);
        if (!expired) controller.error(err);
      }
    },
    cancel(reason) {
      clearTimeout(timer);
      return reader.cancel(reason);
    },
  });
}
