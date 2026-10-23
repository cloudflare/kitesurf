// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { env } from "cloudflare:test";

import { upgradedSocket } from "./connect";
import { expect, test } from "./harness";

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: Array<{ key: string; value: { stringValue?: string; doubleValue?: number } }>;
  events?: Array<{
    name: string;
    attributes: Array<{ key: string; value: { stringValue?: string; doubleValue?: number } }>;
  }>;
}

type CdpReply = { id?: number; result?: unknown; error?: unknown };
const invalidCdpReply = Symbol("invalid CDP reply JSON");

function parseCdpReply(event: { data: string | ArrayBuffer }): CdpReply | typeof invalidCdpReply {
  const text = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
  try {
    return JSON.parse(text) as CdpReply;
  } catch {
    return invalidCdpReply;
  }
}

function cdpReplyBody(message: CdpReply): Record<string, unknown> {
  return (message.result ?? message.error ?? {}) as Record<string, unknown>;
}

function settleCdpReply(
  message: CdpReply,
  pending: Map<number, (reply: Record<string, unknown>) => void>,
): void {
  if (typeof message.id !== "number") return;
  const resolve = pending.get(message.id);
  if (!resolve) return;
  pending.delete(message.id);
  resolve(cdpReplyBody(message));
}

function carrierRecordCount(span: OtlpSpan): number {
  return span.events?.length ?? 0;
}

function carrierByteLength(span: OtlpSpan): number {
  return (span.events ?? [])
    .flatMap((event) => event.attributes)
    .reduce(
      (total, attribute) =>
        total + attribute.key.length + (attribute.value.stringValue?.length ?? 0),
      0,
    );
}

function expectCarrierWithinCaps(carrier: OtlpSpan): void {
  const attributes = carrier.attributes;
  if (!attributes) throw new Error("child.spans has no attributes");
  const byName = new Map(attributes.map((attribute) => [attribute.key, attribute.value]));
  expect(byName.has("span_error")).toBe(false);
  expect(byName.get("records")?.doubleValue).toBe(carrierRecordCount(carrier));
  expect(carrierByteLength(carrier)).toBeLessThanOrEqual(64 * 1024);
}

function capture(): Cloudflare.Env["OTLP_CAPTURE"] {
  return env.OTLP_CAPTURE;
}

async function capturedSpans(): Promise<OtlpSpan[]> {
  const resp = await capture().fetch("https://otlp-capture/spans");
  return (await resp.json()) as OtlpSpan[];
}

async function pollSpans(
  traceId: string,
  done: (spans: OtlpSpan[]) => boolean,
  timeoutMs = 30_000,
): Promise<OtlpSpan[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const spans = (await capturedSpans()).filter((s) => s.traceId === traceId);
    if (done(spans)) return spans;
    if (Date.now() > deadline) {
      throw new Error(`spans not captured in time; have: ${spans.map((s) => s.name).join(", ")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function openRawCdp(headers: Record<string, string> = {}): Promise<{
  send(method: string, params?: unknown): Promise<Record<string, unknown>>;
  close(): void;
}> {
  const engine = env.ENGINE;
  const resp = await engine.fetch("https://ks.invalid/devtools/browser", {
    headers: { Upgrade: "websocket", ...headers },
  });
  const ws = upgradedSocket(resp);
  if (!ws) throw new Error(`CDP upgrade failed (status ${resp.status})`);
  ws.accept();
  let nextId = 1;
  const pending = new Map<number, (r: Record<string, unknown>) => void>();
  ws.addEventListener("message", (ev: { data: string | ArrayBuffer }) => {
    const message = parseCdpReply(ev);
    if (message === invalidCdpReply) return;
    settleCdpReply(message, pending);
  });
  return {
    send(method, params) {
      const id = nextId++;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params: params ?? {} }));
      });
    },
    close() {
      ws.close();
    },
  };
}

test("unsampled session exports nothing", async () => {
  await capture().fetch("https://otlp-capture/reset");
  const cdp = await openRawCdp();
  try {
    await cdp.send("Page.navigate", {
      url: "https://ks.invalid/__fixtures/inline-script.html",
    });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await capturedSpans()).toHaveLength(0);
  } finally {
    cdp.close();
  }
});

test("heavy record volume chunks carriers under the binding caps", async () => {
  await capture().fetch("https://otlp-capture/reset");
  const traceId = "aa2e3d4c5b6a79880102030405060708";
  const cdp = await openRawCdp({ traceparent: traceId });
  try {
    const html =
      '<!doctype html><html><body><div id="t">x</div><script>' +
      'const t=document.getElementById("t");' +
      'for(let i=0;i<1000;i++)t.innerHTML="<span>iter "+i+"</span>";' +
      "</scr" +
      "ipt></body></html>";
    await cdp.send("Page.navigate", {
      url: `data:text/html,${encodeURIComponent(html)}`,
    });

    const recordCount = (spans: OtlpSpan[]) =>
      spans
        .filter((s) => s.name === "child.spans")
        .reduce((n, c) => n + (c.events?.length ?? 0), 0);
    const spans = await pollSpans(traceId, (all) => recordCount(all) > 500, 60_000);

    const carriers = spans.filter((s) => s.name === "child.spans");
    expect(carriers.length).toBeGreaterThan(1);
    for (const carrier of carriers) expectCarrierWithinCaps(carrier);
  } finally {
    cdp.close();
  }
});

test("resource drain: awaited subresources appear as spans", async () => {
  await capture().fetch("https://otlp-capture/reset");
  const traceId = "bb2e3d4c5b6a79880102030405060708";
  const cdp = await openRawCdp({ traceparent: traceId });
  try {
    await cdp.send("Page.navigate", {
      url: "https://ks.invalid/__fixtures/eager-slow-load.html",
    });
    const spans = await pollSpans(
      traceId,
      (all) =>
        all.some((s) => s.name === "child.resource_drain") &&
        all.some((s) => s.name === "subresource.fetch"),
      60_000,
    );

    const drain = spans.find((s) => s.name === "child.resource_drain")!;
    const fetches = spans.filter((s) => s.name === "subresource.fetch");
    const attrsOf = (s: OtlpSpan) => {
      const attributes = s.attributes;
      if (!attributes) throw new Error(`${s.name} has no attributes`);
      return new Map(attributes.map((a) => [a.key, a.value.stringValue]));
    };
    const img = fetches.find((s) => attrsOf(s).get("path") === "/__fixtures/slow-headers-red.png");
    expect(img).toBeDefined();
    expect(BigInt(img!.startTimeUnixNano)).toBeLessThan(BigInt(drain.endTimeUnixNano));
    expect(BigInt(img!.endTimeUnixNano)).toBeGreaterThan(BigInt(drain.startTimeUnixNano));
  } finally {
    cdp.close();
  }
});

test("sampled session exports all three layers to one trace", async () => {
  await capture().fetch("https://otlp-capture/reset");
  const traceId = "1f2e3d4c5b6a79880102030405060708";
  const cdp = await openRawCdp({ traceparent: traceId });
  try {
    await cdp.send("Page.navigate", {
      url: "https://ks.invalid/__fixtures/inline-script.html",
    });
    await pollSpans(
      traceId,
      (all) =>
        all.some((s) => s.name === "cdp.Page.navigate") &&
        all.some((s) => s.name === "child.spans"),
    );
  } finally {
    cdp.close();
  }

  const spans = await pollSpans(traceId, (all) => all.some((s) => s.name === "local.request"));

  const wsConnect = spans.find((s) => s.name === "ws.connect");
  const navigate = spans.find((s) => s.name === "cdp.Page.navigate");
  expect(wsConnect).toBeDefined();
  expect(navigate).toBeDefined();
  expect(navigate!.parentSpanId).toBe(wsConnect!.spanId);
  const root = spans.find((s) => s.name === "local.request");
  expect(root).toBeDefined();
  expect(root!.parentSpanId).toBe("");
  expect(BigInt(root!.endTimeUnixNano)).toBeGreaterThanOrEqual(BigInt(navigate!.endTimeUnixNano));

  const carriers = spans.filter((s) => s.name === "child.spans");
  expect(carriers.length).toBeGreaterThan(0);
  const records = carriers.flatMap((c) =>
    (c.events ?? [])
      .flatMap((e) => e.attributes)
      .filter((a) => a.key === "otel.span")
      .map((a) => JSON.parse(a.value.stringValue ?? "{}") as { name?: string }),
  );
  expect(records.some((r) => r.name?.startsWith("wasm."))).toBe(true);

  const ids = new Set(spans.map((s) => s.spanId));
  for (const s of spans) {
    if (s.parentSpanId !== "") expect(ids.has(s.parentSpanId)).toBe(true);
  }
});

test("renderer spans reach the trace", async () => {
  await capture().fetch("https://otlp-capture/reset");
  const traceId = "ee2e3d4c5b6a79880102030405060708";
  const cdp = await openRawCdp({ traceparent: traceId });
  try {
    await cdp.send("Page.navigate", {
      url: "data:text/html,<p style='color:red'>hi</p>",
    });
    await cdp.send("Page.captureScreenshot", { format: "png" });
    const spans = await pollSpans(traceId, (all) =>
      all.some((s) =>
        (s.attributes ?? []).some((a) => a.key === "kind" && a.value.stringValue === "renderer"),
      ),
    );
    expect(spans.length).toBeGreaterThan(0);
  } finally {
    cdp.close();
  }
});
