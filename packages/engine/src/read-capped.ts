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

/** One connection's share of the shared budget. Half leaves room for another connection's
 *  document and stylesheet reads; it still fits one document plus one stylesheet. */
export const MAX_CONNECTION_READ_BYTES = MAX_CONCURRENT_READ_BYTES / 2;

let inFlightBytes = 0;
let peakInFlightBytes = 0;
const inFlightByConnection = new Map<string, number>();

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
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.byteLength;
      if (onCharge && !onCharge(value.byteLength)) {
        return {
          bytes: null,
          rest: replayFrom(chunks, reader),
          failure: "budget",
        };
      }
      if (total > cap) {
        return { bytes: null, rest: replayFrom(chunks, reader), failure: "cap" };
      }
    }
  } catch {
    return { bytes: null, rest: replayFrom(chunks, reader), failure: "error" };
  }
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

/** Charges bytes read into memory to the shared and per-connection budgets until released. */
function readLease(connectionId: string, connectionCap = MAX_CONNECTION_READ_BYTES) {
  let charged = 0;
  let released = false;
  return {
    charge(delta: number): boolean {
      charged += delta;
      inFlightBytes += delta;
      if (inFlightBytes > peakInFlightBytes) peakInFlightBytes = inFlightBytes;
      const own = (inFlightByConnection.get(connectionId) ?? 0) + delta;
      inFlightByConnection.set(connectionId, own);
      return inFlightBytes <= MAX_CONCURRENT_READ_BYTES && own <= connectionCap;
    },
    release(): void {
      if (released) return;
      released = true;
      inFlightBytes -= charged;
      if (charged > 0) {
        const own = (inFlightByConnection.get(connectionId) ?? 0) - charged;
        if (own > 0) inFlightByConnection.set(connectionId, own);
        else inFlightByConnection.delete(connectionId);
      }
    },
  };
}

/** Reads a stream under `cap` and the shared budget, replaying already-read chunks on failure
 *  instead of cancelling. The charge ends with the read: a returned `rest` belongs to its
 *  consumer, which may never finish it, so it must not hold the shared budget. */
export async function readCappedBudgeted(
  body: ReadableStream<Uint8Array> | null,
  cap: number,
  connectionId: string,
): Promise<CappedRead> {
  if (!body) return { bytes: new Uint8Array(0), rest: null, failure: null };
  if (
    inFlightBytes >= MAX_CONCURRENT_READ_BYTES ||
    (inFlightByConnection.get(connectionId) ?? 0) >= MAX_CONNECTION_READ_BYTES
  ) {
    return { bytes: null, rest: body, failure: "budget" };
  }
  const lease = readLease(connectionId);
  try {
    return await readCapped(body, cap, (delta) => lease.charge(delta));
  } finally {
    lease.release();
  }
}

/** Reads a response under `cap`, the shared byte budget and `connectionId`'s share of it;
 *  it cancels the body on failure. */
export async function readCappedBytes(
  resp: Response,
  cap: number,
  connectionId: string,
  // A single large asset (a .wasm bake) may claim the whole shared budget.
  connectionCap: number = MAX_CONNECTION_READ_BYTES,
): Promise<CappedBody> {
  if (
    inFlightBytes >= MAX_CONCURRENT_READ_BYTES ||
    (inFlightByConnection.get(connectionId) ?? 0) >= connectionCap
  ) {
    await cancelBody(resp);
    return { ok: false, failure: "budget" };
  }
  if (declaredOverCap(resp.headers, cap)) {
    await cancelBody(resp);
    return { ok: false, failure: "cap" };
  }
  const lease = readLease(connectionId, connectionCap);
  try {
    // Charge each chunk; concurrent readers can all pass the early budget check.
    const got = await readCapped(resp.body, cap, (delta) => lease.charge(delta));
    if (got.bytes === null) {
      await got.rest.cancel().catch(() => {});
      return { ok: false, failure: got.failure };
    }
    return { ok: true, bytes: got.bytes };
  } finally {
    lease.release();
  }
}

export async function readCappedText(
  resp: Response,
  cap: number,
  connectionId: string,
): Promise<{ ok: true; text: string } | { ok: false; failure: CappedFailure }> {
  const got = await readCappedBytes(resp, cap, connectionId);
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
