// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import {
  attachChunked,
  CARRIER_SPAN_BYTE_BUDGET,
  CARRIER_SPAN_LOG_CAP,
  type CarrierLog,
} from "../src/eval/carrier-spans.ts";
import type { Tracer } from "../src/tracing.ts";

interface CapturedSpan {
  name: string;
  tagWrites: Array<Record<string, unknown>>;
  logs: Array<{ key: string; value: string }>;
}

function fakeTracer(): { tracer: Tracer; spans: CapturedSpan[] } {
  const spans: CapturedSpan[] = [];
  const tracer = {
    enterSpan(name: string, cb: (s: unknown) => unknown) {
      const captured: CapturedSpan = { name, tagWrites: [], logs: [] };
      spans.push(captured);
      return cb({
        isRecording: true,
        setTags: (t: Record<string, unknown>) => captured.tagWrites.push(t),
        addLogs: (l: Record<string, string>) => {
          for (const [key, value] of Object.entries(l)) {
            captured.logs.push({ key, value });
          }
        },
        end: () => {},
      });
    },
  } as Tracer;
  return { tracer, spans };
}

function rec(value: string): CarrierLog {
  return { key: "otel.span", value };
}

describe("attachChunked", () => {
  it("small batch: one chunk, tags stamped before logs, finalTags on it", () => {
    const { tracer, spans } = fakeTracer();
    const result = attachChunked(
      tracer,
      "child.spans",
      { kind: "pagescript" },
      [rec("a"), rec("b")],
      { recordsDropped: 3 },
    );
    expect(result).toEqual({ attached: 2, oversized: 0, chunks: 1 });
    expect(spans).toHaveLength(1);
    expect(spans[0]!.tagWrites[0]).toEqual({ kind: "pagescript", records: 2 });
    expect(spans[0]!.logs.map((l) => l.value)).toEqual(["a", "b"]);
    expect(spans[0]!.tagWrites[1]).toEqual({ recordsDropped: 3 });
  });

  it("splits at the byte budget, keeps every span under it, preserves order", () => {
    const { tracer, spans } = fakeTracer();
    const size = 10 * 1024;
    const logs = Array.from({ length: 20 }, (_, i) => rec(String(i).padEnd(size, "x")));
    const result = attachChunked(tracer, "child.spans", {}, logs);
    expect(result.attached).toBe(20);
    expect(result.chunks).toBe(spans.length);
    expect(spans.length).toBeGreaterThan(1);
    for (const s of spans) {
      const bytes = s.logs.reduce((n, l) => n + l.key.length + l.value.length, 0);
      expect(bytes).toBeLessThanOrEqual(CARRIER_SPAN_BYTE_BUDGET);
    }
    const flat = spans.flatMap((s) => s.logs.map((l) => l.value.slice(0, 2)));
    expect(flat).toEqual(logs.map((l) => l.value.slice(0, 2)));
  });

  it("splits at the log-count cap for tiny records", () => {
    const { tracer, spans } = fakeTracer();
    const logs = Array.from({ length: CARRIER_SPAN_LOG_CAP + 100 }, () => rec("."));
    const result = attachChunked(tracer, "child.spans", {}, logs);
    expect(result.attached).toBe(CARRIER_SPAN_LOG_CAP + 100);
    expect(spans).toHaveLength(2);
    expect(spans[0]!.logs).toHaveLength(CARRIER_SPAN_LOG_CAP);
    expect(spans[1]!.logs).toHaveLength(100);
  });

  it("drops an oversized record, counts it on the last chunk, keeps the rest", () => {
    const { tracer, spans } = fakeTracer();
    const result = attachChunked(tracer, "child.spans", {}, [
      rec("ok-1"),
      rec("z".repeat(CARRIER_SPAN_BYTE_BUDGET + 1)),
      rec("ok-2"),
    ]);
    expect(result).toEqual({ attached: 2, oversized: 1, chunks: 1 });
    expect(spans[0]!.logs.map((l) => l.value)).toEqual(["ok-1", "ok-2"]);
    expect(spans[0]!.tagWrites[1]).toEqual({ oversizedDropped: 1 });
  });

  it("all-oversized input still surfaces the drop on a marker span", () => {
    const { tracer, spans } = fakeTracer();
    const result = attachChunked(tracer, "child.spans", { kind: "renderer" }, [
      rec("z".repeat(CARRIER_SPAN_BYTE_BUDGET + 1)),
    ]);
    expect(result).toEqual({ attached: 0, oversized: 1, chunks: 1 });
    expect(spans[0]!.tagWrites[0]).toEqual({
      kind: "renderer",
      records: 0,
      oversizedDropped: 1,
    });
    expect(spans[0]!.logs).toHaveLength(0);
  });

  it("finalTags land on the LAST chunk only", () => {
    const { tracer, spans } = fakeTracer();
    const size = 30 * 1024;
    attachChunked(
      tracer,
      "child.console",
      { scriptName: "s" },
      [rec("a".repeat(size)), rec("b".repeat(size)), rec("c".repeat(size))],
      { dropped: 7 },
    );
    expect(spans.length).toBeGreaterThan(1);
    for (const s of spans.slice(0, -1)) expect(s.tagWrites).toHaveLength(1);
    expect(spans.at(-1)!.tagWrites[1]).toEqual({ dropped: 7 });
  });

  it("exact-cap chunk + trailing oversized: final tags land on a marker", () => {
    const { tracer, spans } = fakeTracer();
    const logs = [
      ...Array.from({ length: CARRIER_SPAN_LOG_CAP }, () => rec(".")),
      rec("z".repeat(CARRIER_SPAN_BYTE_BUDGET + 1)),
    ];
    const result = attachChunked(tracer, "child.spans", {}, logs, {
      recordsDropped: 9,
    });
    expect(result).toEqual({
      attached: CARRIER_SPAN_LOG_CAP,
      oversized: 1,
      chunks: 2,
    });
    const marker = spans.at(-1)!;
    expect(marker.logs).toHaveLength(0);
    expect(marker.tagWrites[0]).toEqual({
      records: 0,
      recordsDropped: 9,
      oversizedDropped: 1,
    });
  });

  it("sizes by UTF-8 bytes, not UTF-16 code units", () => {
    const { tracer, spans } = fakeTracer();
    const cjk = "漢".repeat(10_000);
    const result = attachChunked(tracer, "child.spans", {}, [rec(cjk), rec(cjk)]);
    expect(result.attached).toBe(2);
    expect(spans).toHaveLength(2);
    for (const s of spans) expect(s.logs).toHaveLength(1);
  });

  it("empty input opens no spans", () => {
    const { tracer, spans } = fakeTracer();
    const result = attachChunked(tracer, "child.spans", {}, []);
    expect(result).toEqual({ attached: 0, oversized: 0, chunks: 0 });
    expect(spans).toHaveLength(0);
  });
});
