// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Emits privacy-filtered DOM spans through the private PageScript/Wasm tracing bridge.

import { SpanStatusCode } from "@opentelemetry/api";
import type { Attributes, Span, SpanContext, Tracer } from "@opentelemetry/api";
import { ksGlobal } from "./state.js";

let armed = false;

const STD_EVENT_TYPES = new Set([
  "click",
  "dblclick",
  "mousedown",
  "mouseup",
  "mousemove",
  "mouseover",
  "mouseout",
  "mouseenter",
  "mouseleave",
  "contextmenu",
  "wheel",
  "keydown",
  "keyup",
  "keypress",
  "input",
  "beforeinput",
  "change",
  "submit",
  "reset",
  "focus",
  "blur",
  "focusin",
  "focusout",
  "load",
  "unload",
  "beforeunload",
  "error",
  "abort",
  "DOMContentLoaded",
  "readystatechange",
  "pageshow",
  "pagehide",
  "popstate",
  "hashchange",
  "scroll",
  "resize",
  "select",
  "selectionchange",
  "slotchange",
  "transitionend",
  "animationend",
  "animationstart",
  "transitionstart",
  "pointerdown",
  "pointerup",
  "pointermove",
  "pointerover",
  "pointerout",
  "pointerenter",
  "pointerleave",
  "pointercancel",
  "gotpointercapture",
  "lostpointercapture",
  "touchstart",
  "touchend",
  "touchmove",
  "touchcancel",
  "drag",
  "dragstart",
  "dragend",
  "dragenter",
  "dragleave",
  "dragover",
  "drop",
  "copy",
  "cut",
  "paste",
  "visibilitychange",
]);

export function safeEventType(type: unknown): string {
  return typeof type === "string" && STD_EVENT_TYPES.has(type) ? type : "custom";
}

function randHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  try {
    crypto.getRandomValues(b);
  } catch {
    for (let i = 0; i < bytes; i++) b[i] = (Math.random() * 256) | 0;
  }
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

let isolateTraceId: string | null = null;
function traceId(): string {
  return (isolateTraceId ??= randHex(16));
}

const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

function nowNano(): string {
  return (BigInt(Date.now()) * NANOSECONDS_PER_MILLISECOND).toString();
}

function otlpValue(v: unknown): Record<string, unknown> {
  switch (typeof v) {
    case "boolean":
      return { boolValue: v };
    case "number":
      return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
    case "string":
      return { stringValue: v };
    default:
      return { stringValue: String(v) };
  }
}

const stack: KsSpan[] = [];

const NOOP_SPAN = {
  spanContext: () => ({ traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 0 }),
  setAttribute: function () {
    return this;
  },
  setAttributes: function () {
    return this;
  },
  addEvent: function () {
    return this;
  },
  addLink: function () {
    return this;
  },
  addLinks: function () {
    return this;
  },
  setStatus: function () {
    return this;
  },
  updateName: function () {
    return this;
  },
  end: () => {},
  isRecording: () => false,
  recordException: () => {},
} satisfies Span;

class KsSpan implements Span {
  private _name: string;
  private _ctx: SpanContext;
  private _parent: string | null;
  private _start: string;
  private _attrs: Array<{ key: string; value: Record<string, unknown> }> = [];
  private _ended = false;

  constructor(name: string, attributes?: Attributes) {
    this._name = name;
    const top = stack[stack.length - 1];
    this._parent = top ? top.spanContext().spanId : (ksGlobal.__ksTp as string) || null;
    this._ctx = { traceId: traceId(), spanId: randHex(8), traceFlags: 1 };
    if (attributes) this.setAttributes(attributes);
    this._start = nowNano();
  }

  spanContext(): SpanContext {
    return this._ctx;
  }
  setAttribute(key: string, value: unknown): this {
    this._attrs.push({ key, value: otlpValue(value) });
    return this;
  }
  setAttributes(attributes: Attributes): this {
    for (const k of Object.keys(attributes)) this.setAttribute(k, attributes[k]);
    return this;
  }
  addEvent(): this {
    return this;
  }
  addLink(): this {
    return this;
  }
  addLinks(): this {
    return this;
  }
  setStatus(status: { code: number }): this {
    if (status && status.code === SpanStatusCode.ERROR) {
      this.setAttribute("error", true);
    }
    return this;
  }
  updateName(name: string): this {
    this._name = name;
    return this;
  }
  isRecording(): boolean {
    return !this._ended;
  }
  recordException(e: unknown): void {
    const name = (e as any)?.name;
    this.setAttribute("exception", typeof name === "string" ? name : "Error");
  }
  end(): void {
    if (this._ended) return;
    this._ended = true;
    console.log(
      "[ks-otel-span] " +
        JSON.stringify({
          name: this._name,
          traceId: this._ctx.traceId,
          spanId: this._ctx.spanId,
          parentSpanId: this._parent,
          startTimeUnixNano: this._start,
          endTimeUnixNano: nowNano(),
          attributes: this._attrs,
        }),
    );
  }
}

const ksTracer: Tracer = {
  startSpan(name: string, options?: { attributes?: Attributes }): Span {
    return new KsSpan(name, options?.attributes);
  },
  startActiveSpan(name: string, ...rest: unknown[]): any {
    const fn = rest.find((a) => typeof a === "function") as ((span: Span) => unknown) | undefined;
    const opts = (typeof rest[0] === "object" && rest[0] !== null ? rest[0] : undefined) as
      | { attributes?: Attributes }
      | undefined;
    const enter = ksGlobal.__ksJsSpanEnter;
    const exit = ksGlobal.__ksJsSpanExit;
    if (fn && typeof enter === "function" && typeof exit === "function") {
      let bytes = -1;
      let detail = "";
      const attrs = opts?.attributes;
      if (attrs) {
        for (const k of Object.keys(attrs)) {
          const v = attrs[k];
          if (typeof v === "number" && bytes < 0) bytes = v;
          else if (typeof v === "string" && !detail) detail = v;
        }
      }
      let slot = -1;
      try {
        slot = enter(name, bytes, detail);
      } catch {}
      try {
        return fn(NOOP_SPAN);
      } finally {
        if (slot >= 0) {
          try {
            exit(slot);
          } catch {}
        }
      }
    }
    const span = new KsSpan(name, opts?.attributes);
    if (!fn) return span as any;
    stack.push(span as KsSpan);
    try {
      return fn(span);
    } finally {
      stack.pop();
    }
  },
} as Tracer;

export function armKsOtel(on: boolean): void {
  armed = !!on;
}

export function ksSpan<T>(name: string, attrs: Attributes | null, fn: () => T): T {
  if (!armed) return fn();
  return ksTracer.startActiveSpan(name, attrs ? { attributes: attrs } : {}, (span: Span) => {
    try {
      return fn();
    } catch (e) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw e;
    } finally {
      span.end();
    }
  });
}
