// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Installs the page WebSocket facade over workerd's WebSocket-upgrade fetch.

import { ksEventCtors, ksGlobal } from "./state.ts";

type AnyFn = (...args: unknown[]) => unknown;

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;
const WEBSOCKET_NORMAL_CLOSURE_CODE = 1000;
const WEBSOCKET_NO_STATUS_RECEIVED_CODE = 1005;
const WEBSOCKET_ABNORMAL_CLOSURE_CODE = 1006;

function mkEvent(type: string, fields: Record<string, unknown>): any {
  let ev: any;
  try {
    ev = new ksEventCtors.Event(type);
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

export function installWebSocketFacade(): void {
  class KsWebSocket {
    static CONNECTING = CONNECTING;
    static OPEN = OPEN;
    static CLOSING = CLOSING;
    static CLOSED = CLOSED;

    readyState = CONNECTING;
    binaryType: string = "blob";
    bufferedAmount = 0;
    extensions = "";
    protocol = "";
    url: string;

    onopen: AnyFn | null = null;
    onmessage: AnyFn | null = null;
    onerror: AnyFn | null = null;
    onclose: AnyFn | null = null;

    private _listeners = new Map<string, Set<AnyFn>>();
    private _socket: WebSocket | null = null;
    private _closeRequested: { code?: number; reason?: string } | null = null;
    private _settled = false;

    constructor(url: unknown, protocols?: unknown) {
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
          "WebSocket constructor: '" + raw + "' is not a valid URL.",
          "SyntaxError",
        );
      }
      if (parsed.protocol === "http:") parsed.protocol = "ws:";
      else if (parsed.protocol === "https:") parsed.protocol = "wss:";
      if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
        throw new ksGlobal.DOMException(
          "WebSocket constructor: scheme must be ws or wss, got '" + parsed.protocol + "'",
          "SyntaxError",
        );
      }
      this.url = parsed.toString();
      const fetchUrl =
        (parsed.protocol === "wss:" ? "https:" : "http:") + this.url.slice(parsed.protocol.length);
      const protoList = Array.isArray(protocols)
        ? protocols.map(String).join(", ")
        : typeof protocols === "string" && protocols
          ? protocols
          : "";
      void this._connect(fetchUrl, protoList);
    }

    private async _connect(fetchUrl: string, protoList: string): Promise<void> {
      try {
        const headers: Record<string, string> = { Upgrade: "websocket" };
        if (protoList) headers["Sec-WebSocket-Protocol"] = protoList;
        const resp: Response | null | undefined = await (ksGlobal.fetch as typeof globalThis.fetch)(
          fetchUrl,
          { headers },
        );
        const socket = resp?.webSocket ?? null;
        if (!socket) {
          this._fail("WebSocket upgrade failed: HTTP " + (resp?.status ?? "?"));
          return;
        }
        if (this._closeRequested) {
          try {
            socket.accept();
          } catch {}
          try {
            socket.close(
              this._closeRequested.code ?? WEBSOCKET_NORMAL_CLOSURE_CODE,
              this._closeRequested.reason ?? "",
            );
          } catch {}
          this._finishClose(this._closeRequested.code ?? WEBSOCKET_NORMAL_CLOSURE_CODE, "", true);
          return;
        }
        try {
          this.protocol = String(resp?.headers?.get?.("sec-websocket-protocol") ?? "") || "";
        } catch {}
        socket.accept();
        this._socket = socket;
        let delivery: Promise<void> = Promise.resolve();
        socket.addEventListener("message", (ev) => {
          const raw = ev?.data;
          delivery = delivery.then(async () => {
            let data = raw;
            const isBlobLike =
              data !== null &&
              typeof data === "object" &&
              typeof (data as { arrayBuffer?: unknown }).arrayBuffer === "function" &&
              !(data instanceof ArrayBuffer) &&
              !ArrayBuffer.isView(data);
            if (this.binaryType === "arraybuffer" && isBlobLike) {
              try {
                data = await (data as { arrayBuffer: () => Promise<unknown> }).arrayBuffer();
              } catch {}
            } else if (this.binaryType === "blob" && data instanceof ArrayBuffer) {
              const BlobConstructor = ksGlobal.Blob;
              if (typeof BlobConstructor === "function") {
                data = new BlobConstructor([data]);
              }
            }
            this._emit("message", mkEvent("message", { data, origin: this.url }));
          });
        });
        socket.addEventListener("close", (ev) => {
          this._finishClose(
            typeof ev?.code === "number" ? ev.code : WEBSOCKET_NO_STATUS_RECEIVED_CODE,
            String(ev?.reason ?? ""),
            ev?.wasClean !== false,
          );
        });
        socket.addEventListener("error", () => {
          this._emit("error", mkEvent("error", {}));
        });
        this.readyState = OPEN;
        this._emit("open", mkEvent("open", {}));
      } catch (err) {
        this._fail("WebSocket connect failed: " + ((err as any)?.message ?? String(err)));
      }
    }

    private _fail(message: string): void {
      if (this._settled) return;
      try {
        console.warn("[kitesurf] " + message);
      } catch {}
      this._emit("error", mkEvent("error", { message }));
      this._finishClose(WEBSOCKET_ABNORMAL_CLOSURE_CODE, "", false);
    }

    private _finishClose(code: number, reason: string, wasClean: boolean): void {
      if (this._settled) return;
      this._settled = true;
      this.readyState = CLOSED;
      this._emit("close", mkEvent("close", { code, reason, wasClean }));
    }

    private _emit(type: string, event: any): void {
      try {
        event.target = event.currentTarget = this;
      } catch {}
      const handler = (this as any)["on" + type];
      if (typeof handler === "function") {
        try {
          handler.call(this, event);
        } catch (error) {
          try {
            console.error("[kitesurf] WebSocket on" + type + " threw:", error);
          } catch {}
        }
      }
      const listeners = this._listeners.get(type);
      if (listeners) {
        for (const listener of Array.from(listeners)) {
          try {
            listener.call(this, event);
          } catch (error) {
            try {
              console.error("[kitesurf] WebSocket listener threw:", error);
            } catch {}
          }
        }
      }
    }

    addEventListener(type: string, listener: AnyFn): void {
      if (typeof listener !== "function") return;
      let listeners = this._listeners.get(String(type));
      if (!listeners) {
        listeners = new Set();
        this._listeners.set(String(type), listeners);
      }
      listeners.add(listener);
    }

    removeEventListener(type: string, listener: AnyFn): void {
      this._listeners.get(String(type))?.delete(listener);
    }

    dispatchEvent(event: any): boolean {
      this._emit(String(event?.type ?? ""), event);
      return true;
    }

    send(data: unknown): void {
      if (this.readyState === CONNECTING) {
        throw new ksGlobal.DOMException(
          "WebSocket.send: still in CONNECTING state",
          "InvalidStateError",
        );
      }
      if (this.readyState !== OPEN || !this._socket) return;
      try {
        this._socket.send(data as Parameters<WebSocket["send"]>[0]);
      } catch (e) {
        try {
          console.warn("[kitesurf] WebSocket.send failed:", e);
        } catch {}
      }
    }

    close(code?: number, reason?: string): void {
      if (this.readyState === CLOSED || this.readyState === CLOSING) return;
      if (this.readyState === CONNECTING || !this._socket) {
        this._closeRequested = { code, reason };
        this.readyState = CLOSING;
        return;
      }
      this.readyState = CLOSING;
      try {
        this._socket.close(code ?? WEBSOCKET_NORMAL_CLOSURE_CODE, reason ?? "");
      } catch {
        this._finishClose(WEBSOCKET_ABNORMAL_CLOSURE_CODE, "", false);
      }
    }
  }

  for (const [k, v] of Object.entries({
    CONNECTING,
    OPEN,
    CLOSING,
    CLOSED,
  })) {
    (KsWebSocket.prototype as any)[k] = v;
  }
  try {
    Object.defineProperty(KsWebSocket, "name", { value: "WebSocket" });
  } catch {}
  ksGlobal.WebSocket = KsWebSocket;
}
