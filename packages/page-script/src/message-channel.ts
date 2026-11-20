// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements page MessageChannel and MessagePort with a pure-JavaScript transport, so page JS
// never reaches the native port.
// The realm global the ports install into: the page's globalThis or a dedicated worker's scope.
// The two share no typed shape, so this stays an arbitrary-key view.
type RealmGlobal = Record<PropertyKey, any>;

type PageStructuredClone = (value: unknown, options?: { transfer: ArrayBuffer[] }) => unknown;

export function installMessageChannel(
  ksGlobal: RealmGlobal,
  pageMessageEventCtor: () => unknown,
  queueTask: (task: () => void) => void = (task) => {
    setTimeout(task, 0);
  },
): void {
  type QueuedMessage = { data: unknown; ports: KsMessagePort[] };
  type PageMessageEventConstructor = new (
    type: string,
    init: { data: unknown; ports: readonly KsMessagePort[] },
  ) => object;

  const canStructuredClone = typeof ksGlobal.structuredClone === "function";
  const dataCloneError = (message: string) => {
    try {
      return new (ksGlobal.DOMException as typeof DOMException)(message, "DataCloneError");
    } catch {
      const error = new Error(message);
      error.name = "DataCloneError";
      return error;
    }
  };
  const EventTargetConstructor: typeof EventTarget = ksGlobal.EventTarget;
  const MessageEventConstructor: unknown = ksGlobal.MessageEvent;
  const PORT_TOKEN = Symbol("kitesurf-port-token");
  class KsMessagePort extends EventTargetConstructor {
    _other: KsMessagePort | null = null;
    _queue: QueuedMessage[] = [];
    _listeners: any[] = [];
    _started = false;
    _closed = false;
    _detached = false;
    _transferredTo: KsMessagePort | null = null;
    _onmessage: any = null;
    constructor(token?: any) {
      super();
      if (token !== PORT_TOKEN) throw new TypeError("Illegal constructor");
    }
    get onmessage(): any {
      return this._onmessage;
    }
    set onmessage(handler: any) {
      this._onmessage = typeof handler === "function" ? handler : null;
      this.start();
    }
    addEventListener(type: string, listener: any): void {
      if (type !== "message" || typeof listener !== "function") return;
      if (this._listeners.indexOf(listener) === -1) this._listeners.push(listener);
    }
    removeEventListener(type: string, listener: any): void {
      if (type !== "message") return;
      const listenerIndex = this._listeners.indexOf(listener);
      if (listenerIndex !== -1) this._listeners.splice(listenerIndex, 1);
    }
    dispatchEvent(event: any): boolean {
      for (const listener of this._listeners.slice()) {
        try {
          listener.call(this, event);
        } catch (error) {
          try {
            console.error(error);
          } catch {}
        }
      }
      if (this._onmessage) {
        try {
          this._onmessage.call(this, event);
        } catch (error) {
          try {
            console.error(error);
          } catch {}
        }
      }
      return true;
    }
    start(): void {
      if (this._started) return;
      this._started = true;
      while (this._queue.length) {
        const queuedMessage = this._queue.shift()!;
        this._deliver(queuedMessage.data, queuedMessage.ports);
      }
    }
    _deliver(data: unknown, ports: KsMessagePort[] = []): void {
      queueTask(() => {
        let target: any = this;
        while (target._transferredTo) target = target._transferredTo;
        if (target !== this) {
          target._enqueue(data, ports);
          return;
        }
        if (this._closed) return;
        const pageMessageEvent: unknown =
          pageMessageEventCtor() || ksGlobal.MessageEvent || MessageEventConstructor;
        const frozenPorts = Object.freeze(ports.slice());
        let event: object;
        try {
          event = new (pageMessageEvent as PageMessageEventConstructor)("message", {
            data,
            ports: frozenPorts,
          });
        } catch {
          event = { type: "message", data };
        }
        for (const [propertyName, propertyValue] of [
          ["ports", frozenPorts],
          ["target", this],
          ["currentTarget", this],
          ["srcElement", this],
        ] as Array<[string, any]>) {
          try {
            Object.defineProperty(event, propertyName, {
              value: propertyValue,
              configurable: true,
              enumerable: true,
            });
          } catch {}
        }
        this.dispatchEvent(event);
      });
    }
    _enqueue(data: unknown, ports: KsMessagePort[] = []): void {
      if (this._closed) return;
      if (!this._started) {
        this._queue.push({ data, ports });
        return;
      }
      this._deliver(data, ports);
    }
    __ksTransfer(): KsMessagePort {
      const receivingPort = new KsMessagePort(PORT_TOKEN);
      receivingPort._queue = this._queue;
      const peer = this._other;
      if (peer && !this._closed) {
        receivingPort._other = peer;
        peer._other = receivingPort;
      }
      this._detached = true;
      this._closed = true;
      this._transferredTo = receivingPort;
      this._other = null;
      this._queue = [];
      return receivingPort;
    }
    postMessage(data?: unknown, transferOrOptions?: any): void {
      if (arguments.length === 0) {
        throw new TypeError(
          "Failed to execute 'postMessage' on 'MessagePort': 1 argument required, but only 0 present.",
        );
      }
      let transfer: unknown[] = [];
      const transferOptions = transferOrOptions;
      if (transferOptions !== undefined && transferOptions !== null) {
        if (typeof transferOptions !== "object") {
          throw new TypeError("Transfer list must be an object");
        }
        if (typeof transferOptions[Symbol.iterator] === "function") {
          transfer = Array.from(transferOptions);
        } else if (transferOptions.transfer !== undefined) {
          const transferList = transferOptions.transfer;
          if (
            transferList === null ||
            typeof transferList !== "object" ||
            typeof transferList[Symbol.iterator] !== "function"
          ) {
            throw new TypeError("options.transfer must be a sequence");
          }
          transfer = Array.from(transferList);
        }
      }
      const seen = new Set<unknown>();
      const portsToTransfer: KsMessagePort[] = [];
      const buffers: ArrayBuffer[] = [];
      for (const transferable of transfer) {
        if (transferable === this) throw dataCloneError("The source port cannot be transferred");
        if (seen.has(transferable)) throw dataCloneError("Duplicate transferable in transfer list");
        seen.add(transferable);
        if (transferable instanceof KsMessagePort) {
          if (transferable._closed || transferable._detached)
            throw dataCloneError("MessagePort is already detached");
          portsToTransfer.push(transferable);
        } else if (transferable instanceof (ksGlobal.ArrayBuffer as typeof ArrayBuffer)) {
          buffers.push(transferable);
        } else {
          throw dataCloneError("Value is not transferable");
        }
      }
      let cloned: unknown = data;
      if (canStructuredClone) {
        try {
          cloned = buffers.length
            ? (ksGlobal.structuredClone as PageStructuredClone)(data, { transfer: buffers })
            : (ksGlobal.structuredClone as PageStructuredClone)(data);
        } catch (error: any) {
          throw error && error.name === "DataCloneError"
            ? error
            : dataCloneError(String((error && error.message) || error));
        }
      } else {
        for (const buffer of buffers) {
          if (typeof (buffer as any).transfer === "function") {
            try {
              (buffer as any).transfer();
            } catch {}
          }
        }
      }
      const outputPorts = portsToTransfer.map((port) => port.__ksTransfer());
      if (this._closed || !this._other) return;
      this._other._enqueue(cloned, outputPorts);
    }
    close(): void {
      this._closed = true;
    }
  }
  class KsMessageChannel {
    port1: KsMessagePort;
    port2: KsMessagePort;
    constructor() {
      this.port1 = new KsMessagePort(PORT_TOKEN);
      this.port2 = new KsMessagePort(PORT_TOKEN);
      this.port1._other = this.port2;
      this.port2._other = this.port1;
    }
  }
  ksGlobal.MessageChannel = KsMessageChannel;
  ksGlobal.MessagePort = KsMessagePort;
}
