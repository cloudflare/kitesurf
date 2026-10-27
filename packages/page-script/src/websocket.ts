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

function pageBaseUri(): string | undefined {
  try {
    return ksGlobal.document?.baseURI;
  } catch {
    return undefined;
  }
}

function parseWebSocketUrl(raw: string): URL {
  try {
    return new URL(raw, pageBaseUri());
  } catch {
    throw new ksGlobal.DOMException(
      "WebSocket constructor: '" + raw + "' is not a valid URL.",
      "SyntaxError",
    );
  }
}

function normalizeWebSocketProtocol(parsed: URL): URL {
  if (parsed.protocol === "http:") parsed.protocol = "ws:";
  else if (parsed.protocol === "https:") parsed.protocol = "wss:";
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new ksGlobal.DOMException(
      "WebSocket constructor: scheme must be ws or wss, got '" + parsed.protocol + "'",
      "SyntaxError",
    );
  }
  return parsed;
}

function normalizedWebSocketUrl(url: unknown): URL {
  return normalizeWebSocketProtocol(parseWebSocketUrl(String(url ?? "")));
}

function webSocketFetchUrl(parsed: URL): string {
  const httpProtocol = parsed.protocol === "wss:" ? "https:" : "http:";
  return httpProtocol + parsed.toString().slice(parsed.protocol.length);
}

function protocolList(protocols: unknown): string {
  if (Array.isArray(protocols)) return protocols.map(String).join(", ");
  if (typeof protocols === "string" && protocols) return protocols;
  return "";
}

function isBlobLike(data: unknown): boolean {
  return (
    data !== null &&
    typeof data === "object" &&
    typeof (data as { arrayBuffer?: unknown }).arrayBuffer === "function" &&
    !(data instanceof ArrayBuffer) &&
    !ArrayBuffer.isView(data)
  );
}

function isTerminalState(readyState: number): boolean {
  return readyState === CLOSED || readyState === CLOSING;
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
      const parsed = normalizedWebSocketUrl(url);
      this.url = parsed.toString();
      void this._connect(webSocketFetchUrl(parsed), protocolList(protocols));
    }

    private async _connect(fetchUrl: string, protoList: string): Promise<void> {
      try {
        this._handleUpgradeResponse(await fetchWebSocketUpgrade(fetchUrl, protoList));
      } catch (err) {
        this._fail("WebSocket connect failed: " + ((err as any)?.message ?? String(err)));
      }
    }

    private _handleUpgradeResponse(response: Response | null | undefined): void {
      const socket = response?.webSocket ?? null;
      if (!socket) {
        this._fail(upgradeFailureMessage(response));
        return;
      }
      if (this._closeRequested) {
        this._closeBeforeOpen(socket);
        return;
      }
      this._attachSocket(response, socket);
    }

    private _closeBeforeOpen(socket: WebSocket): void {
      const requestedClose = this._closeRequested;
      if (!requestedClose) return;
      acceptSocket(socket);
      closeRequestedSocket(socket, requestedClose);
      this._finishClose(requestedCloseCode(requestedClose), "", true);
    }

    private _attachSocket(response: Response | null | undefined, socket: WebSocket): void {
      this._setProtocol(response);
      socket.accept();
      this._socket = socket;
      this._listenForMessages(socket);
      socket.addEventListener("close", (event) => this._handleSocketClose(event));
      socket.addEventListener("error", () => this._emit("error", mkEvent("error", {})));
      this.readyState = OPEN;
      this._emit("open", mkEvent("open", {}));
    }

    private _setProtocol(response: Response | null | undefined): void {
      this.protocol = readResponseProtocol(response);
    }

    private _listenForMessages(socket: WebSocket): void {
      let delivery: Promise<void> = Promise.resolve();
      socket.addEventListener("message", (event) => {
        const raw = event?.data;
        delivery = delivery.then(() => this._emitMessage(raw));
      });
    }

    private async _emitMessage(raw: unknown): Promise<void> {
      const { value: data } = await this._pageMessageData(raw);
      this._emit("message", mkEvent("message", { data, origin: this.url }));
    }

    private async _pageMessageData(raw: unknown): Promise<{ value: unknown }> {
      if (this.binaryType === "arraybuffer" && isBlobLike(raw)) {
        return { value: await this._readBlobLike(raw) };
      }
      if (this.binaryType === "blob" && raw instanceof ArrayBuffer) {
        return { value: this._wrapArrayBuffer(raw) };
      }
      return { value: raw };
    }

    private async _readBlobLike(data: unknown): Promise<unknown> {
      try {
        return await (data as { arrayBuffer: () => Promise<unknown> }).arrayBuffer();
      } catch {
        return data;
      }
    }

    private _wrapArrayBuffer(data: ArrayBuffer): unknown {
      const BlobConstructor = ksGlobal.Blob;
      if (typeof BlobConstructor !== "function") return data;
      return new BlobConstructor([data]);
    }

    private _handleSocketClose(event: any): void {
      this._finishClose(
        socketCloseCode(event),
        socketCloseReason(event),
        socketCloseIsClean(event),
      );
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
      this._sendOpenSocket(this._socket, data);
    }

    private _sendOpenSocket(socket: WebSocket, data: unknown): void {
      try {
        socket.send(data as Parameters<WebSocket["send"]>[0]);
      } catch (e) {
        try {
          console.warn("[kitesurf] WebSocket.send failed:", e);
        } catch {}
      }
    }

    close(code?: number, reason?: string): void {
      if (isTerminalState(this.readyState)) return;
      const socket = this._socket;
      if (this.readyState === CONNECTING || !socket) {
        this._closeRequested = { code, reason };
        this.readyState = CLOSING;
        return;
      }
      this._closeActiveSocket(socket, code, reason);
    }

    private _closeActiveSocket(socket: WebSocket, code?: number, reason?: string): void {
      this.readyState = CLOSING;
      try {
        socket.close(code ?? WEBSOCKET_NORMAL_CLOSURE_CODE, reason ?? "");
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

async function fetchWebSocketUpgrade(
  fetchUrl: string,
  protoList: string,
): Promise<Response | null | undefined> {
  const headers: Record<string, string> = { Upgrade: "websocket" };
  if (protoList) headers["Sec-WebSocket-Protocol"] = protoList;
  return (ksGlobal.fetch as typeof globalThis.fetch)(fetchUrl, { headers });
}

function upgradeFailureMessage(response: Response | null | undefined): string {
  return "WebSocket upgrade failed: HTTP " + (response?.status ?? "?");
}

function acceptSocket(socket: WebSocket): void {
  try {
    socket.accept();
  } catch {}
}

function requestedCloseCode(request: { code?: number }): number {
  return request.code ?? WEBSOCKET_NORMAL_CLOSURE_CODE;
}

function requestedCloseReason(request: { reason?: string }): string {
  return request.reason ?? "";
}

function closeRequestedSocket(
  socket: WebSocket,
  request: { code?: number; reason?: string },
): void {
  try {
    socket.close(requestedCloseCode(request), requestedCloseReason(request));
  } catch {}
}

function responseProtocolHeader(response: Response | null | undefined): string | null | undefined {
  return response?.headers?.get?.("sec-websocket-protocol");
}

function readResponseProtocol(response: Response | null | undefined): string {
  try {
    return String(responseProtocolHeader(response) ?? "") || "";
  } catch {
    return "";
  }
}

function socketCloseCode(event: any): number {
  return typeof event?.code === "number" ? event.code : WEBSOCKET_NO_STATUS_RECEIVED_CODE;
}

function socketCloseReason(event: any): string {
  return String(event?.reason ?? "");
}

function socketCloseIsClean(event: any): boolean {
  return event?.wasClean !== false;
}
