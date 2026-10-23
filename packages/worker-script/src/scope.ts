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

function listenerCallback(listener: unknown): Listener | null {
  if (isListener(listener)) {
    return listener;
  }
  if (!hasHandleEvent(listener)) return null;
  return function (event: unknown) {
    return listener.handleEvent(event);
  };
}

function listenerOptions(options: unknown): { once?: unknown; signal?: unknown } {
  return options && typeof options === "object" ? options : {};
}

function listenerSignal(options: { once?: unknown; signal?: unknown }): AbortSignal | undefined {
  return options.signal instanceof AbortSignal ? options.signal : undefined;
}

function listenerList(type: string): ListenerRecord[] {
  return listeners.get(type) ?? [];
}

function addAbortRemoval(signal: AbortSignal | undefined, type: string, listener: unknown): void {
  signal?.addEventListener?.("abort", () => removeListener(type, listener), { once: true });
}

function registerListener(
  type: string,
  listener: unknown,
  fn: Listener,
  opts: { once?: unknown; signal?: unknown },
): void {
  const signal = listenerSignal(opts);
  if (signal?.aborted) return;
  const list = listenerList(type);
  if (list.some((r) => r.src === listener)) return;
  const record: ListenerRecord = { fn, src: listener, once: !!opts.once, removed: false };
  list.push(record);
  listeners.set(type, list);
  addAbortRemoval(signal, type, listener);
}

function addListener(type: string, listener: unknown, options: unknown): void {
  const fn = listenerCallback(listener);
  if (!fn) return;
  registerListener(type, listener, fn, listenerOptions(options));
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

interface ScopeListenerCall {
  fn: Listener;
  record: ListenerRecord | null;
}

function scopeListeners(type: string, handler: Listener | null | undefined): ScopeListenerCall[] {
  const records = (listeners.get(type) ?? []).slice();
  const list: ScopeListenerCall[] = records.map((record) => ({ fn: record.fn, record }));
  if (handler) list.unshift({ fn: handler, record: null });
  return list;
}

function shouldDispatchRecord(type: string, record: ListenerRecord | null): boolean {
  if (!record) return true;
  if (record.removed) return false;
  if (record.once) removeListener(type, record.src);
  return true;
}

function isErrorEventHandler(
  type: string,
  event: Event,
  fn: Listener,
  handler: Listener | null | undefined,
): event is ErrorEventClass {
  return fn === handler && type === "error" && event instanceof ErrorEventClass;
}

function invokeErrorEventHandler(fn: Listener, event: ErrorEventClass): boolean {
  return (
    fn.call(scope, event.message, event.filename, event.lineno, event.colno, event.error) === true
  );
}

function invokeScopeListener(
  type: string,
  event: Event,
  fn: Listener,
  handler: Listener | null | undefined,
): boolean {
  try {
    if (isErrorEventHandler(type, event, fn, handler)) {
      return invokeErrorEventHandler(fn, event);
    }
    fn.call(scope, event);
  } catch (error) {
    if (type !== "error") reportException(error);
  }
  return false;
}

export function dispatchOnScope(type: string, event: Event): boolean {
  defineEventTarget(event);
  let handled = false;
  const handler = handlers.get(type);
  for (const { fn, record } of scopeListeners(type, handler)) {
    if (!shouldDispatchRecord(type, record)) continue;
    handled = invokeScopeListener(type, event, fn, handler) || handled;
  }
  return handled || event.defaultPrevented;
}

function errorText(value: unknown): string {
  return String(value ?? "");
}

function errorNumber(value: unknown): number {
  return Number(value ?? 0) | 0;
}

export class ErrorEventClass extends NativeEvent {
  message: string;
  filename: string;
  lineno: number;
  colno: number;
  error: unknown;
  constructor(type: string, init: Partial<WorkerErrorInfo> & { error?: unknown } = {}) {
    super(type, { cancelable: true });
    this.message = errorText(init.message);
    this.filename = errorText(init.filename);
    this.lineno = errorNumber(init.lineno);
    this.colno = errorNumber(init.colno);
    this.error = init.error;
  }
}

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

function errorName(errorObject: object): string {
  return String(("name" in errorObject ? errorObject.name : undefined) ?? "Error");
}

function errorMessage(errorObject: object | null, error: unknown): string {
  if (errorObject === null || !("message" in errorObject)) return `Uncaught ${String(error)}`;
  return `Uncaught ${errorName(errorObject)}: ${String(errorObject.message)}`;
}

function errorStack(errorObject: object | null): string {
  if (errorObject === null || !("stack" in errorObject)) return "";
  return typeof errorObject.stack === "string" ? errorObject.stack : "";
}

function workerErrorPosition(stack: string): { lineno: number; colno: number } {
  const match = /__ks_worker_script\.js:(\d+):(\d+)/.exec(stack);
  if (!match) return { lineno: 0, colno: 0 };
  return {
    lineno: Math.max(0, Number(match[1]) - SCRIPT_LINE_OFFSET),
    colno: Number(match[2]),
  };
}

export function errorInfo(error: unknown, scriptUrl: string): WorkerErrorInfo {
  const e = typeof error === "object" && error !== null ? error : null;
  const message = errorMessage(e, error);
  const { lineno, colno } = workerErrorPosition(errorStack(e));
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

function transferItems(options: unknown): unknown[] {
  if (options === undefined || options === null) return [];
  if (typeof options !== "object") throw new TypeError("Transfer list must be an object");
  if (isIterable(options)) return Array.from(options);
  return transferItemsFromOptions(options);
}

function transferItemsFromOptions(options: object): unknown[] {
  if (!("transfer" in options) || options.transfer === undefined) return [];
  const transfer = options.transfer;
  if (!isIterable(transfer)) throw new TypeError("Transfer list must be iterable");
  return Array.from(transfer);
}

function transferredBuffer(item: unknown): ArrayBuffer {
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
  return item;
}

function transferBuffers(items: unknown[]): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [];
  for (const item of items) buffers.push(transferredBuffer(item));
  return buffers;
}

function structuredCloneWithTransfers(message: unknown, buffers: ArrayBuffer[]): unknown {
  return buffers.length
    ? structuredClone(message, { transfer: buffers })
    : structuredClone(message);
}

export function cloneForPost(message: unknown, transferOrOptions?: unknown): unknown {
  const buffers = transferBuffers(transferItems(transferOrOptions));
  const data = structuredCloneWithTransfers(message, buffers);
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
  const nativeOrigin = performanceTimeOrigin(perf);
  const current = nativeNow();
  const startedAt = workerStartOffset(createdAt, nativeOrigin, current);
  const timeOrigin = nativeOrigin + startedAt;
  installPerformanceClock(perf, nativeNow, startedAt, timeOrigin);
}

function performanceTimeOrigin(perf: object): number {
  if (!("timeOrigin" in perf) || typeof perf.timeOrigin !== "number") return 0;
  return perf.timeOrigin;
}

function workerStartOffset(createdAt: number, nativeOrigin: number, current: number): number {
  const requested = Number.isFinite(createdAt) ? createdAt - nativeOrigin : current;
  return Math.min(requested, current);
}

function installPerformanceClock(
  perf: object,
  nativeNow: () => number,
  startedAt: number,
  timeOrigin: number,
): void {
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
