// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements the page-side Worker API and relays worker lifecycle events.
// Every worker URL, including blob: and data:, passes the inserted-script CSP gate; blob: sources
// are read here because no other isolate can resolve them.

import type { WorkerEventParams } from "@kitesurf/jsrpc-types/dedicated-worker";
import { sendUpstreamEvent } from "./internal-state.js";
import { fetchInsertedScript } from "./resource-fetch.ts";
import {
  insertedResponseAllowed,
  insertedScriptAllowed,
  reportBlocked,
  reportOnly,
} from "./script-policy.ts";
import type { InsertedScriptMetadata } from "./script-policy.ts";
import { holdsSharedMemory } from "./shared-memory.ts";
import { ksEventCtors, ksGlobal, state } from "./state.ts";
import { trustedFetch } from "./trusted-fetch.ts";

type WorkerMessageParams = Extract<WorkerEventParams, { type: "message" }>;
type WorkerErrorParams = Extract<WorkerEventParams, { type: "error" }>;

type ListenerFn = (this: unknown, event: Event) => unknown;
type Listener = { fn: ListenerFn; once: boolean; src: unknown };

type MessageEventCtor = new (type: string, init: { data: unknown; origin: string }) => Event;
type ErrorEventCtor = new (
  type: string,
  init: { message: string; filename: string; lineno: number; colno: number; cancelable: boolean },
) => Event;

function isIterable(value: unknown): value is Iterable<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    Symbol.iterator in value &&
    typeof value[Symbol.iterator] === "function"
  );
}

function isListenerFn(value: unknown): value is ListenerFn {
  return typeof value === "function";
}

function hasHandleEvent(value: unknown): value is { handleEvent(event: Event): unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "handleEvent" in value &&
    typeof value.handleEvent === "function"
  );
}

interface WorkerOptions {
  type?: unknown;
  name?: unknown;
}

function workerOptions(options: unknown): WorkerOptions {
  return options && typeof options === "object" ? options : {};
}

function requireWorkerArgument(argumentCount: number): void {
  if (argumentCount === 0) {
    throw new TypeError("Failed to construct 'Worker': 1 argument required, but only 0 present.");
  }
}

function requireClassicWorker(options: WorkerOptions): void {
  if (options.type !== undefined && String(options.type) === "module") {
    throw domException(
      "Failed to construct 'Worker': Kitesurf does not support module workers yet.",
      "NotSupportedError",
    );
  }
}

const live = new Map<number, KsWorkerState>();
let nextWorkerId = 1;

interface KsWorkerState {
  id: number;
  owner: object;
  queue: unknown[];
  created: boolean;
  done: boolean;
  listeners: Map<string, Listener[]>;
  handlers: Map<string, ListenerFn | null>;
}

function domException(message: string, name: string): Error {
  try {
    return new ksGlobal.DOMException(message, name);
  } catch {
    const error = new Error(message);
    error.name = name;
    return error;
  }
}

function documentOrigin(): string {
  try {
    const origin = new URL(state.pageUrl).origin;
    return origin === "null" ? "null" : origin;
  } catch {
    return "null";
  }
}

function documentBase(): string {
  try {
    const base = ksGlobal.document?.baseURI;
    if (typeof base === "string" && base) return base;
  } catch {}
  return state.pageUrl;
}

function cloneForWorker(message: unknown, transferOrOptions: unknown): unknown {
  const transfer = transferItems(transferOrOptions);
  validateTransferItems(transfer);
  const clone: (value: unknown, options?: { transfer: unknown[] }) => unknown =
    ksGlobal.structuredClone;
  const data = transfer.length ? clone(message, { transfer }) : clone(message);
  if (holdsSharedMemory(data)) {
    throw domException(
      "Failed to execute 'postMessage' on 'Worker': SharedArrayBuffer transfer requires self.crossOriginIsolated.",
      "DataCloneError",
    );
  }
  return data;
}

function transferItems(transferOrOptions: unknown): unknown[] {
  if (transferOrOptions === undefined || transferOrOptions === null) return [];
  if (typeof transferOrOptions !== "object") {
    throw new TypeError("Transfer list must be an object");
  }
  if (isIterable(transferOrOptions)) return Array.from(transferOrOptions);
  return transferItemsFromOptions(transferOrOptions);
}

function transferItemsFromOptions(options: object): unknown[] {
  if (!("transfer" in options) || options.transfer === undefined) return [];
  const transfer = options.transfer;
  if (!isIterable(transfer)) throw new TypeError("Transfer list must be iterable");
  return Array.from(transfer);
}

function isTransferObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function validateTransferItems(transfer: unknown[]): void {
  const seen = new Set<unknown>();
  for (const item of transfer) {
    if (!isTransferObject(item)) {
      throw new TypeError(
        "Failed to execute 'postMessage' on 'Worker': Transfer list items must be objects",
      );
    }
    if (seen.has(item))
      throw domException("Duplicate transferable in transfer list", "DataCloneError");
    seen.add(item);
    if (!(item instanceof ksGlobal.ArrayBuffer)) {
      throw domException("Kitesurf can only transfer ArrayBuffers to a worker", "DataCloneError");
    }
  }
}

async function loadSource(url: string): Promise<string> {
  const meta = { url };
  const pre = await checkWorkerScriptPolicy(meta);
  return workerSourceForUrl(meta, pre);
}

type WorkerScriptMetadata = InsertedScriptMetadata & { url: string };

async function checkWorkerScriptPolicy(
  meta: WorkerScriptMetadata,
): Promise<Awaited<ReturnType<typeof insertedScriptAllowed>>> {
  const pre = await insertedScriptAllowed(meta);
  reportOnly(pre);
  if (!pre.allowed) {
    reportBlocked(pre);
    throw new Error(pre.reason ?? "blocked by policy");
  }
  return pre;
}

async function workerSourceForUrl(
  meta: WorkerScriptMetadata,
  pre: Awaited<ReturnType<typeof insertedScriptAllowed>>,
): Promise<string> {
  const url = meta.url;
  if (url.startsWith("blob:")) {
    const blob = state.blobUrls.get(url);
    if (!blob) throw new Error("blob URL is not registered (revoked?)");
    return await blob.text();
  }
  if (url.startsWith("data:")) {
    const response = await trustedFetch(url);
    if (!response.ok) throw new Error(`data: URL failed to load`);
    return await response.text();
  }
  return fetchWorkerSource(meta, pre);
}

async function fetchWorkerSource(
  meta: WorkerScriptMetadata,
  pre: Awaited<ReturnType<typeof insertedScriptAllowed>>,
): Promise<string> {
  const url = meta.url;
  const response = await fetchInsertedScript(pre.upgradeTo ?? url, "");
  requireSuccessfulWorkerResponse(response);
  await requireWorkerResponsePolicy(meta, response);
  return response.source;
}

function requireSuccessfulWorkerResponse(
  response: Awaited<ReturnType<typeof fetchInsertedScript>>,
): void {
  if (response.status === 0) throw new Error("fetch failed");
  if (response.status >= 400) throw new Error(`HTTP ${response.status}`);
}

async function requireWorkerResponsePolicy(
  meta: WorkerScriptMetadata,
  response: Awaited<ReturnType<typeof fetchInsertedScript>>,
): Promise<void> {
  const post = await insertedResponseAllowed(meta, {
    contentType: response.contentType,
    contentTypeOptions: response.nosniff,
    bytes: response.bytes,
    opaque: response.opaque,
  });
  if (!post.allowed) {
    reportBlocked(post);
    throw new Error(post.reason ?? "blocked by policy");
  }
}

let WorkerClass: unknown = null;

export function installWorker(): void {
  WorkerClass ??= buildWorkerClass();
  Object.defineProperty(globalThis, "Worker", {
    value: WorkerClass,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

function buildWorkerClass(): unknown {
  const EventTargetBase: typeof EventTarget = ksGlobal.EventTarget;
  const STATE = Symbol("kitesurf-worker-state");

  class Worker extends EventTargetBase {
    declare [STATE]: KsWorkerState;

    constructor(scriptURL: unknown, options?: unknown) {
      super();
      requireWorkerArgument(arguments.length);
      const opts = workerOptions(options);
      requireClassicWorker(opts);
      const url = resolveWorkerUrl(scriptURL);
      const href = url.href;
      const origin = documentOrigin();
      requireWorkerOrigin(url, href, origin);
      const id = nextWorkerId++;
      const ws: KsWorkerState = {
        id,
        owner: this,
        queue: [],
        created: false,
        done: false,
        listeners: new Map(),
        handlers: new Map(),
      };
      Object.defineProperty(this, STATE, { value: ws });
      live.set(id, ws);
      const name = opts.name === undefined ? "" : String(opts.name);
      startWorkerLoad(ws, href, name, workerNavigatorInfo());
    }

    postMessage(message?: unknown, transferOrOptions?: unknown): void {
      if (arguments.length === 0) {
        throw new TypeError(
          "Failed to execute 'postMessage' on 'Worker': 1 argument required, but only 0 present.",
        );
      }
      const ws = this[STATE];
      const data = cloneForWorker(message, transferOrOptions);
      if (ws.done) return;
      if (!ws.created) {
        ws.queue.push(data);
        return;
      }
      sendUpstreamEvent({ event: "kitesurf.workerPostMessage", params: { workerId: ws.id, data } });
    }

    terminate(): void {
      const ws = this[STATE];
      if (ws.done) return;
      const wasCreated = ws.created;
      finish(ws);
      if (wasCreated) {
        sendUpstreamEvent({ event: "kitesurf.workerTerminate", params: { workerId: ws.id } });
      }
    }

    addEventListener(type: unknown, listener: unknown, options?: unknown): void {
      const fn = listenerFunction(listener);
      if (!fn) return;
      const once = listenerOnce(options);
      const ws = this[STATE];
      const key = String(type);
      addWorkerListener(ws, key, listener, fn, once);
    }

    removeEventListener(type: unknown, listener: unknown): void {
      removeListener(this[STATE], String(type), listener);
    }

    dispatchEvent(event: Event): boolean {
      dispatch(this[STATE], event);
      return !event.defaultPrevented;
    }
  }

  for (const type of ["message", "error", "messageerror"]) {
    Object.defineProperty(Worker.prototype, "on" + type, {
      configurable: true,
      enumerable: true,
      get(this: Worker) {
        return this[STATE].handlers.get(type) ?? null;
      },
      set(this: Worker, fn: unknown) {
        this[STATE].handlers.set(type, isListenerFn(fn) ? fn : null);
      },
    });
  }

  function removeListener(ws: KsWorkerState, type: string, listener: unknown): void {
    const list = ws.listeners.get(type);
    if (!list) return;
    const i = list.findIndex((l) => l.src === listener);
    if (i >= 0) list.splice(i, 1);
  }

  function finish(ws: KsWorkerState): void {
    ws.done = true;
    ws.queue = [];
    live.delete(ws.id);
  }

  function dispatch(ws: KsWorkerState, event: Event): void {
    const worker = ws.owner;
    setWorkerEventTargets(event, worker);
    const type = String(event.type);
    const handler = ws.handlers.get(type);
    dispatchWorkerListeners(ws, type, worker, event);
    dispatchWorkerHandler(handler, worker, event);
  }

  function setWorkerEventTargets(event: Event, worker: object): void {
    for (const key of ["target", "currentTarget", "srcElement"]) {
      try {
        Object.defineProperty(event, key, { value: worker, configurable: true, enumerable: true });
      } catch {}
    }
  }

  function dispatchWorkerListeners(
    ws: KsWorkerState,
    type: string,
    worker: object,
    event: Event,
  ): void {
    const list = (ws.listeners.get(type) ?? []).slice();
    for (const l of list) {
      if (l.once) removeListener(ws, type, l.src);
      try {
        l.fn.call(worker, event);
      } catch (error) {
        reportListenerError(error);
      }
    }
  }

  function dispatchWorkerHandler(
    handler: ListenerFn | null | undefined,
    worker: object,
    event: Event,
  ): void {
    if (!handler) return;
    try {
      handler.call(worker, event);
    } catch (error) {
      reportListenerError(error);
    }
  }

  function reportListenerError(error: unknown): void {
    try {
      console.error(error);
    } catch {}
  }

  function startWorkerLoad(
    ws: KsWorkerState,
    href: string,
    name: string,
    navigatorInfo: WorkerNavigatorInfo,
  ): void {
    void loadSource(href).then(
      (source) => announceWorker(ws, href, name, source, navigatorInfo),
      (error: unknown) => failWorkerLoad(ws, href, error),
    );
  }

  function announceWorker(
    ws: KsWorkerState,
    href: string,
    name: string,
    source: string,
    navigatorInfo: WorkerNavigatorInfo,
  ): void {
    if (ws.done) return;
    sendUpstreamEvent({
      event: "kitesurf.workerCreate",
      params: { workerId: ws.id, url: href, name, source, navigator: navigatorInfo },
    });
    ws.created = true;
    for (const data of ws.queue) {
      sendUpstreamEvent({
        event: "kitesurf.workerPostMessage",
        params: { workerId: ws.id, data },
      });
    }
    ws.queue = [];
  }

  function failWorkerLoad(ws: KsWorkerState, href: string, error: unknown): void {
    if (ws.done) return;
    try {
      console.error(
        `Failed to load worker script at '${href}': ` +
          (error instanceof Error ? error.message : String(error)),
      );
    } catch {}
    finish(ws);
    dispatch(ws, new ksEventCtors.Event("error"));
  }

  function deliverMessage(ws: KsWorkerState, params: WorkerMessageParams): void {
    const Ctor: MessageEventCtor = ksEventCtors.MessageEvent || ksGlobal.MessageEvent;
    const event = new Ctor("message", { data: params.data, origin: "" });
    if (params.data === undefined) {
      try {
        Object.defineProperty(event, "data", {
          value: undefined,
          configurable: true,
          enumerable: true,
        });
      } catch {}
    }
    dispatch(ws, event);
  }

  function createWorkerErrorEvent(params: WorkerErrorParams): Event {
    const Ctor: ErrorEventCtor = ksEventCtors.ErrorEvent || ksGlobal.ErrorEvent;
    const init = {
      message: params.message,
      filename: params.filename,
      lineno: params.lineno,
      colno: params.colno,
      cancelable: true,
    };
    try {
      return new Ctor("error", init);
    } catch {
      return Object.assign(new ksEventCtors.Event("error", { cancelable: true }), init);
    }
  }

  function deliverWorkerError(ws: KsWorkerState, params: WorkerErrorParams): void {
    const event = createWorkerErrorEvent(params);
    dispatch(ws, event);
    reportUnhandledWorkerError(event, params.message);
  }

  function reportUnhandledWorkerError(event: Event, message: string): void {
    if (event.defaultPrevented) return;
    try {
      console.error(message || "Uncaught error in worker");
    } catch {}
  }

  function deliverLoadError(ws: KsWorkerState): void {
    finish(ws);
    dispatch(ws, new ksEventCtors.Event("error"));
  }

  function deliverClosed(ws: KsWorkerState): void {
    finish(ws);
  }

  function dispatchWorkerEvent(ws: KsWorkerState, params: WorkerEventParams): void {
    if (params.type === "message") {
      deliverMessage(ws, params);
    } else if (params.type === "error") {
      deliverWorkerError(ws, params);
    } else if (params.type === "loadError") {
      deliverLoadError(ws);
    } else if (params.type === "closed") {
      deliverClosed(ws);
    }
  }

  deliverWorkerEventImpl = (params: WorkerEventParams) => {
    const ws = live.get(Number(params?.workerId));
    if (!ws || ws.done) return;
    dispatchWorkerEvent(ws, params);
  };

  Object.defineProperty(Worker, "name", { value: "Worker", configurable: true });
  Object.defineProperty(Worker, "length", { value: 1, configurable: true });
  Object.defineProperty(Worker.prototype.postMessage, "length", { value: 1, configurable: true });
  for (const op of ["postMessage", "terminate"]) {
    Object.defineProperty(Worker.prototype, op, { enumerable: true });
  }
  Object.defineProperty(Worker.prototype, Symbol.toStringTag, {
    value: "Worker",
    configurable: true,
  });
  return Worker;
}

function resolveWorkerUrl(scriptURL: unknown): URL {
  try {
    return new URL(String(scriptURL), documentBase());
  } catch {
    throw domException(
      `Failed to construct 'Worker': The URL '${String(scriptURL)}' is invalid.`,
      "SyntaxError",
    );
  }
}

function isHttpWorkerUrlSameOriginWithProtocol(
  protocol: string,
  url: URL,
  origin: string,
): boolean {
  return isHttpProtocol(protocol) && url.origin === origin;
}

function isSameOriginWorkerUrl(url: URL, href: string, origin: string): boolean {
  const protocol = url.protocol;
  if (protocol === "data:") return true;
  if (protocol === "blob:") return state.blobUrls.has(href);
  return isHttpWorkerUrlSameOriginWithProtocol(protocol, url, origin);
}

function isHttpProtocol(protocol: string): boolean {
  return protocol === "http:" || protocol === "https:";
}

function requireWorkerOrigin(url: URL, href: string, origin: string): void {
  if (isSameOriginWorkerUrl(url, href, origin)) return;
  throw domException(
    `Failed to construct 'Worker': Script at '${href}' cannot be accessed from origin '${origin}'.`,
    "SecurityError",
  );
}

function navigatorText(value: unknown, fallback: string): string {
  return String(value ?? fallback);
}

function navigatorLanguages(nav: { languages?: unknown }): string[] {
  return isIterable(nav.languages) ? Array.from(nav.languages, String) : ["en-US"];
}

interface WorkerNavigatorInfo {
  userAgent: string;
  language: string;
  languages: string[];
  platform: string;
}

function workerNavigatorInfo(): WorkerNavigatorInfo {
  const nav: {
    userAgent?: unknown;
    language?: unknown;
    languages?: unknown;
    platform?: unknown;
  } = ksGlobal.navigator ?? {};
  return {
    userAgent: navigatorText(nav.userAgent, ""),
    language: navigatorText(nav.language, "en-US"),
    languages: navigatorLanguages(nav),
    platform: navigatorText(nav.platform, ""),
  };
}

function listenerFunction(listener: unknown): ListenerFn | null {
  if (isListenerFn(listener)) return listener;
  if (!hasHandleEvent(listener)) return null;
  return function (event: Event) {
    return listener.handleEvent(event);
  };
}

function listenerOnce(options: unknown): boolean {
  return !!(options && typeof options === "object" && "once" in options && options.once);
}

function addWorkerListener(
  ws: KsWorkerState,
  type: string,
  source: unknown,
  fn: ListenerFn,
  once: boolean,
): void {
  const list = ws.listeners.get(type) ?? [];
  if (list.some((listener) => listener.src === source)) return;
  list.push({ fn, once, src: source });
  ws.listeners.set(type, list);
}

let deliverWorkerEventImpl: ((params: WorkerEventParams) => void) | null = null;

export function deliverWorkerEvent(params: WorkerEventParams): void {
  deliverWorkerEventImpl?.(params);
}
