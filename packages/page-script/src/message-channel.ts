// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements page MessageChannel and MessagePort with a pure-JavaScript transport, so page JS
// never reaches the native port.
import type { ShimGlobal } from "./types.ts";

type PageStructuredClone = (value: unknown, options?: { transfer: ArrayBuffer[] }) => unknown;

export function installMessageChannel(
  ksGlobal: ShimGlobal,
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
      dispatchPortListeners(this._listeners.slice(), this, event);
      if (this._onmessage) dispatchPortListener(this._onmessage, this, event);
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
      queueTask(() => this._deliverQueued(data, ports));
    }
    _deliverQueued(data: unknown, ports: KsMessagePort[]): void {
      let target: any = this;
      while (target._transferredTo) target = target._transferredTo;
      if (target !== this) {
        target._enqueue(data, ports);
        return;
      }
      if (this._closed) return;
      this.dispatchEvent(createPortMessageEvent(data, ports, this));
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
      const transfer = transferListFrom(transferOrOptions);
      const { ports, buffers } = collectTransferables(transfer, this);
      const cloned = cloneMessageData(data, buffers);
      const outputPorts = ports.map((port) => port.__ksTransfer());
      if (this._closed || !this._other) return;
      this._other._enqueue(cloned, outputPorts);
    }
    close(): void {
      this._closed = true;
    }
  }

  function dispatchPortListeners(listeners: any[], port: KsMessagePort, event: any): void {
    for (const listener of listeners) dispatchPortListener(listener, port, event);
  }

  function dispatchPortListener(listener: any, port: KsMessagePort, event: any): void {
    try {
      listener.call(port, event);
    } catch (error) {
      try {
        console.error(error);
      } catch {}
    }
  }

  function createPortMessageEvent(
    data: unknown,
    ports: KsMessagePort[],
    target: KsMessagePort,
  ): object {
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
    definePortEventProperties(event, frozenPorts, target);
    return event;
  }

  function definePortEventProperties(
    event: object,
    ports: readonly KsMessagePort[],
    target: KsMessagePort,
  ): void {
    for (const [propertyName, propertyValue] of [
      ["ports", ports],
      ["target", target],
      ["currentTarget", target],
      ["srcElement", target],
    ] as Array<[string, any]>) {
      try {
        Object.defineProperty(event, propertyName, {
          value: propertyValue,
          configurable: true,
          enumerable: true,
        });
      } catch {}
    }
  }

  function transferListFrom(transferOptions: any): unknown[] {
    if (transferOptions === undefined || transferOptions === null) return [];
    return readPresentTransferList(transferOptions);
  }

  function readPresentTransferList(transferOptions: any): unknown[] {
    if (typeof transferOptions !== "object") throw new TypeError("Transfer list must be an object");
    if (isIterable(transferOptions)) return Array.from(transferOptions);
    const transferList = transferOptions.transfer;
    if (transferList === undefined) return [];
    return arrayFromTransferOption(transferList);
  }

  function isIterable(value: any): boolean {
    return typeof value[Symbol.iterator] === "function";
  }

  function arrayFromTransferOption(value: any): unknown[] {
    if (value === null || typeof value !== "object" || !isIterable(value)) {
      throw new TypeError("options.transfer must be a sequence");
    }
    return Array.from(value);
  }

  interface TransferableSet {
    ports: KsMessagePort[];
    buffers: ArrayBuffer[];
  }

  function collectTransferables(transfer: unknown[], source: KsMessagePort): TransferableSet {
    const seen = new Set<unknown>();
    const result: TransferableSet = { ports: [], buffers: [] };
    for (const transferable of transfer) {
      assertUniqueTransferable(transferable, source, seen);
      classifyTransferable(transferable, result);
    }
    return result;
  }

  function assertUniqueTransferable(
    transferable: unknown,
    source: KsMessagePort,
    seen: Set<unknown>,
  ): void {
    if (transferable === source) throw dataCloneError("The source port cannot be transferred");
    if (seen.has(transferable)) throw dataCloneError("Duplicate transferable in transfer list");
    seen.add(transferable);
  }

  function classifyTransferable(transferable: unknown, result: TransferableSet): void {
    if (transferable instanceof KsMessagePort) {
      addMessagePortTransfer(transferable, result.ports);
      return;
    }
    if (transferable instanceof (ksGlobal.ArrayBuffer as typeof ArrayBuffer)) {
      result.buffers.push(transferable);
      return;
    }
    throw dataCloneError("Value is not transferable");
  }

  function addMessagePortTransfer(port: KsMessagePort, ports: KsMessagePort[]): void {
    if (port._closed || port._detached) throw dataCloneError("MessagePort is already detached");
    ports.push(port);
  }

  function cloneMessageData(data: unknown, buffers: ArrayBuffer[]): unknown {
    if (canStructuredClone) return cloneWithStructuredClone(data, buffers);
    detachArrayBuffers(buffers);
    return data;
  }

  function cloneWithStructuredClone(data: unknown, buffers: ArrayBuffer[]): unknown {
    try {
      return buffers.length
        ? (ksGlobal.structuredClone as PageStructuredClone)(data, { transfer: buffers })
        : (ksGlobal.structuredClone as PageStructuredClone)(data);
    } catch (error: any) {
      throw normalizeDataCloneError(error);
    }
  }

  function normalizeDataCloneError(error: any): unknown {
    if (error && error.name === "DataCloneError") return error;
    return dataCloneError(String((error && error.message) || error));
  }

  function detachArrayBuffers(buffers: ArrayBuffer[]): void {
    for (const buffer of buffers) {
      if (typeof (buffer as any).transfer !== "function") continue;
      try {
        (buffer as any).transfer();
      } catch {}
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
