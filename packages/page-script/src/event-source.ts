// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Installs the page EventSource over the gated fetch path, so `withCredentials` selects the
// request's credentials mode exactly as fetch does.

import {
  cancelResponseBody,
  readerRead,
  responseBody,
  responseFollowedUrl,
  responseHeaderGet,
  responseStatus,
  streamGetReader,
} from "./native-http.ts";
import { ksGlobal, ksGlobalByKey, shimEventCtor } from "./state.ts";
import { trustedFetch } from "./trusted-fetch.ts";

type AnyFn = (...args: unknown[]) => unknown;

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;
const DEFAULT_RECONNECTION_TIME_MS = 3000;
const EVENT_STREAM_MIME_TYPE = "text/event-stream";

// Captured before page code can replace them: the connection runs on our scheduling, not the
// page's.
const NativeAbortController = AbortController;
const NativeTextDecoder = TextDecoder;
const nativeSetTimeout = setTimeout;
const nativeClearTimeout = clearTimeout;

export interface ParsedEvent {
  type: string;
  data: string;
  lastEventId: string;
}

// The text/event-stream interpreter: one line at a time, CR/LF/CRLF aware across chunks.
export class EventStreamParser {
  /** Set by a `retry` field; null until the stream asks for a different delay. */
  reconnectionTimeMs: number | null = null;
  /** The last event ID string, sent back as Last-Event-ID on the next connection. */
  lastEventId = "";
  private pending = "";
  private data = "";
  private eventType = "";
  private id = "";
  private started = false;
  private skipLeadingLf = false;

  /**
   * A reconnection resumes from the saved id. Seeding the id buffer too keeps the first event
   * without an `id:` field from clearing it.
   */
  constructor(lastEventId = "") {
    this.lastEventId = lastEventId;
    this.id = lastEventId;
  }

  push(chunk: string): ParsedEvent[] {
    const events: ParsedEvent[] = [];
    let text = chunk;
    if (!this.started && text.length > 0) {
      this.started = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    let index = 0;
    if (text.length > 0) {
      if (this.skipLeadingLf && text.charCodeAt(0) === 0x0a) index = 1;
      this.skipLeadingLf = false;
    }
    let line = this.pending;
    this.pending = "";
    let lineStart = index;
    for (; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code !== 0x0a && code !== 0x0d) continue;
      line += text.slice(lineStart, index);
      this.readLine(line, events);
      line = "";
      if (code === 0x0d) {
        if (index + 1 < text.length) {
          if (text.charCodeAt(index + 1) === 0x0a) index++;
        } else {
          // A following chunk may still start with the LF of this CRLF.
          this.skipLeadingLf = true;
        }
      }
      lineStart = index + 1;
    }
    this.pending = line + text.slice(lineStart);
    return events;
  }

  private readLine(line: string, events: ParsedEvent[]): void {
    if (line === "") {
      // Dispatch step 1 runs before the empty-data check, so an id-only block still sticks.
      this.lastEventId = this.id;
      if (this.data === "") {
        this.eventType = "";
        return;
      }
      events.push({
        type: this.eventType === "" ? "message" : this.eventType,
        data: this.data.slice(0, -1),
        lastEventId: this.id,
      });
      this.data = "";
      this.eventType = "";
      return;
    }
    if (line.charCodeAt(0) === 0x3a) return; // A comment line.
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.charCodeAt(0) === 0x20) value = value.slice(1);
    if (field === "data") {
      this.data += value + "\n";
    } else if (field === "event") {
      this.eventType = value;
    } else if (field === "id") {
      if (!value.includes("\u0000")) this.id = value;
    } else if (field === "retry" && value !== "" && /^[0-9]+$/.test(value)) {
      this.reconnectionTimeMs = Number(value);
    }
  }
}

function mkEvent(type: string, fields: Record<string, unknown>): any {
  let ev: any;
  try {
    ev = new (shimEventCtor("Event"))(type);
  } catch {
    ev = { type };
  }
  for (const [k, v] of Object.entries(fields)) {
    try {
      ev[k] = v;
    } catch {}
  }
  return ev;
}

function mkMessageEvent(type: string, data: string, origin: string, lastEventId: string): any {
  try {
    return new (shimEventCtor("MessageEvent"))(type, { data, origin, lastEventId });
  } catch {
    return { type, data, origin, lastEventId };
  }
}

// A MessageEvent reports the origin of the URL the stream ended at, not the one it started at.
function responseOrigin(response: Response, fallback: string): string {
  const url = responseFollowedUrl(response);
  if (url === "") return fallback;
  try {
    return new URL(url).origin;
  } catch {
    return fallback;
  }
}

function mimeEssence(contentType: string | null): string {
  if (contentType === null) return "";
  const semicolon = contentType.indexOf(";");
  const value = semicolon === -1 ? contentType : contentType.slice(0, semicolon);
  return value.trim().toLowerCase();
}

export function installEventSource(): void {
  // The realm's EventTarget: dispatching through it supplies target, currentTarget, eventPhase,
  // composedPath, and the {once}/{handleEvent} listener forms.
  const EventTargetBase = ksGlobal.EventTarget;
  const nativeAddEventListener = EventTargetBase.prototype.addEventListener;
  const nativeRemoveEventListener = EventTargetBase.prototype.removeEventListener;
  // Captured so a page-installed EventTarget.prototype.dispatchEvent cannot intercept our events.
  const nativeDispatchEvent = EventTargetBase.prototype.dispatchEvent;

  class KsEventSource extends EventTargetBase {
    static CONNECTING = CONNECTING;
    static OPEN = OPEN;
    static CLOSED = CLOSED;

    #readyState: number = CONNECTING;
    #url: string;
    #withCredentials: boolean;

    private origin: string;
    // Event handler attributes are listeners on this target, registered when the attribute is set.
    private handlerAttributes = new Map<string, { handler: AnyFn; listener: AnyFn }>();
    private controller: AbortController | null = null;
    private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private wake: (() => void) | null = null;
    private closed = false;
    private lastEventId = "";
    private reconnectionTimeMs = DEFAULT_RECONNECTION_TIME_MS;

    // The IDL puts these on the prototype as accessors, not on each instance.
    get readyState(): number {
      return this.#readyState;
    }

    get url(): string {
      return this.#url;
    }

    get withCredentials(): boolean {
      return this.#withCredentials;
    }

    get onopen(): AnyFn | null {
      return this.handlerAttribute("open");
    }

    set onopen(handler: unknown) {
      this.setHandlerAttribute("open", handler);
    }

    get onmessage(): AnyFn | null {
      return this.handlerAttribute("message");
    }

    set onmessage(handler: unknown) {
      this.setHandlerAttribute("message", handler);
    }

    get onerror(): AnyFn | null {
      return this.handlerAttribute("error");
    }

    set onerror(handler: unknown) {
      this.setHandlerAttribute("error", handler);
    }

    constructor(url: unknown, init: unknown = undefined) {
      super();
      const raw = String(url ?? "");
      let base: string | undefined;
      try {
        base = ksGlobal.document?.baseURI;
      } catch {}
      let parsed: URL;
      try {
        parsed = new URL(raw, base);
      } catch {
        throw new ksGlobal.DOMException(
          "EventSource constructor: '" + raw + "' is not a valid URL.",
          "SyntaxError",
        );
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new ksGlobal.DOMException(
          "EventSource constructor: scheme must be http or https, got '" + parsed.protocol + "'",
          "SyntaxError",
        );
      }
      parsed.hash = "";
      this.#url = parsed.toString();
      this.origin = parsed.origin;
      let withCredentials = false;
      if (init !== null && typeof init === "object") {
        withCredentials = Boolean(Reflect.get(init, "withCredentials"));
      }
      this.#withCredentials = withCredentials;
      void this.run();
    }

    /** The shim's EventTarget ignores `options.signal`, so removal is wired here. */
    addEventListener(type: unknown, listener: unknown, options?: unknown): void {
      // Forward the call as received: the base keeps its argument-count check.
      const args = Array.from(arguments) as unknown[];
      Reflect.apply(nativeAddEventListener, this, args);
      const signal =
        typeof options === "object" && options !== null
          ? (options as { signal?: unknown }).signal
          : undefined;
      if (typeof signal !== "object" || signal === null) return;
      const remove = (): void => {
        try {
          Reflect.apply(nativeRemoveEventListener, this, args);
        } catch {}
      };
      try {
        if ((signal as { aborted?: unknown }).aborted === true) {
          remove();
          return;
        }
        (signal as { addEventListener: AnyFn }).addEventListener("abort", remove, { once: true });
      } catch {}
    }

    private setHandlerAttribute(type: string, value: unknown): void {
      const current = this.handlerAttributes.get(type);
      if (current) {
        this.removeEventListener(type, current.listener);
        this.handlerAttributes.delete(type);
      }
      if (typeof value !== "function") return;
      const handler = value as AnyFn;
      const listener = (event: unknown): unknown => Reflect.apply(handler, this, [event]);
      this.handlerAttributes.set(type, { handler, listener });
      this.addEventListener(type, listener);
    }

    private handlerAttribute(type: string): AnyFn | null {
      return this.handlerAttributes.get(type)?.handler ?? null;
    }

    private async run(): Promise<void> {
      while (!this.closed) {
        this.#readyState = CONNECTING;
        const controller = new NativeAbortController();
        this.controller = controller;
        try {
          const headers: Record<string, string> = { Accept: EVENT_STREAM_MIME_TYPE };
          if (this.lastEventId !== "") headers["Last-Event-ID"] = this.lastEventId;
          // Workerd's RequestInit omits `credentials`; the page fetch shim reads it from the init.
          const init: RequestInit & { credentials?: "same-origin" | "include" } = {
            headers,
            cache: "no-store",
            credentials: this.#withCredentials ? "include" : "same-origin",
            signal: controller.signal,
          };
          const response = await trustedFetch(this.#url, init, {
            resourceType: "EventSource",
            initiator: "script",
          });
          if (this.closed) {
            // close() ran while the fetch was in flight; nobody is left to read this body.
            cancelResponseBody(response);
            return;
          }
          const contentType = responseHeaderGet(response, "content-type");
          const status = responseStatus(response);
          if (status !== 200 || mimeEssence(contentType) !== EVENT_STREAM_MIME_TYPE) {
            cancelResponseBody(response);
            this.fail();
            return;
          }
          const body = responseBody(response);
          const reader = body === null ? null : streamGetReader(body);
          if (!reader) {
            this.fail();
            return;
          }
          this.reader = reader;
          const origin = responseOrigin(response, this.origin);
          const parser = new EventStreamParser(this.lastEventId);
          const decoder = new NativeTextDecoder();
          this.#readyState = OPEN;
          this.dispatchInternal(mkEvent("open", {}));
          for (;;) {
            const step = await readerRead(reader);
            if (this.closed) return;
            if (step.done) break;
            const events = parser.push(decoder.decode(step.value, { stream: true }));
            this.lastEventId = parser.lastEventId;
            if (parser.reconnectionTimeMs !== null) {
              this.reconnectionTimeMs = parser.reconnectionTimeMs;
            }
            this.dispatchEvents(events, origin);
          }
        } catch {
          if (this.closed) return;
        }
        // A dropped connection or a failed CORS check reconnects, as the HTML spec requires.
        this.#readyState = CONNECTING;
        this.dispatchInternal(mkEvent("error", {}));
        await this.waitReconnect();
      }
    }

    /** Dispatches each parsed event in order, stopping as soon as a handler closes the source. */
    private dispatchEvents(events: ParsedEvent[], origin: string): void {
      for (const event of events) {
        if (this.closed) break;
        this.dispatchInternal(mkMessageEvent(event.type, event.data, origin, event.lastEventId));
      }
    }

    private dispatchInternal(event: any): void {
      try {
        Reflect.apply(nativeDispatchEvent, this, [event]);
      } catch (error) {
        // A non-shim event cannot cross the shim's EventTarget; report instead of reconnecting.
        try {
          console.error("[kitesurf] EventSource dispatch threw:", error);
        } catch {}
      }
    }

    /** Fails the connection for good: wrong status, wrong MIME type, or no body. */
    private fail(): void {
      this.closed = true;
      this.#readyState = CLOSED;
      this.dispatchInternal(mkEvent("error", {}));
    }

    private waitReconnect(): Promise<void> {
      return new Promise<void>((resolve) => {
        this.wake = resolve;
        this.timer = nativeSetTimeout(() => {
          this.timer = null;
          this.wake = null;
          resolve();
        }, this.reconnectionTimeMs);
      });
    }

    close(): void {
      if (this.closed) return;
      this.closed = true;
      this.#readyState = CLOSED;
      try {
        this.controller?.abort();
      } catch {}
      try {
        void this.reader?.cancel().catch(() => {});
      } catch {}
      if (this.timer !== null) nativeClearTimeout(this.timer);
      this.timer = null;
      const wake = this.wake;
      this.wake = null;
      if (wake) wake();
    }
  }

  for (const [k, v] of Object.entries({ CONNECTING, OPEN, CLOSED })) {
    (KsEventSource.prototype as any)[k] = v;
  }
  // Class members are non-enumerable; the IDL lists these as enumerable prototype members.
  for (const name of [
    "url",
    "withCredentials",
    "readyState",
    "onopen",
    "onmessage",
    "onerror",
    "close",
  ]) {
    const descriptor = Object.getOwnPropertyDescriptor(KsEventSource.prototype, name);
    if (descriptor) {
      Object.defineProperty(KsEventSource.prototype, name, { ...descriptor, enumerable: true });
    }
  }
  try {
    Object.defineProperty(KsEventSource, "name", { value: "EventSource" });
    Object.defineProperty(KsEventSource.prototype, Symbol.toStringTag, {
      value: "EventSource",
      writable: false,
      enumerable: false,
      configurable: true,
    });
  } catch {}
  try {
    Object.defineProperty(ksGlobal, "EventSource", {
      value: KsEventSource,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  } catch {
    ksGlobalByKey.EventSource = KsEventSource;
  }
}
