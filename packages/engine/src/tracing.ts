// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Defines tracing interfaces and helpers for spans and URL redaction.

export interface SpanContext {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  traceFlags: number;
}

export type SpanTags = Record<string, string | number | boolean>;

export interface Span {
  addLogs(logs: SpanTags): void;
  end(): void;
  setTags(tags: SpanTags): void;
  isRecording: boolean;
}

export interface Tracer {
  enterSpan<T extends unknown[], R = void>(
    name: string,
    span: (span: Span, ...args: T) => R,
    ...args: T
  ): R;
  getSpanContext(): SpanContext | null;
  runWithSpanContext<T extends unknown[], R = void>(
    spanContext: SpanContext | null,
    callback: (...args: T) => R,
    ...args: T
  ): R;
}

export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "(unparseable-url)";
  }
}

const MODULE_INIT_AT = Date.now();
let firstRecordedSpan = true;

export function traceSpan<T>(
  tracer: Tracer | undefined,
  name: string,
  fn: (s: Span | null) => T,
  tags?: SpanTags,
): T {
  if (!tracer) return fn(null);
  return tracer.enterSpan(name, (s) => {
    if (firstRecordedSpan && s.isRecording) {
      firstRecordedSpan = false;
      s.setTags({
        engine_first_trace: true,
        ...(MODULE_INIT_AT > 0 ? { engine_init_age_ms: Date.now() - MODULE_INIT_AT } : {}),
      });
    }
    if (tags) s.setTags(tags);
    return fn(s);
  });
}
