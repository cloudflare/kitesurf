// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Builds DedicatedWorkerGlobalScope APIs, message dispatch, and worker error events.

import type {
  WorkerErrorInfo,
  WorkerStartParams,
  WorkerUpstreamMessage,
} from "@kitesurf/jsrpc-types/dedicated-worker";
import { installMessageChannel } from "@kitesurf/page-script/message-channel";
import { holdsSharedMemory } from "@kitesurf/page-script/shared-memory";

type Listener = (this: unknown, ...args: unknown[]) => unknown;

function isListener(value: unknown): value is Listener {
  return typeof value === "function";
}

function hasHandleEvent(value: unknown): value is { handleEvent(event: unknown): unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "handleEvent" in value &&
    typeof value.handleEvent === "function"
  );
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    Symbol.iterator in value &&
    typeof value[Symbol.iterator] === "function"
  );
}

interface ScopeHooks {
  send(message: WorkerUpstreamMessage): void;
}

const scope: object = globalThis;
const NativeEvent = Event;
// Capture bound host methods before worker code can replace globals or lose their receiver.
const nativeAddEventListener = globalThis.addEventListener?.bind(globalThis);
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
const nativeSetInterval = globalThis.setInterval.bind(globalThis);

let hooks: ScopeHooks = { send: () => {} };
let closing = false;
let nameValue = "";

interface ListenerRecord {
  fn: Listener;
  src: unknown;
  once: boolean;
  removed: boolean;
}
const listeners = new Map<string, ListenerRecord[]>();
const handlers = new Map<string, Listener | null>();

function addListener(type: string, listener: unknown, options: unknown): void {
  let fn: Listener | null = null;
  if (isListener(listener)) {
    fn = listener;
  } else if (hasHandleEvent(listener)) {
    fn = function (event: unknown) {
      return listener.handleEvent(event);
    };
  }
  if (!fn) return;
  const opts: { once?: unknown; signal?: unknown } =
    options && typeof options === "object" ? options : {};
  const signal = opts.signal instanceof AbortSignal ? opts.signal : undefined;
  if (signal?.aborted) return;
  const list = listeners.get(type) ?? [];
  if (list.some((r) => r.src === listener)) return;
  const record: ListenerRecord = { fn, src: listener, once: !!opts.once, removed: false };
  list.push(record);
  listeners.set(type, list);
  signal?.addEventListener?.("abort", () => removeListener(type, listener), { once: true });
}

function removeListener(type: string, listener: unknown): void {
  const list = listeners.get(type);
  if (!list) return;
  const i = list.findIndex((r) => r.src === listener);
  const record = list[i];
  if (!record) return;
  record.removed = true;
  list.splice(i, 1);
}

function defineEventTarget(event: Event): void {
  for (const key of ["target", "currentTarget", "srcElement"]) {
    try {
      Object.defineProperty(event, key, { value: scope, configurable: true });
    } catch {}
  }
}

export function dispatchOnScope(type: string, event: Event): boolean {
  defineEventTarget(event);
  let handled = false;
  const handler = handlers.get(type);
  const records = (listeners.get(type) ?? []).slice();
  const list: Array<{ fn: Listener; record: ListenerRecord | null }> = records.map((record) => ({
    fn: record.fn,
    record,
  }));
  if (handler) list.unshift({ fn: handler, record: null });
  for (const { fn, record } of list) {
    if (record) {
      if (record.removed) continue;
      if (record.once) removeListener(type, record.src);
    }
    try {
      if (fn === handler && type === "error" && event instanceof ErrorEventClass) {
        if (
          fn.call(scope, event.message, event.filename, event.lineno, event.colno, event.error) ===
          true
        ) {
          handled = true;
        }
        continue;
      }
      fn.call(scope, event);
    } catch (error) {
      if (type !== "error") reportException(error);
    }
  }
  return handled || event.defaultPrevented;
}

export class ErrorEventClass extends NativeEvent {
  message: string;
  filename: string;
  lineno: number;
  colno: number;
  error: unknown;
  constructor(type: string, init: Partial<WorkerErrorInfo> & { error?: unknown } = {}) {
    super(type, { cancelable: true });
    this.message = String(init.message ?? "");
    this.filename = String(init.filename ?? "");
    this.lineno = Number(init.lineno ?? 0) | 0;
    this.colno = Number(init.colno ?? 0) | 0;
    this.error = init.error;
  }
}

// HTML's ImageData: `new ImageData(w, h)` or `new ImageData(data, w, h?)`.
export class ImageDataClass {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly colorSpace = "srgb";
  constructor(a: unknown, b: unknown, c?: unknown) {
    if (a instanceof Uint8ClampedArray) {
      const w = Number(b) >>> 0;
      if (w === 0 || a.length % 4 !== 0 || (a.length / 4) % w !== 0) {
        throw new DOMException(
          "The input data length is not a multiple of (4 * width).",
          "IndexSizeError",
        );
      }
      const h = c === undefined ? a.length / 4 / w : Number(c) >>> 0;
      if (h * w * 4 !== a.length) {
        throw new DOMException(
          "The input data length is not equal to (4 * width * height).",
          "IndexSizeError",
        );
      }
      this.data = a;
      this.width = w;
      this.height = h;
      return;
    }
    const w = Number(a) >>> 0;
    const h = Number(b) >>> 0;
    if (w === 0 || h === 0) {
      throw new DOMException("The source width and height must be non-zero.", "IndexSizeError");
    }
    this.data = new Uint8ClampedArray(w * h * 4);
    this.width = w;
    this.height = h;
  }
}
Object.defineProperty(ImageDataClass, "name", { value: "ImageData" });

export class MessageEventClass extends NativeEvent {
  data: unknown;
  origin: string;
  lastEventId: string;
  source: null;
  ports: readonly unknown[];
  constructor(type: string, init: { data?: unknown } = {}) {
    super(type);
    this.data = init.data;
    this.origin = "";
    this.lastEventId = "";
    this.source = null;
    this.ports = Object.freeze([]);
  }
}

export function errorInfo(error: unknown, scriptUrl: string): WorkerErrorInfo {
  const e = typeof error === "object" && error !== null ? error : null;
  const message =
    e && "message" in e
      ? `Uncaught ${String(("name" in e ? e.name : undefined) ?? "Error")}: ${String(e.message)}`
      : `Uncaught ${String(error)}`;
  let lineno = 0;
  let colno = 0;
  const stack = e && "stack" in e && typeof e.stack === "string" ? e.stack : "";
  const match = /__ks_worker_script\.js:(\d+):(\d+)/.exec(stack);
  if (match) {
    lineno = Math.max(0, Number(match[1]) - SCRIPT_LINE_OFFSET);
    colno = Number(match[2]);
  }
  return { message, filename: scriptUrl, lineno, colno };
}

export const SCRIPT_LINE_OFFSET = 3;

let scriptUrl = "";

export function reportException(error: unknown): void {
  const info = errorInfo(error, scriptUrl);
  const event = new ErrorEventClass("error", { ...info, error });
  const handled = dispatchOnScope("error", event);
  if (!handled) {
    try {
      console.error(info.message);
    } catch {}
    hooks.send({ event: "worker.error", params: info });
  }
}

export function isClosing(): boolean {
  return closing;
}

function workerPostMessage(message: unknown, transferOrOptions?: unknown): void {
  if (arguments.length === 0) {
    throw new TypeError(
      "Failed to execute 'postMessage' on 'DedicatedWorkerGlobalScope': 1 argument required, but only 0 present.",
    );
  }
  const data = cloneForPost(message, transferOrOptions);
  hooks.send({ event: "worker.message", params: { data } });
}

export function cloneForPost(message: unknown, transferOrOptions?: unknown): unknown {
  let transfer: unknown[] = [];
  if (transferOrOptions !== undefined && transferOrOptions !== null) {
    if (typeof transferOrOptions !== "object") {
      throw new TypeError("Transfer list must be an object");
    }
    if (isIterable(transferOrOptions)) {
      transfer = Array.from(transferOrOptions);
    } else if ("transfer" in transferOrOptions && transferOrOptions.transfer !== undefined) {
      const list = transferOrOptions.transfer;
      if (!isIterable(list)) throw new TypeError("Transfer list must be iterable");
      transfer = Array.from(list);
    }
  }
  const buffers: ArrayBuffer[] = [];
  for (const item of transfer) {
    if ((typeof item !== "object" && typeof item !== "function") || item === null) {
      throw new TypeError(
        "Failed to execute 'postMessage' on 'DedicatedWorkerGlobalScope': Transfer list items must be objects",
      );
    }
    if (!(item instanceof ArrayBuffer)) {
      throw new DOMException(
        "Only ArrayBuffers can be transferred to or from a worker",
        "DataCloneError",
      );
    }
    buffers.push(item);
  }
  const data = buffers.length
    ? structuredClone(message, { transfer: buffers })
    : structuredClone(message);
  if (holdsSharedMemory(data)) {
    throw new DOMException(
      "Failed to execute 'postMessage' on 'DedicatedWorkerGlobalScope': SharedArrayBuffer transfer requires self.crossOriginIsolated.",
      "DataCloneError",
    );
  }
  return data;
}

function workerClose(): void {
  if (closing) return;
  closing = true;
  // Announce closure on a later native task so earlier posts can reach the creator.
  queueMicrotask(() => {
    nativeSetTimeout(() => hooks.send({ event: "worker.closed", params: {} }), 0);
  });
}

function importScripts(...urls: unknown[]): void {
  if (urls.length === 0) return;
  throw new DOMException(
    `Failed to execute 'importScripts' on 'WorkerGlobalScope': ` +
      `Kitesurf cannot load scripts synchronously (${String(urls[0])}).`,
    "NetworkError",
  );
}

function defineValue(key: string, value: unknown, writable = true): void {
  Object.defineProperty(scope, key, { value, writable, configurable: true, enumerable: true });
}

function defineHandler(type: string): void {
  Object.defineProperty(scope, "on" + type, {
    configurable: true,
    enumerable: true,
    get: () => handlers.get(type) ?? null,
    set: (fn: unknown) => {
      handlers.set(type, isListener(fn) ? fn : null);
    },
  });
}

function workerLocation(url: string): Record<string, unknown> {
  const u = new URL(url);
  const loc: Record<string, unknown> = {
    href: u.href,
    origin: u.origin,
    protocol: u.protocol,
    host: u.host,
    hostname: u.hostname,
    port: u.port,
    pathname: u.pathname,
    search: u.search,
    hash: u.hash,
    toString: () => u.href,
  };
  Object.defineProperty(loc, Symbol.toStringTag, { value: "WorkerLocation" });
  return Object.freeze(loc);
}

export function installScope(params: WorkerStartParams, send: ScopeHooks["send"]): void {
  hooks = { send };
  scriptUrl = params.url;
  nameValue = params.name;
  defineValue("self", scope);
  defineValue("name", nameValue);
  defineValue("postMessage", workerPostMessage);
  defineValue("close", workerClose);
  defineValue("importScripts", importScripts);
  defineValue("location", workerLocation(params.url), false);
  const nav = {
    userAgent: params.navigator.userAgent,
    language: params.navigator.language,
    languages: Object.freeze(params.navigator.languages.slice()),
    platform: params.navigator.platform,
    onLine: true,
    hardwareConcurrency: 1,
    appName: "Netscape",
    appVersion: params.navigator.userAgent.replace(/^Mozilla\//, ""),
    product: "Gecko",
  };
  Object.defineProperty(nav, Symbol.toStringTag, { value: "WorkerNavigator" });
  defineValue("navigator", Object.freeze(nav), false);
  defineValue("addEventListener", (type: string, l: unknown, options?: unknown) =>
    addListener(String(type), l, options),
  );
  defineValue("removeEventListener", (type: string, l: unknown) => removeListener(String(type), l));
  defineValue("dispatchEvent", (event: Event) => {
    dispatchOnScope(event.type, event);
    return !event.defaultPrevented;
  });
  for (const type of [
    "message",
    "messageerror",
    "error",
    "rejectionhandled",
    "unhandledrejection",
  ]) {
    defineHandler(type);
  }
  defineValue("ErrorEvent", ErrorEventClass);
  defineValue("MessageEvent", MessageEventClass);
  // workerd has no ImageData. MapLibre's worker serializer tests
  // `x instanceof ImageData` without a typeof guard, so every reply failed.
  if (!("ImageData" in scope)) defineValue("ImageData", ImageDataClass);
  const workerGlobalScope = illegalConstructor("WorkerGlobalScope");
  const dedicatedWorkerGlobalScope = illegalConstructor("DedicatedWorkerGlobalScope");
  Object.setPrototypeOf(dedicatedWorkerGlobalScope.prototype, workerGlobalScope.prototype);
  defineValue("WorkerGlobalScope", workerGlobalScope);
  defineValue("DedicatedWorkerGlobalScope", dedicatedWorkerGlobalScope);
  installWorkerClock(params.timeOrigin);
  installUncaughtReporting();
  installMessageChannel(scope, () => MessageEventClass);
}

function illegalConstructor(name: string): { prototype: object } {
  const cls = class {
    constructor() {
      throw new TypeError("Illegal constructor");
    }
  };
  Object.defineProperty(cls, "name", { value: name });
  Object.defineProperty(cls, Symbol.hasInstance, { value: (v: unknown) => v === scope });
  return cls;
}

function installWorkerClock(createdAt: number): void {
  const perf: unknown = Reflect.get(globalThis, "performance");
  if (typeof perf !== "object" || perf === null || !("now" in perf)) return;
  const nowFn = perf.now;
  if (typeof nowFn !== "function") return;
  const nativeNow = (): number => Number(Reflect.apply(nowFn, perf, []));
  const nativeOrigin =
    "timeOrigin" in perf && typeof perf.timeOrigin === "number" ? perf.timeOrigin : 0;
  const current = nativeNow();
  const requested = Number.isFinite(createdAt) ? createdAt - nativeOrigin : current;
  const startedAt = Math.min(requested, current);
  const timeOrigin = nativeOrigin + startedAt;
  try {
    Object.defineProperty(perf, "now", {
      value: function now() {
        return nativeNow() - startedAt;
      },
      writable: true,
      configurable: true,
      enumerable: true,
    });
    Object.defineProperty(perf, "timeOrigin", {
      get: () => timeOrigin,
      configurable: true,
      enumerable: true,
    });
  } catch (error) {
    console.debug("[kitesurf-worker] could not move performance's time origin:", error);
  }
}

function installUncaughtReporting(): void {
  const wrap = (cb: unknown): unknown => {
    if (typeof cb !== "function") return cb;
    return function (this: unknown, ...args: unknown[]) {
      if (closing) return;
      try {
        return Reflect.apply(cb, this, args);
      } catch (error) {
        reportException(error);
      }
    };
  };
  defineValue(
    "setTimeout",
    function setTimeout(cb: unknown, ms?: number, ...args: unknown[]): unknown {
      return Reflect.apply(nativeSetTimeout, globalThis, [wrap(cb), ms, ...args]);
    },
  );
  defineValue(
    "setInterval",
    function setInterval(cb: unknown, ms?: number, ...args: unknown[]): unknown {
      return Reflect.apply(nativeSetInterval, globalThis, [wrap(cb), ms, ...args]);
    },
  );
  try {
    nativeAddEventListener?.("unhandledrejection", (native: Event) => {
      const event = new NativeEvent("unhandledrejection", { cancelable: true });
      Object.defineProperty(event, "reason", {
        value: "reason" in native ? native.reason : undefined,
      });
      Object.defineProperty(event, "promise", {
        value: "promise" in native ? native.promise : undefined,
      });
      const handled = dispatchOnScope("unhandledrejection", event);
      if (handled) native.preventDefault();
    });
  } catch (error) {
    console.debug("[kitesurf-worker] could not listen for unhandledrejection:", error);
  }
}

export function deliverToScope(data: unknown): void {
  if (closing) return;
  dispatchOnScope("message", new MessageEventClass("message", { data }));
}
