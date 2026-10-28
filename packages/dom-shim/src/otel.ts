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

type ActiveSpanCallback = (span: Span) => unknown;
type ActiveSpanOptions = { attributes?: Attributes };
type SpanBridge = {
  enter: typeof ksGlobal.__ksJsSpanEnter;
  exit: typeof ksGlobal.__ksJsSpanExit;
};

function activeSpanCallback(rest: unknown[]): ActiveSpanCallback | undefined {
  return rest.find((arg) => typeof arg === "function") as ActiveSpanCallback | undefined;
}

function activeSpanOptions(rest: unknown[]): ActiveSpanOptions | undefined {
  const candidate = rest[0];
  return typeof candidate === "object" && candidate !== null
    ? (candidate as ActiveSpanOptions)
    : undefined;
}

function spanBridge(): SpanBridge | null {
  const enter = ksGlobal.__ksJsSpanEnter;
  const exit = ksGlobal.__ksJsSpanExit;
  return typeof enter === "function" && typeof exit === "function" ? { enter, exit } : null;
}

function bridgeDetails(attributes?: Attributes): { bytes: number; detail: string } {
  let bytes = -1;
  let detail = "";
  if (attributes) {
    for (const key of Object.keys(attributes)) {
      const value = attributes[key];
      bytes = bridgeByteValue(bytes, value);
      detail = bridgeDetailValue(detail, value);
    }
  }
  return { bytes, detail };
}

function bridgeByteValue(current: number, value: Attributes[string]): number {
  if (typeof value !== "number" || current >= 0) return current;
  return value;
}

function bridgeDetailValue(current: string, value: Attributes[string]): string {
  if (typeof value !== "string" || current) return current;
  return value;
}

function runBridgeCallback(
  callback: ActiveSpanCallback,
  slot: number,
  bridge: SpanBridge,
): unknown {
  try {
    return callback(NOOP_SPAN);
  } finally {
    if (slot >= 0) {
      try {
        bridge.exit(slot);
      } catch {}
    }
  }
}

function startBridgedSpan(
  name: string,
  callback: ActiveSpanCallback,
  attributes: Attributes | undefined,
  bridge: SpanBridge,
): unknown {
  const { bytes, detail } = bridgeDetails(attributes);
  let slot = -1;
  try {
    slot = bridge.enter(name, bytes, detail);
  } catch {}
  return runBridgeCallback(callback, slot, bridge);
}

function startUnbridgedSpan(
  name: string,
  options: ActiveSpanOptions | undefined,
  callback: ActiveSpanCallback | undefined,
): unknown {
  const span = new KsSpan(name, options?.attributes);
  if (!callback) return span as any;
  stack.push(span);
  try {
    return callback(span);
  } finally {
    stack.pop();
  }
}

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
    const callback = activeSpanCallback(rest);
    const options = activeSpanOptions(rest);
    const bridge = spanBridge();
    if (callback && bridge) {
      return startBridgedSpan(name, callback, options?.attributes, bridge);
    }
    return startUnbridgedSpan(name, options, callback);
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
