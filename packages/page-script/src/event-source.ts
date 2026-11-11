// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Installs the page EventSource over the gated fetch path, so `withCredentials` selects the
// request's credentials mode exactly as fetch does.

import { responseHeaderGet } from "./native-http.ts";
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
      if (this.data === "") {
        this.eventType = "";
        return;
      }
      events.push({
        type: this.eventType === "" ? "message" : this.eventType,
        data: this.data.slice(0, -1),
        lastEventId: this.id,
      });
      this.lastEventId = this.id;
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

function mimeEssence(contentType: string | null): string {
  if (contentType === null) return "";
  const semicolon = contentType.indexOf(";");
  const value = semicolon === -1 ? contentType : contentType.slice(0, semicolon);
  return value.trim().toLowerCase();
}

export function installEventSource(): void {
  class KsEventSource {
    static CONNECTING = CONNECTING;
    static OPEN = OPEN;
    static CLOSED = CLOSED;

    #readyState: number = CONNECTING;
    #url: string;
    #withCredentials: boolean;
    #onopen: AnyFn | null = null;
    #onmessage: AnyFn | null = null;
    #onerror: AnyFn | null = null;

    private origin: string;
    private listeners = new Map<string, Set<AnyFn>>();
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
      return this.#onopen;
    }

    set onopen(handler: unknown) {
      this.#onopen = typeof handler === "function" ? (handler as AnyFn) : null;
    }

    get onmessage(): AnyFn | null {
      return this.#onmessage;
    }

    set onmessage(handler: unknown) {
      this.#onmessage = typeof handler === "function" ? (handler as AnyFn) : null;
    }

    get onerror(): AnyFn | null {
      return this.#onerror;
    }

    set onerror(handler: unknown) {
      this.#onerror = typeof handler === "function" ? (handler as AnyFn) : null;
    }

    constructor(url: unknown, init: unknown = undefined) {
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
          if (this.closed) return;
          const contentType = responseHeaderGet(response, "content-type");
          if (response.status !== 200 || mimeEssence(contentType) !== EVENT_STREAM_MIME_TYPE) {
            void response.body?.cancel().catch(() => {});
            this.fail();
            return;
          }
          const reader = response.body?.getReader();
          if (!reader) {
            this.fail();
            return;
          }
          this.reader = reader;
          const parser = new EventStreamParser();
          parser.lastEventId = this.lastEventId;
          const decoder = new NativeTextDecoder();
          this.#readyState = OPEN;
          this.emit("open", mkEvent("open", {}));
          for (;;) {
            const step = await reader.read();
            if (this.closed) return;
            if (step.done) break;
            const events = parser.push(decoder.decode(step.value, { stream: true }));
            this.lastEventId = parser.lastEventId;
            if (parser.reconnectionTimeMs !== null) {
              this.reconnectionTimeMs = parser.reconnectionTimeMs;
            }
            for (const event of events) {
              this.emit(
                event.type,
                mkMessageEvent(event.type, event.data, this.origin, event.lastEventId),
              );
            }
          }
        } catch {
          if (this.closed) return;
        }
        // A dropped connection or a failed CORS check reconnects, as the HTML spec requires.
        this.#readyState = CONNECTING;
        this.emit("error", mkEvent("error", {}));
        await this.waitReconnect();
      }
    }

    /** Fails the connection for good: wrong status, wrong MIME type, or no body. */
    private fail(): void {
      this.closed = true;
      this.#readyState = CLOSED;
      this.emit("error", mkEvent("error", {}));
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

    private emit(type: string, event: any): void {
      try {
        event.target = event.currentTarget = this;
      } catch {}
      const handler = (this as any)["on" + type];
      if (typeof handler === "function") {
        try {
          handler.call(this, event);
        } catch (error) {
          try {
            console.error("[kitesurf] EventSource on" + type + " threw:", error);
          } catch {}
        }
      }
      const listeners = this.listeners.get(type);
      if (listeners) {
        for (const listener of Array.from(listeners)) {
          try {
            listener.call(this, event);
          } catch (error) {
            try {
              console.error("[kitesurf] EventSource listener threw:", error);
            } catch {}
          }
        }
      }
    }

    addEventListener(type: string, listener: AnyFn): void {
      if (typeof listener !== "function") return;
      let listeners = this.listeners.get(String(type));
      if (!listeners) {
        listeners = new Set();
        this.listeners.set(String(type), listeners);
      }
      listeners.add(listener);
    }

    removeEventListener(type: string, listener: AnyFn): void {
      this.listeners.get(String(type))?.delete(listener);
    }

    dispatchEvent(event: any): boolean {
      this.emit(String(event?.type ?? ""), event);
      return true;
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
