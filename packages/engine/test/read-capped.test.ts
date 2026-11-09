// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, it, expect } from "vitest";

import {
  MAX_CONCURRENT_READ_BYTES,
  MAX_CONNECTION_READ_BYTES,
  MAX_DOCUMENT_BYTES,
  cappedErrorText,
  declaredOverCap,
  inFlightReadBytes,
  peakInFlightReadBytes,
  readCapped,
  resetPeakInFlightReadBytes,
  readCappedBytes,
  readCappedText,
  withDeadline,
} from "../src/read-capped.ts";

function chunked(chunks: number, size: number): Response {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent++ >= chunks) return void c.close();
      c.enqueue(new Uint8Array(size));
    },
  });
  return new Response(stream);
}

function endless(size: number): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(size));
      },
    }),
  );
}

describe("declaredOverCap", () => {
  it("rejects an announced over-cap body", () => {
    const h = new Headers({ "content-length": "1025" });
    expect(declaredOverCap(h, 1024)).toBe(true);
  });

  it("passes an announced under-cap body", () => {
    expect(declaredOverCap(new Headers({ "content-length": "1024" }), 1024)).toBe(false);
  });

  it("treats an absent or malformed header as unknown", () => {
    expect(declaredOverCap(new Headers(), 1024)).toBe(false);
    expect(declaredOverCap(new Headers({ "content-length": "abc" }), 1024)).toBe(false);
  });
});

describe("readCappedBytes", () => {
  it("returns the whole body when it fits", async () => {
    const got = await readCappedBytes(chunked(4, 256), 1024, "conn");
    expect(got.ok && got.bytes.byteLength).toBe(1024);
  });

  it("rejects on Content-Length without draining the body", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls++;
        c.enqueue(new Uint8Array(16));
      },
    });
    const resp = new Response(body, {
      headers: { "content-length": "999999" },
    });
    expect(await readCappedBytes(resp, 1024, "conn")).toStrictEqual({
      ok: false,
      failure: "cap",
    });
    expect(pulls).toBeLessThanOrEqual(1);
  });

  it("rejects mid-stream when Content-Length is absent", async () => {
    const got = await readCappedBytes(chunked(10, 256), 1024, "conn");
    expect(got).toStrictEqual({ ok: false, failure: "cap" });
  });

  it("rejects mid-stream when Content-Length lies", async () => {
    const resp = new Response(chunked(10, 256).body, {
      headers: { "content-length": "10" },
    });
    expect(await readCappedBytes(resp, 1024, "conn")).toStrictEqual({
      ok: false,
      failure: "cap",
    });
  });

  it("aborts an endless body instead of hanging", async () => {
    const got = await readCappedBytes(endless(4096), 64 * 1024, "conn");
    expect(got).toStrictEqual({ ok: false, failure: "cap" });
  });

  it("decodes text through the same cap", async () => {
    const ok = await readCappedText(new Response("hello"), 1024, "conn");
    expect(ok).toStrictEqual({ ok: true, text: "hello" });
    const over = await readCappedText(chunked(10, 256), 1024, "conn");
    expect(over).toStrictEqual({ ok: false, failure: "cap" });
  });

  it("distinguishes a mid-stream failure from an over-cap body", async () => {
    const broken = new Response(
      new ReadableStream<Uint8Array>({
        pull(c) {
          c.enqueue(new Uint8Array(16));
          c.error(new Error("connection reset"));
        },
      }),
    );
    const got = await readCappedBytes(broken, 64 * 1024, "conn");
    expect(got).toStrictEqual({ ok: false, failure: "error" });
    expect(cappedErrorText("error")).toBe("net::ERR_CONNECTION_CLOSED");
    expect(cappedErrorText("cap")).toBe("net::ERR_FILE_TOO_BIG");
    expect(cappedErrorText("budget")).toBe("net::ERR_INSUFFICIENT_RESOURCES");
    expect(inFlightReadBytes()).toBe(0);
  });
});

describe("shared concurrency budget", () => {
  it("releases its charge on both the fit and the over-cap path", async () => {
    expect(inFlightReadBytes()).toBe(0);
    await readCappedBytes(chunked(2, 256), 1024, "conn");
    expect(inFlightReadBytes()).toBe(0);
    await readCappedBytes(chunked(10, 256), 1024, "conn");
    expect(inFlightReadBytes()).toBe(0);
  });

  // A read that buffers `bytes` and then waits for `release` before it ends.
  function parkedRead(bytes: number, connectionId: string) {
    const gate: { release: (() => void) | null } = { release: null };
    const resp = new Response(
      new ReadableStream<Uint8Array>({
        async pull(c) {
          c.enqueue(new Uint8Array(bytes));
          await new Promise<void>((r) => (gate.release = r));
          c.close();
        },
      }),
    );
    const done = readCappedBytes(resp, bytes, connectionId);
    return { done, release: () => gate.release?.() };
  }

  const refused = { ok: false, failure: "budget" };

  it("refuses a read once concurrent buffering is at the ceiling", async () => {
    const a = parkedRead(MAX_CONNECTION_READ_BYTES, "a");
    const b = parkedRead(MAX_CONNECTION_READ_BYTES, "b");
    await new Promise((r) => setTimeout(r, 0));
    expect(inFlightReadBytes()).toBe(MAX_CONCURRENT_READ_BYTES);
    expect(await readCappedBytes(chunked(1, 16), 1024, "c")).toStrictEqual(refused);
    a.release();
    b.release();
    expect((await a.done).ok && (await b.done).ok).toBe(true);
    expect(inFlightReadBytes()).toBe(0);
  });

  it("holds one connection to its share, leaving the rest to others", async () => {
    const a = parkedRead(MAX_CONNECTION_READ_BYTES, "a");
    await new Promise((r) => setTimeout(r, 0));
    expect(await readCappedBytes(chunked(1, 16), 1024, "a")).toStrictEqual(refused);
    const other = await readCappedBytes(chunked(16, 1024 * 1024), MAX_DOCUMENT_BYTES, "b");
    expect(other.ok).toBe(true);
    // A single read past the share is stopped mid-stream.
    const over = await readCappedBytes(
      chunked(MAX_CONNECTION_READ_BYTES / (1024 * 1024) + 1, 1024 * 1024),
      MAX_CONCURRENT_READ_BYTES,
      "c",
    );
    expect(over).toStrictEqual(refused);
    a.release();
    await a.done;
    expect(inFlightReadBytes()).toBe(0);
  });

  it("stops readers already admitted when the ceiling is crossed", async () => {
    const CHUNK = 1024 * 1024;
    const chunksEach = Math.ceil(MAX_CONCURRENT_READ_BYTES / CHUNK);
    resetPeakInFlightReadBytes();
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        readCappedBytes(chunked(chunksEach, CHUNK), MAX_CONCURRENT_READ_BYTES, `conn-${i}`),
      ),
    );
    expect(peakInFlightReadBytes()).toBeLessThanOrEqual(MAX_CONCURRENT_READ_BYTES + 4 * CHUNK);
    expect(results.some((r) => !r.ok && r.failure === "budget")).toBe(true);
    expect(inFlightReadBytes()).toBe(0);
  }, 30_000);
});

describe("readCapped", () => {
  it("replays the head it already buffered", async () => {
    const got = await readCapped(chunked(4, 256).body, 512);
    expect(got.bytes).toBeNull();
    const rest = await new Response(got.rest).arrayBuffer();
    expect(rest.byteLength).toBe(1024);
  });
});

describe("withDeadline", () => {
  const stalled = (head: Uint8Array) => {
    let cancelled = false;
    const s = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(head);
      },
      cancel() {
        cancelled = true;
      },
    });
    return { s, wasCancelled: () => cancelled };
  };

  it("errors a body that is still open at the deadline and cancels its source", async () => {
    const { s, wasCancelled } = stalled(new Uint8Array([1, 2, 3]));
    const r = await readCapped(withDeadline(s, 50), 1024);
    expect(r.bytes).toBeNull();
    expect(r.failure).toBe("error");
    expect(wasCancelled()).toBe(true);
  });

  it("passes a body that finishes in time through untouched", async () => {
    const s = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([7, 8]));
        c.close();
      },
    });
    const r = await readCapped(withDeadline(s, 1000), 1024);
    expect(Array.from(r.bytes!)).toEqual([7, 8]);
  });
});
