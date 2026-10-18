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
import { holdsSharedMemory } from "./shared-memory.ts";
import { ksEventCtors, ksGlobal, state } from "./state.ts";
import { trustedFetch } from "./trusted-fetch.ts";

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
  const seen = new Set<unknown>();
  for (const item of transfer) {
    if ((typeof item !== "object" && typeof item !== "function") || item === null) {
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

async function loadSource(url: string): Promise<string> {
  const meta = { url };
  const pre = await insertedScriptAllowed(meta);
  reportOnly(pre);
  if (!pre.allowed) {
    reportBlocked(pre);
    throw new Error(pre.reason ?? "blocked by policy");
  }
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
  const response = await fetchInsertedScript(pre.upgradeTo ?? url, "");
  if (response.status === 0) throw new Error("fetch failed");
  if (response.status >= 400) throw new Error(`HTTP ${response.status}`);
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
  return response.source;
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
      if (arguments.length === 0) {
        throw new TypeError(
          "Failed to construct 'Worker': 1 argument required, but only 0 present.",
        );
      }
      const opts: { type?: unknown; name?: unknown } =
        options && typeof options === "object" ? options : {};
      if (opts.type !== undefined && String(opts.type) === "module") {
        throw domException(
          "Failed to construct 'Worker': Kitesurf does not support module workers yet.",
          "NotSupportedError",
        );
      }
      let url: URL;
      try {
        url = new URL(String(scriptURL), documentBase());
      } catch {
        throw domException(
          `Failed to construct 'Worker': The URL '${String(scriptURL)}' is invalid.`,
          "SyntaxError",
        );
      }
      const href = url.href;
      const origin = documentOrigin();
      const protocol = url.protocol;
      const sameOrigin =
        protocol === "data:" ||
        (protocol === "blob:" && state.blobUrls.has(href)) ||
        ((protocol === "http:" || protocol === "https:") && url.origin === origin);
      if (!sameOrigin) {
        throw domException(
          `Failed to construct 'Worker': Script at '${href}' cannot be accessed from origin '${origin}'.`,
          "SecurityError",
        );
      }
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
      const nav: {
        userAgent?: unknown;
        language?: unknown;
        languages?: unknown;
        platform?: unknown;
      } = ksGlobal.navigator ?? {};
      const navigatorInfo = {
        userAgent: String(nav.userAgent ?? ""),
        language: String(nav.language ?? "en-US"),
        languages: isIterable(nav.languages) ? Array.from(nav.languages, String) : ["en-US"],
        platform: String(nav.platform ?? ""),
      };
      void loadSource(href).then(
        (source) => {
          if (ws.done) return;
          sendUpstreamEvent({
            event: "kitesurf.workerCreate",
            params: { workerId: id, url: href, name, source, navigator: navigatorInfo },
          });
          ws.created = true;
          for (const data of ws.queue) {
            sendUpstreamEvent({
              event: "kitesurf.workerPostMessage",
              params: { workerId: id, data },
            });
          }
          ws.queue = [];
        },
        (err) => {
          if (ws.done) return;
          try {
            console.error(
              `Failed to load worker script at '${href}': ` +
                (err instanceof Error ? err.message : String(err)),
            );
          } catch {}
          finish(ws);
          dispatch(ws, new ksEventCtors.Event("error"));
        },
      );
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
      let fn: ListenerFn | null = null;
      if (isListenerFn(listener)) {
        fn = listener;
      } else if (hasHandleEvent(listener)) {
        fn = function (event: Event) {
          return listener.handleEvent(event);
        };
      }
      if (!fn) return;
      const once = !!(options && typeof options === "object" && "once" in options && options.once);
      const listeners = this[STATE].listeners;
      const key = String(type);
      const list = listeners.get(key) ?? [];
      if (list.some((l) => l.src === listener)) return;
      list.push({ fn, once, src: listener });
      listeners.set(key, list);
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

  function dispatch(ws: KsWorkerState, event: Event): void {
    const worker = ws.owner;
    for (const key of ["target", "currentTarget", "srcElement"]) {
      try {
        Object.defineProperty(event, key, { value: worker, configurable: true, enumerable: true });
      } catch {}
    }
    const type = String(event.type);
    const handler = ws.handlers.get(type);
    const list = (ws.listeners.get(type) ?? []).slice();
    for (const l of list) {
      if (l.once) removeListener(ws, type, l.src);
      try {
        l.fn.call(worker, event);
      } catch (error) {
        try {
          console.error(error);
        } catch {}
      }
    }
    if (handler) {
      try {
        handler.call(worker, event);
      } catch (error) {
        try {
          console.error(error);
        } catch {}
      }
    }
  }

  function finish(ws: KsWorkerState): void {
    ws.done = true;
    ws.queue = [];
    live.delete(ws.id);
  }

  deliverWorkerEventImpl = (params: WorkerEventParams) => {
    const ws = live.get(Number(params?.workerId));
    if (!ws || ws.done) return;
    if (params.type === "message") {
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
    } else if (params.type === "error") {
      const Ctor: ErrorEventCtor = ksEventCtors.ErrorEvent || ksGlobal.ErrorEvent;
      const init = {
        message: params.message,
        filename: params.filename,
        lineno: params.lineno,
        colno: params.colno,
        cancelable: true,
      };
      let event: Event;
      try {
        event = new Ctor("error", init);
      } catch {
        event = Object.assign(new ksEventCtors.Event("error", { cancelable: true }), init);
      }
      dispatch(ws, event);
      if (!event.defaultPrevented) {
        try {
          console.error(params.message || "Uncaught error in worker");
        } catch {}
      }
    } else if (params.type === "loadError") {
      finish(ws);
      dispatch(ws, new ksEventCtors.Event("error"));
    } else if (params.type === "closed") {
      finish(ws);
    }
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

let deliverWorkerEventImpl: ((params: WorkerEventParams) => void) | null = null;

export function deliverWorkerEvent(params: WorkerEventParams): void {
  deliverWorkerEventImpl?.(params);
}
