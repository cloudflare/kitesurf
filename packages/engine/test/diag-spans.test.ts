// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import { DiagSpanTracker } from "../src/cdp/diag-spans.ts";
import type { Tracer } from "../src/tracing.ts";

interface CapturedSpan {
  name: string;
  tags: Record<string, unknown>;
  settled: boolean;
}

function fakeTracer(): { tracer: Tracer; spans: CapturedSpan[] } {
  const spans: CapturedSpan[] = [];
  const tracer = {
    runWithSpanContext: (_ctx: unknown, cb: () => unknown) => cb(),
    enterSpan(name: string, cb: (s: unknown) => unknown) {
      const captured: CapturedSpan = { name, tags: {}, settled: false };
      spans.push(captured);
      const result = cb({
        isRecording: true,
        setTags: (t: Record<string, unknown>) => Object.assign(captured.tags, t),
        addLogs: () => {},
        end: () => {},
      });
      if (result instanceof Promise) {
        void result.then(() => {
          captured.settled = true;
        });
      }
      return result;
    },
  } as Tracer;
  return { tracer, spans };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("DiagSpanTracker.settleFromSummary", () => {
  it("finishes a stranded start (end event lost) with the summary duration", async () => {
    const { tracer, spans } = fakeTracer();
    const tracker = new DiagSpanTracker(tracer, null);
    tracker.handle({ ev: "start", op: "resource_drain", t: 100 });
    tracker.settleFromSummary({ resourceDrainMs: 1234 });
    await flush();
    const drain = spans.filter((s) => s.name === "child.resource_drain");
    expect(drain).toHaveLength(1);
    expect(drain[0]!.settled).toBe(true);
    expect(drain[0]!.tags.child_ms).toBe(1234);
    expect(drain[0]!.tags.from_summary).toBe(true);
  });

  it("mints a span when BOTH bracket events were lost", async () => {
    const { tracer, spans } = fakeTracer();
    const tracker = new DiagSpanTracker(tracer, null);
    tracker.settleFromSummary({ asyncScriptsMs: 7, resourceDrainMs: 42 });
    await flush();
    expect(spans.map((s) => [s.name, s.tags.child_ms, s.settled]).sort()).toEqual([
      ["child.async_scripts", 7, true],
      ["child.resource_drain", 42, true],
    ]);
  });

  it("never duplicates a phase the live bracket already closed", async () => {
    const { tracer, spans } = fakeTracer();
    const tracker = new DiagSpanTracker(tracer, null);
    tracker.handle({ ev: "start", op: "resource_drain", t: 100 });
    tracker.handle({ ev: "end", op: "resource_drain", t: 350 });
    tracker.settleFromSummary({ resourceDrainMs: 250 });
    await flush();
    const drain = spans.filter((s) => s.name === "child.resource_drain");
    expect(drain).toHaveLength(1);
    expect(drain[0]!.tags.from_summary).toBeUndefined();
    expect(drain[0]!.tags.child_ms).toBe(250);
  });

  it("ignores non-phase and malformed summary keys", async () => {
    const { tracer, spans } = fakeTracer();
    const tracker = new DiagSpanTracker(tracer, null);
    tracker.settleFromSummary({
      notAPhase: 5,
      ["x".repeat(64) + "Ms"]: 5,
      badValueMs: Number.NaN,
    } as Record<string, number>);
    await flush();
    expect(spans).toHaveLength(0);
  });
});
