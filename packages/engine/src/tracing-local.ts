// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Provides local trace propagation and OTLP export for development requests.

import { AsyncLocalStorage } from "node:async_hooks";
import type { Tracer, Span, SpanContext, SpanTags } from "./tracing.ts";

export const MAX_SPAN_BYTES = 64 * 1024;
export const MAX_SPAN_LOGS = 1023;

const SHORT_TRACE_ID_HEX_CHARS = 16;
const TRACE_ID_HEX_CHARS = 32;
const SPAN_ID_HEX_CHARS = 16;
// W3C Trace Context: version 00 is the only one defined, flags are one byte.
const TRACEPARENT_VERSION = "00";
const TRACE_FLAGS_HEX_CHARS = 2;
const TRACE_HEADER = "traceparent";
const FLUSH_DELAY_MS = 250;
const OTLP_EXPORT_TIMEOUT_MS = 5_000;
const MAX_SPAN_LIMIT_ERROR_NAME_CHARS = 64;
const NON_STRING_TAG_VALUE_BYTES = 8;
const MICROSECONDS_PER_MILLISECOND = 1_000;
const NANOSECONDS_PER_MICROSECOND = 1_000n;
const SERVICE_NAME = "kitesurf-local";
const ZERO_SPAN_ID = "0000000000000000";
const TRACE_ID_RE = new RegExp(
  `^([0-9a-f]{${SHORT_TRACE_ID_HEX_CHARS}}|[0-9a-f]{${TRACE_ID_HEX_CHARS}})$`,
);
const SPAN_ID_RE = new RegExp(`^[0-9a-f]{${SPAN_ID_HEX_CHARS}}$`);
const TRACEPARENT_RE = new RegExp(
  `^${TRACEPARENT_VERSION}-([0-9a-f]{${TRACE_ID_HEX_CHARS}})-` +
    `([0-9a-f]{${SPAN_ID_HEX_CHARS}})-([0-9a-f]{${TRACE_FLAGS_HEX_CHARS}})$`,
);
const ALL_ZERO_RE = /^0+$/;

function parseTraceparent(
  header: string,
): { traceId: string; spanId: string; traceFlags: number } | null {
  const m = TRACEPARENT_RE.exec(header);
  if (m === null) return null;
  const [, traceId, spanId, flags] = m;
  const valid = validTraceIdentifiers(traceId, spanId, flags);
  if (valid === null) return null;
  return { traceId: valid.traceId, spanId: valid.spanId, traceFlags: parseInt(valid.flags, 16) };
}

function validTraceIdentifiers(
  traceId: string | undefined,
  spanId: string | undefined,
  flags: string | undefined,
): { traceId: string; spanId: string; flags: string } | null {
  const identifiers = traceIdentifierValues(traceId, spanId, flags);
  if (identifiers === null) return null;
  const [validTraceId, validSpanId, validFlags] = identifiers;
  // The spec marks all-zero trace and parent ids invalid.
  if (hasZeroTraceIdentifier(validTraceId, validSpanId)) return null;
  return { traceId: validTraceId, spanId: validSpanId, flags: validFlags };
}

function traceIdentifierValues(
  traceId: string | undefined,
  spanId: string | undefined,
  flags: string | undefined,
): [string, string, string] | null {
  if (!traceId || !spanId || !flags) return null;
  return [traceId, spanId, flags];
}

function hasZeroTraceIdentifier(traceId: string, spanId: string): boolean {
  return ALL_ZERO_RE.test(traceId) || ALL_ZERO_RE.test(spanId);
}

type TagValue = SpanTags[string];
export type OtlpValue = { stringValue: string } | { boolValue: boolean } | { doubleValue: number };

interface OtlpAttribute {
  key: string;
  value: OtlpValue;
}

interface OtlpEvent {
  timeUnixNano: string;
  name: string;
  attributes: [OtlpAttribute];
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  kind: 1;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  events: OtlpEvent[];
}

interface OtlpScopeSpans {
  scope: { name: string };
  spans: OtlpSpan[];
}

interface OtlpResourceSpans {
  resource: { attributes: [OtlpAttribute] };
  scopeSpans: [OtlpScopeSpans];
}

export interface OtlpPayload {
  resourceSpans: [OtlpResourceSpans];
}

interface TraceCtx {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  traceFlags: number;
  recording: boolean;
}

const UNTRACED: TraceCtx = {
  traceId: "",
  spanId: "",
  parentSpanId: "",
  traceFlags: 0,
  recording: false,
};

interface SpanLog {
  tUs: number;
  key: string;
  value: TagValue;
}

export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  startUs: number;
  endUs: number;
  tags: Map<string, TagValue>;
  logs: SpanLog[];
  droppedLogs: number;
}

const UTF8 = new TextEncoder();
function valueSize(v: TagValue): number {
  return typeof v === "string" ? UTF8.encode(v).length : NON_STRING_TAG_VALUE_BYTES;
}

const HEX = "0123456789abcdef";
function randHex(chars: number): string {
  const bytes = new Uint8Array(chars / 2);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += HEX.charAt(b >> 4) + HEX.charAt(b & 15);
  return out;
}

const ANCHOR = { ms: 0, perf: 0 };
function nowUs(): number {
  if (ANCHOR.ms === 0) {
    ANCHOR.ms = Date.now();
    ANCHOR.perf = performance.now();
  }
  return (ANCHOR.ms + (performance.now() - ANCHOR.perf)) * MICROSECONDS_PER_MILLISECOND;
}

class LocalSpan implements Span {
  #rec: SpanRecord | null;
  #bytes = 0;
  #onEnd: (rec: SpanRecord) => void;

  constructor(rec: SpanRecord | null, onEnd: (rec: SpanRecord) => void) {
    this.#rec = rec;
    this.#onEnd = onEnd;
  }

  get isRecording(): boolean {
    return this.#rec !== null;
  }

  setTags(tags: SpanTags): void {
    const rec = this.#rec;
    if (rec === null || this.#bytes > MAX_SPAN_BYTES) return;
    for (const [key, value] of Object.entries(tags)) {
      const size = valueSize(value);
      this.#bytes += key.length + size;
      if (this.#bytes > MAX_SPAN_BYTES) {
        this.#limitError(rec, "tag", key, size);
        return;
      }
      rec.tags.set(key, value);
    }
  }

  addLogs(logs: SpanTags): void {
    const rec = this.#rec;
    if (rec === null || this.#bytes > MAX_SPAN_BYTES) return;
    const tUs = nowUs();
    for (const [key, value] of Object.entries(logs)) {
      if (this.#appendLog(rec, tUs, key, value)) return;
    }
  }

  #appendLog(rec: SpanRecord, tUs: number, key: string, value: TagValue): boolean {
    if (rec.logs.length >= MAX_SPAN_LOGS) {
      rec.droppedLogs++;
      return false;
    }
    const size = valueSize(value);
    this.#bytes += key.length + size;
    if (this.#bytes > MAX_SPAN_BYTES) {
      this.#limitError(rec, "log", key, size);
      return true;
    }
    rec.logs.push({ tUs, key, value });
    return false;
  }

  end(): void {
    const rec = this.#rec;
    if (rec === null) return;
    rec.endUs = nowUs();
    this.#rec = null;
    this.#onEnd(rec);
  }

  #limitError(rec: SpanRecord, kind: string, name: string, size: number): void {
    const shortName =
      name.length > MAX_SPAN_LIMIT_ERROR_NAME_CHARS
        ? `"${name.slice(0, MAX_SPAN_LIMIT_ERROR_NAME_CHARS)}..." ` + `(key length ${name.length})`
        : `"${name}"`;
    rec.tags.set(
      "span_error",
      `exceeded span data limit while trying to record ${kind} ${shortName} of size ${size}`,
    );
  }
}

export type OtlpTarget =
  | { url: string }
  | { binding: { fetch(input: string, init?: RequestInit): Promise<Response> } };

export class OtlpExporter {
  #queue: SpanRecord[] = [];
  #scheduled = false;
  #ctx: ExecutionContext | null = null;
  #target: OtlpTarget | null;
  #warned = false;

  constructor(target: OtlpTarget | null) {
    this.#target = target;
  }

  bind(ctx: ExecutionContext): void {
    this.#ctx = ctx;
  }

  enqueue(rec: SpanRecord): void {
    if (this.#target === null) return;
    this.#queue.push(rec);
    this.#schedule();
  }

  #schedule(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    const flushed = (async () => {
      await new Promise((resolve) => setTimeout(resolve, FLUSH_DELAY_MS));
      this.#scheduled = false;
      await this.#flush();
    })();
    flushed.catch(() => {});
    try {
      this.#ctx?.waitUntil(flushed);
    } catch {}
  }

  async flushNow(): Promise<void> {
    await this.#flush();
  }

  async #flush(): Promise<void> {
    if (this.#queue.length === 0 || this.#target === null) return;
    const batch = this.#queue;
    this.#queue = [];
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(toOtlpPayload(batch)),
      signal: AbortSignal.timeout(OTLP_EXPORT_TIMEOUT_MS),
    };
    try {
      const res =
        "url" in this.#target
          ? await fetch(this.#target.url, init)
          : await this.#target.binding.fetch("http://otlp-capture/v1/traces", init);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await res.body?.cancel();
    } catch (err) {
      if (this.#warned) return;
      this.#warned = true;
      console.warn(
        `[local-trace] OTLP export failed (further failures silent): ${
          err instanceof Error ? err.message : String(err)
        } — is the collector up? (pnpm dev:tracing)`,
      );
    }
  }
}

function otlpValue(v: TagValue): OtlpValue {
  switch (typeof v) {
    case "string":
      return { stringValue: v };
    case "boolean":
      return { boolValue: v };
    default:
      return { doubleValue: v };
  }
}

function usToNanos(us: number): string {
  return (BigInt(Math.round(us)) * NANOSECONDS_PER_MICROSECOND).toString();
}

function finishSessionResult<T>(value: T, settle: () => void): T {
  const ws: unknown =
    value === null || value === undefined
      ? undefined
      : Reflect.get(Object(value), "webSocket", value);
  if (!ws) settle();
  return value;
}

function sessionParentSpanId(parent: { spanId: string; traceFlags: number } | undefined): string {
  return parent?.spanId ?? ZERO_SPAN_ID;
}

function sessionTraceFlags(parent: { spanId: string; traceFlags: number } | undefined): number {
  return parent?.traceFlags ?? 1;
}

export function toOtlpPayload(recs: SpanRecord[]): OtlpPayload {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: SERVICE_NAME } }],
        },
        scopeSpans: [
          {
            scope: { name: "kitesurf-local-tracer" },
            spans: recs.map((r) => ({
              traceId: r.traceId.padStart(TRACE_ID_HEX_CHARS, "0"),
              spanId: r.spanId,
              parentSpanId: r.parentSpanId === ZERO_SPAN_ID ? "" : r.parentSpanId,
              name: r.name,
              kind: 1,
              startTimeUnixNano: usToNanos(r.startUs),
              endTimeUnixNano: usToNanos(r.endUs),
              attributes: [
                ...[...r.tags].map(([key, value]) => ({
                  key,
                  value: otlpValue(value),
                })),
                ...(r.droppedLogs > 0
                  ? [{ key: "droppedLogs", value: { doubleValue: r.droppedLogs } }]
                  : []),
              ],
              events: r.logs.map((l) => ({
                timeUnixNano: usToNanos(l.tUs),
                name: l.key,
                attributes: [{ key: l.key, value: otlpValue(l.value) }],
              })),
            })),
          },
        ],
      },
    ],
  };
}

export class LocalTracer implements Tracer {
  #als = new AsyncLocalStorage<TraceCtx>();
  #exporter: OtlpExporter;

  constructor(exporter: OtlpExporter) {
    this.#exporter = exporter;
  }

  #current(): TraceCtx | null {
    return this.#als.getStore() ?? null;
  }

  enterSpan<T extends unknown[], R = void>(
    name: string,
    cb: (s: Span, ...args: T) => R,
    ...args: T
  ): R {
    const parent = this.#current();
    let span: LocalSpan;
    let ctx: TraceCtx;
    if (parent !== null && parent.recording) {
      const rec: SpanRecord = {
        traceId: parent.traceId,
        spanId: randHex(SPAN_ID_HEX_CHARS),
        parentSpanId: parent.spanId,
        name,
        startUs: nowUs(),
        endUs: 0,
        tags: new Map(),
        logs: [],
        droppedLogs: 0,
      };
      span = new LocalSpan(rec, (r) => this.#exporter.enqueue(r));
      ctx = {
        traceId: rec.traceId,
        spanId: rec.spanId,
        parentSpanId: rec.parentSpanId,
        traceFlags: parent.traceFlags,
        recording: true,
      };
    } else {
      span = new LocalSpan(null, () => {});
      ctx = UNTRACED;
    }
    let result: R;
    try {
      result = this.#als.run(ctx, cb, span, ...args);
    } catch (err) {
      span.end();
      throw err;
    }
    if (result instanceof Promise) {
      return result.then(
        (value) => {
          span.end();
          return value;
        },
        (err) => {
          span.end();
          throw err;
        },
      ) as R;
    }
    span.end();
    return result;
  }

  getSpanContext(): SpanContext | null {
    const c = this.#current();
    if (c === null || !c.recording) return null;
    return {
      traceId: c.traceId,
      spanId: c.spanId,
      parentSpanId: c.parentSpanId,
      traceFlags: c.traceFlags,
    };
  }

  runWithSpanContext<T extends unknown[], R = void>(
    spanContext: SpanContext | null,
    cb: (...args: T) => R,
    ...args: T
  ): R {
    if (spanContext === null) return this.#als.run(UNTRACED, cb, ...args);
    if (!TRACE_ID_RE.test(spanContext.traceId)) throw new TypeError("Could not parse traceId.");
    if (!SPAN_ID_RE.test(spanContext.spanId)) throw new TypeError("Could not parse spanId.");
    if (!SPAN_ID_RE.test(spanContext.parentSpanId))
      throw new TypeError("Could not parse parentSpanId.");
    const ctx: TraceCtx = {
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
      parentSpanId: spanContext.parentSpanId,
      traceFlags: spanContext.traceFlags,
      recording: true,
    };
    return this.#als.run(ctx, cb, ...args);
  }

  get traceId(): string | null {
    return this.getSpanContext()?.traceId ?? null;
  }

  get spanId(): string | null {
    return this.getSpanContext()?.spanId ?? null;
  }

  get parentSpanId(): string | null {
    return this.getSpanContext()?.parentSpanId ?? null;
  }

  /** The current context as a W3C `traceparent` value, for forwarding to a downstream hop. */
  get traceparentHeader(): string | null {
    const c = this.getSpanContext();
    if (c === null) return null;
    const traceId = c.traceId.padStart(TRACE_ID_HEX_CHARS, "0");
    const flags = c.traceFlags.toString(16).padStart(TRACE_FLAGS_HEX_CHARS, "0");
    return `${TRACEPARENT_VERSION}-${traceId}-${c.spanId}-${flags}`;
  }

  runTracedSession<R>(
    traceId: string,
    name: string,
    tags: SpanTags,
    fn: () => R,
    parent?: { spanId: string; traceFlags: number },
  ): R {
    const rec: SpanRecord = {
      traceId,
      spanId: randHex(SPAN_ID_HEX_CHARS),
      parentSpanId: sessionParentSpanId(parent),
      name,
      startUs: nowUs(),
      endUs: 0,
      tags: new Map(),
      logs: [],
      droppedLogs: 0,
    };
    const span = new LocalSpan(rec, (r) => this.#exporter.enqueue(r));
    span.setTags(tags);
    const ctx: TraceCtx = {
      traceId,
      spanId: rec.spanId,
      parentSpanId: rec.parentSpanId,
      traceFlags: sessionTraceFlags(parent),
      recording: true,
    };
    const settle = () => {
      sessionEndResolvers.delete(rec.spanId);
      span.end();
    };
    sessionEndResolvers.set(rec.spanId, () => span.end());
    const result = this.#als.run(ctx, fn);
    if (result instanceof Promise) {
      return result.then(
        (value) => finishSessionResult(value, settle),
        (err) => {
          settle();
          throw err;
        },
      ) as R;
    }
    settle();
    return result;
  }

  runTraced<R>(
    traceId: string,
    name: string,
    tags: SpanTags,
    fn: () => R,
    parent?: { spanId: string; traceFlags: number },
  ): R {
    const virtualRoot: TraceCtx = {
      traceId,
      spanId: parent?.spanId ?? ZERO_SPAN_ID,
      parentSpanId: ZERO_SPAN_ID,
      traceFlags: parent?.traceFlags ?? 1,
      recording: true,
    };
    return this.#als.run(virtualRoot, () =>
      this.enterSpan(name, (s) => {
        s.setTags(tags);
        return fn();
      }),
    );
  }
}

interface LocalTracingEnv {
  KITESURF_ENV?: string;
  KITESURF_TRACE_ALL?: string;
  KITESURF_OTLP_ENDPOINT?: string;
  OTLP_CAPTURE?: { fetch(input: string, init?: RequestInit): Promise<Response> };
  HOST_TRACER?: unknown;
}

let singleton: LocalTracer | null = null;
let singletonExporter: OtlpExporter | null = null;

function canArmLocalTracing(env: LocalTracingEnv): boolean {
  return (
    env.KITESURF_ENV === "local" &&
    (env.HOST_TRACER === undefined || env.HOST_TRACER instanceof LocalTracer)
  );
}

function ensureLocalTracer(env: LocalTracingEnv, ctx: ExecutionContext): LocalTracer {
  if (singleton === null) {
    singletonExporter = new OtlpExporter(targetFromEnv(env));
    singleton = new LocalTracer(singletonExporter);
  }
  const tracer = singleton;
  singletonExporter?.bind(ctx);
  return tracer;
}

function incomingTraceparent(request: Request): string | null {
  return request.headers.get(TRACE_HEADER)?.toLowerCase() ?? null;
}

function shouldTraceRequest(header: string | null, traceAll: string | undefined): boolean {
  return header !== null || traceAll === "1";
}

function traceIdFromHeader(
  header: string | null,
  full: ReturnType<typeof parseTraceparent>,
): string {
  if (full) return full.traceId;
  if (header !== null && TRACE_ID_RE.test(header)) return header;
  return randHex(TRACE_ID_HEX_CHARS);
}

function parentFromTraceparent(
  full: ReturnType<typeof parseTraceparent>,
): { spanId: string; traceFlags: number } | undefined {
  return full ? { spanId: full.spanId, traceFlags: full.traceFlags } : undefined;
}

function logNewTrace(traceId: string): void {
  console.log(
    `[local-trace] sampled trace ${traceId} — ` +
      `http://localhost:16686/trace/${traceId.padStart(TRACE_ID_HEX_CHARS, "0")}`,
  );
}

interface LocalRequestTrace {
  traceId: string;
  runTags: SpanTags;
  parent: { spanId: string; traceFlags: number } | undefined;
  isUpgrade: boolean;
}

function localRequestTrace(header: string | null, request: Request): LocalRequestTrace {
  const full = header !== null ? parseTraceparent(header) : null;
  const traceId = traceIdFromHeader(header, full);
  const parent = parentFromTraceparent(full);
  const url = new URL(request.url);
  if (!parent) logNewTrace(traceId);
  const runTags = { "http.method": request.method, "http.path": url.pathname };
  const isUpgrade = (request.headers.get("upgrade") ?? "").toLowerCase() === "websocket";
  return { traceId, runTags, parent, isUpgrade };
}

function runLocalRequest<R>(
  tracer: LocalTracer,
  isUpgrade: boolean,
  traceId: string,
  runTags: SpanTags,
  parent: { spanId: string; traceFlags: number } | undefined,
  fn: () => R,
): R {
  return isUpgrade
    ? tracer.runTracedSession(traceId, "local.request", runTags, fn, parent)
    : tracer.runTraced(traceId, "local.request", runTags, fn, parent);
}

function targetFromEnv(env: LocalTracingEnv): OtlpTarget | null {
  if (env.OTLP_CAPTURE) return { binding: env.OTLP_CAPTURE };
  if (env.KITESURF_OTLP_ENDPOINT) return { url: env.KITESURF_OTLP_ENDPOINT };
  return null;
}

export function localTracerSingleton(): LocalTracer | null {
  return singleton;
}

export function bindLocalFlushCtx(ctx: ExecutionContext): void {
  singletonExporter?.bind(ctx);
}

const sessionEndResolvers = new Map<string, () => void>();

export function endLocalTraceSession(env: { HOST_TRACER?: unknown }): void {
  const tracer = env.HOST_TRACER;
  if (!(tracer instanceof LocalTracer)) return;
  const sc = tracer.getSpanContext();
  if (sc === null) return;
  for (const key of [sc.spanId, sc.parentSpanId]) {
    const end = sessionEndResolvers.get(key);
    if (end) {
      sessionEndResolvers.delete(key);
      end();
      return;
    }
  }
}

export function localTraceEventWrap(env: { HOST_TRACER?: unknown }): <R>(fn: () => R) => R {
  const tracer = env.HOST_TRACER;
  if (!(tracer instanceof LocalTracer)) return (fn) => fn();
  const captured = tracer.getSpanContext();
  if (captured === null) return (fn) => fn();
  return (fn) => tracer.runWithSpanContext(captured, fn);
}

export function localTraceparentHeader(): string | null {
  return singleton?.traceparentHeader ?? null;
}

export function localTraceParentProps(): { localTraceParent?: SpanContext } {
  const sc = singleton?.getSpanContext() ?? null;
  return sc ? { localTraceParent: sc } : {};
}

/**
 * Local-only and never over a real HOST_TRACER. Traces when `traceparent` is set (a bare
 * trace id there starts a new trace with that id) or `KITESURF_TRACE_ALL=1`.
 */
export function armLocalTracing(
  env: LocalTracingEnv,
  ctx: ExecutionContext,
  request: Request,
): (<R>(fn: () => R) => R) | null {
  if (!canArmLocalTracing(env)) return null;
  const shim = ensureLocalTracer(env, ctx);
  env.HOST_TRACER = shim;
  const header = incomingTraceparent(request);
  if (!shouldTraceRequest(header, env.KITESURF_TRACE_ALL)) return null;
  const trace = localRequestTrace(header, request);
  return (fn) =>
    runLocalRequest(shim, trace.isUpgrade, trace.traceId, trace.runTags, trace.parent, fn);
}

export function createLocalTracerForTest(target: OtlpTarget | null): {
  tracer: LocalTracer;
  exporter: OtlpExporter;
} {
  const exporter = new OtlpExporter(target);
  return { tracer: new LocalTracer(exporter), exporter };
}
