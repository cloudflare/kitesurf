// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import {
  armLocalTracing,
  localTraceparentHeader,
  createLocalTracerForTest,
  endLocalTraceSession,
  MAX_SPAN_LOGS,
  toOtlpPayload,
  type OtlpPayload,
  type OtlpSpan,
  type OtlpTarget,
  type OtlpValue,
} from "../src/tracing-local.ts";
import type { Span } from "../src/tracing.ts";

async function traced(
  fn: (tracer: ReturnType<typeof createLocalTracerForTest>["tracer"]) => unknown,
): Promise<OtlpSpan[]> {
  const posted: string[] = [];
  const target: OtlpTarget = {
    binding: {
      fetch: async (_url: string, init?: RequestInit) => {
        posted.push(String(init?.body));
        return new Response("ok");
      },
    },
  };
  const { tracer, exporter } = createLocalTracerForTest(target);
  const t = "a".repeat(32);
  await tracer.runTraced(t, "root", { rootTag: true }, () => fn(tracer));
  await exporter.flushNow();
  const spans: OtlpSpan[] = [];
  for (const body of posted) {
    const payload: OtlpPayload = JSON.parse(body);
    spans.push(...payload.resourceSpans[0].scopeSpans[0].spans);
  }
  return spans;
}

function attr(span: OtlpSpan, key: string): OtlpValue | undefined {
  return span.attributes.find((a) => a.key === key)?.value;
}

describe("LocalTracer span lifecycle", () => {
  it("records a sync span nested under the root", async () => {
    const spans = await traced((j) =>
      j.enterSpan("child", (s) => {
        expect(s.isRecording).toBe(true);
        s.setTags({ n: 7 });
      }),
    );
    const root = spans.find((s) => s.name === "root")!;
    const child = spans.find((s) => s.name === "child")!;
    expect(root.parentSpanId).toBe("");
    expect(child.parentSpanId).toBe(root.spanId);
    expect(child.traceId).toBe("a".repeat(32));
    expect(attr(child, "n")).toEqual({ doubleValue: 7 });
    expect(attr(root, "rootTag")).toEqual({ boolValue: true });
  });

  it("defers end() to promise settle and passes the value through", async () => {
    let value: number | undefined;
    const spans = await traced(async (j) => {
      value = await j.enterSpan("async", async () => {
        await new Promise((r) => setTimeout(r, 10));
        return 42;
      });
    });
    expect(value).toBe(42);
    const span = spans.find((s) => s.name === "async")!;
    const durNs = BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano);
    expect(durNs).toBeGreaterThanOrEqual(5_000_000n);
  });

  it("ends the span on promise rejection and rethrows", async () => {
    let caught: unknown;
    const spans = await traced(async (j) => {
      try {
        await j.enterSpan("boom", async () => {
          throw new Error("boom");
        });
      } catch (err) {
        caught = err;
      }
    });
    expect((caught as Error).message).toBe("boom");
    expect(spans.some((s) => s.name === "boom")).toBe(true);
  });

  it("ends the span on sync throw and rethrows", async () => {
    let caught: unknown;
    const spans = await traced((j) => {
      try {
        j.enterSpan("sync-boom", () => {
          throw new Error("sync-boom");
        });
      } catch (err) {
        caught = err;
      }
    });
    expect((caught as Error).message).toBe("sync-boom");
    expect(spans.some((s) => s.name === "sync-boom")).toBe(true);
  });

  it("ends at most once: manual end() wins, mutations after are no-ops", async () => {
    const spans = await traced((j) =>
      j.enterSpan("once", (s) => {
        s.setTags({ before: true });
        s.end();
        expect(s.isRecording).toBe(false);
        s.setTags({ after: true });
      }),
    );
    const once = spans.filter((s) => s.name === "once");
    expect(once).toHaveLength(1);
    expect(attr(once[0]!, "before")).toEqual({ boolValue: true });
    expect(attr(once[0]!, "after")).toBeUndefined();
  });

  it("runs the callback with a no-op span when unsampled", async () => {
    const posted: string[] = [];
    const { tracer, exporter } = createLocalTracerForTest({
      binding: {
        fetch: async (_url: string, init?: RequestInit) => {
          posted.push(String(init?.body));
          return new Response("ok");
        },
      },
    });
    let ran = false;
    let recording = true;
    tracer.enterSpan("orphan", (s: Span) => {
      ran = true;
      recording = s.isRecording;
      s.setTags({ ignored: true });
    });
    await exporter.flushNow();
    expect(ran).toBe(true);
    expect(recording).toBe(false);
    expect(posted).toHaveLength(0);
  });
});

describe("LocalTracer tags, logs and binding caps", () => {
  it("upserts tags and appends logs in order", async () => {
    const spans = await traced((j) =>
      j.enterSpan("kv", (s) => {
        s.setTags({ k: "one" });
        s.setTags({ k: "two" });
        s.addLogs({ "otel.span": "first" });
        s.addLogs({ "otel.span": "second" });
      }),
    );
    const kv = spans.find((s) => s.name === "kv")!;
    expect(attr(kv, "k")).toEqual({ stringValue: "two" });
    expect(kv.events.map((e) => e.attributes[0]!.value)).toEqual([
      { stringValue: "first" },
      { stringValue: "second" },
    ]);
    expect(kv.events[0]!.attributes[0]!.key).toBe("otel.span");
  });

  it("caps span data at 64KB with span_error, then ignores mutations", async () => {
    const spans = await traced((j) =>
      j.enterSpan("fat", (s) => {
        s.addLogs({ "otel.span": "x".repeat(60 * 1024) });
        s.addLogs({ "otel.span": "y".repeat(8 * 1024) });
        s.setTags({ late: true });
      }),
    );
    const fat = spans.find((s) => s.name === "fat")!;
    expect(fat.events).toHaveLength(1);
    const err = attr(fat, "span_error");
    expect(err !== undefined && "stringValue" in err ? err.stringValue : undefined).toContain(
      "exceeded span data limit",
    );
    expect(attr(fat, "late")).toBeUndefined();
  });

  it("caps logs at 1023 and reports droppedLogs", async () => {
    const spans = await traced((j) =>
      j.enterSpan("chatty", (s) => {
        for (let i = 0; i < MAX_SPAN_LOGS + 5; i++) s.addLogs({ l: "." });
      }),
    );
    const chatty = spans.find((s) => s.name === "chatty")!;
    expect(chatty.events).toHaveLength(MAX_SPAN_LOGS);
    expect(attr(chatty, "droppedLogs")).toEqual({ doubleValue: 5 });
  });
});

describe("LocalTracer context propagation", () => {
  it("exposes the current span via getSpanContext, null outside", async () => {
    await traced((j) => {
      const rootCtx = j.getSpanContext()!;
      expect(rootCtx.traceId).toBe("a".repeat(32));
      j.enterSpan("inner", () => {
        const inner = j.getSpanContext()!;
        expect(inner.parentSpanId).toBe(rootCtx.spanId);
        expect(inner.spanId).not.toBe(rootCtx.spanId);
      });
    });
    const { tracer } = createLocalTracerForTest(null);
    expect(tracer.getSpanContext()).toBeNull();
    expect(tracer.traceId).toBeNull();
  });

  it("survives async gaps (ALS propagation)", async () => {
    await traced(async (j) => {
      const before = j.getSpanContext()!;
      await new Promise((r) => setTimeout(r, 5));
      expect(j.getSpanContext()).toEqual(before);
    });
  });

  it("runWithSpanContext(null) runs untraced inside a sampled context", async () => {
    const spans = await traced((j) =>
      j.runWithSpanContext(null, () => {
        expect(j.getSpanContext()).toBeNull();
        j.enterSpan("hidden", (s) => expect(s.isRecording).toBe(false));
      }),
    );
    expect(spans.some((s) => s.name === "hidden")).toBe(false);
  });

  it("runWithSpanContext adopts a valid context and rejects malformed ids", async () => {
    const spans = await traced((j) => {
      const ctx = {
        traceId: "b".repeat(32),
        spanId: "c".repeat(16),
        parentSpanId: "d".repeat(16),
        traceFlags: 1,
      };
      j.runWithSpanContext(ctx, () => {
        expect(j.getSpanContext()).toEqual(ctx);
        j.enterSpan("adopted", () => {});
      });
      expect(() => j.runWithSpanContext({ ...ctx, spanId: "nope" }, () => {})).toThrow(TypeError);
    });
    const adopted = spans.find((s) => s.name === "adopted")!;
    expect(adopted.traceId).toBe("b".repeat(32));
    expect(adopted.parentSpanId).toBe("c".repeat(16));
  });
});

describe("WS session roots", () => {
  function capturingPair() {
    const posted: string[] = [];
    const pair = createLocalTracerForTest({
      binding: {
        fetch: async (_url: string, init?: RequestInit) => {
          posted.push(String(init?.body));
          return new Response("ok");
        },
      },
    });
    const names = () =>
      posted.flatMap((body) => {
        const payload: OtlpPayload = JSON.parse(body);
        return payload.resourceSpans[0].scopeSpans[0].spans.map((span) => span.name);
      });
    return { ...pair, names };
  }

  it("holds the root open past the 101 and ends it on the close signal", async () => {
    const { tracer, exporter, names } = capturingPair();
    let rootCtx: ReturnType<typeof tracer.getSpanContext> = null;
    const resp = await tracer.runTracedSession("d".repeat(32), "local.request", {}, () => {
      rootCtx = tracer.getSpanContext();
      return Promise.resolve({ webSocket: {} });
    });
    expect(resp.webSocket).toBeDefined();
    await exporter.flushNow();
    expect(names()).toHaveLength(0);
    tracer.runWithSpanContext(rootCtx, () =>
      tracer.enterSpan("ws.connect", () => endLocalTraceSession({ HOST_TRACER: tracer })),
    );
    await exporter.flushNow();
    expect(names()).toContain("local.request");
  });

  it("ends at settle when the reply carries no webSocket", async () => {
    const { tracer, exporter, names } = capturingPair();
    await tracer.runTracedSession("e".repeat(32), "local.request", {}, () =>
      Promise.resolve({ status: 429 }),
    );
    await exporter.flushNow();
    expect(names()).toContain("local.request");
  });
});

describe("OTLP payload shape", () => {
  it("pads 16-hex trace ids on the wire only", () => {
    const payload = toOtlpPayload([
      {
        traceId: "1".repeat(16),
        spanId: "2".repeat(16),
        parentSpanId: "0".repeat(16),
        name: "x",
        startUs: 1_000_000,
        endUs: 2_000_000,
        tags: new Map(),
        logs: [],
        droppedLogs: 0,
      },
    ]);
    const span = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(span.traceId).toBe("0".repeat(16) + "1".repeat(16));
    expect(span.parentSpanId).toBe("");
    expect(span.startTimeUnixNano).toBe("1000000000");
    expect(span.endTimeUnixNano).toBe("2000000000");
  });
});

describe("armLocalTracing gating", () => {
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- tracing only calls waitUntil here.
  const ctx = { waitUntil() {} } as unknown as ExecutionContext;
  const req = (headers?: Record<string, string>) =>
    new Request("http://localhost:8787/screenshot", { headers });

  it("never arms outside KITESURF_ENV=local or over a real binding", () => {
    expect(armLocalTracing({ KITESURF_ENV: "prod" }, ctx, req())).toBeNull();
    const realBinding = { enterSpan() {} };
    const env = { KITESURF_ENV: "local", HOST_TRACER: realBinding };
    expect(armLocalTracing(env, ctx, req({ traceparent: "x" }))).toBeNull();
    expect(env.HOST_TRACER).toBe(realBinding);
  });

  it("adopts a full propagated context: the request nests under the caller", () => {
    const env: { KITESURF_ENV: string; HOST_TRACER?: unknown } = {
      KITESURF_ENV: "local",
    };
    const t = "f".repeat(32);
    const callerSpan = "1234567890abcdef";
    const runner = armLocalTracing(env, ctx, req({ traceparent: `00-${t}-${callerSpan}-01` }));
    expect(runner).not.toBeNull();
    const inside = runner!(() => {
      const tracer = env.HOST_TRACER as {
        getSpanContext(): { traceId: string; parentSpanId: string } | null;
      };
      return tracer.getSpanContext();
    });
    expect(inside?.traceId).toBe(t);
    expect(inside?.parentSpanId).toBe(callerSpan);
  });

  it("forwards the active context as a W3C traceparent", () => {
    const env: { KITESURF_ENV: string; HOST_TRACER?: unknown } = { KITESURF_ENV: "local" };
    const t = "a".repeat(32);
    const runner = armLocalTracing(env, ctx, req({ traceparent: `00-${t}-1234567890abcdef-01` }));
    const forwarded = runner!(() => localTraceparentHeader());
    expect(forwarded).toMatch(new RegExp(`^00-${t}-[0-9a-f]{16}-01$`));
    expect(forwarded).not.toContain("1234567890abcdef");
  });

  it("does not adopt a malformed or all-zero traceparent as the parent", () => {
    for (const header of [
      `00-${"f".repeat(32)}-${"0".repeat(16)}-01`,
      `01-${"f".repeat(32)}-1234567890abcdef-01`,
    ]) {
      const env: { KITESURF_ENV: string; HOST_TRACER?: unknown } = { KITESURF_ENV: "local" };
      const runner = armLocalTracing(env, ctx, req({ traceparent: header }));
      expect(runner).not.toBeNull();
      const inside = runner!(() =>
        (env.HOST_TRACER as { getSpanContext(): { traceId: string } | null }).getSpanContext(),
      );
      // A rejected header starts a fresh root trace instead of joining the caller's.
      expect(inside?.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(inside?.traceId).not.toBe("f".repeat(32));
    }
  });

  it("installs the shim always, samples only with traceparent", () => {
    const env: { KITESURF_ENV: string; HOST_TRACER?: unknown } = {
      KITESURF_ENV: "local",
    };
    expect(armLocalTracing(env, ctx, req())).toBeNull();
    expect(env.HOST_TRACER).toBeDefined();
    const runner = armLocalTracing(env, ctx, req({ traceparent: "e".repeat(32) }));
    expect(runner).not.toBeNull();
    const inside = runner!(() => {
      const tracer = env.HOST_TRACER as { getSpanContext(): { traceId: string } | null };
      return tracer.getSpanContext();
    });
    expect(inside?.traceId).toBe("e".repeat(32));
  });
});
