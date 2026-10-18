// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Queues module-init timers and fetches until PageScript enters handler scope.

import { ksGlobal } from "./state.ts";

type TimerFn = (...args: unknown[]) => void;
type RealSetTimeout = typeof globalThis.setTimeout;
type RealClearTimeout = typeof globalThis.clearTimeout;
type RealFetch = typeof fetch;

interface QueuedTimer {
  fakeId: number;
  fn: TimerFn;
  delay: number;
  args: unknown[];
}

interface QueuedInterval {
  fakeId: number;
  fn: TimerFn;
  delay: number;
  args: unknown[];
}

interface QueuedFetch {
  resolve: (value: Response) => void;
  reject: (reason: unknown) => void;
  input: Parameters<typeof fetch>[0];
  init: Parameters<typeof fetch>[1];
  aborted: boolean;
}

let installed = false;
let realSetTimeout: RealSetTimeout | null = null;
let realClearTimeout: RealClearTimeout | null = null;
let realSetInterval: RealSetTimeout | null = null;
let realClearInterval: RealClearTimeout | null = null;
let realFetch: RealFetch | null = null;
let nextFakeId = 1;
let queuedTimers: QueuedTimer[] = [];
let queuedIntervals: QueuedInterval[] = [];
let queuedFetches: QueuedFetch[] = [];
const fakeToReal = new Map<number, number>();
const fakeIntervalToReal = new Map<number, number>();
const canceled = new Set<number>();
const canceledIntervals = new Set<number>();

export function installInitShims(): void {
  if (installed) return;
  installed = true;
  realSetTimeout = globalThis.setTimeout;
  realClearTimeout = globalThis.clearTimeout;
  realSetInterval = (globalThis as { setInterval?: unknown }).setInterval as RealSetTimeout;
  realClearInterval = (globalThis as { clearInterval?: unknown }).clearInterval as RealClearTimeout;
  realFetch = globalThis.fetch;

  const coerceInitTimerTask = (fn: TimerFn | string | unknown): TimerFn => {
    if (typeof fn === "function") return fn as TimerFn;
    if (typeof fn === "string") {
      const src = fn;
      return function ksStringTimerTask() {
        try {
          return ksGlobal.eval(src);
        } catch (e) {
          try {
            console.error("[kitesurf] deferred setTimeout string-task threw:", e);
          } catch {}
        }
      };
    }
    throw new TypeError(
      "[kitesurf init-shim] setTimeout(fn) requires a function or string during module-init; got " +
        typeof fn,
    );
  };

  (globalThis as { setTimeout: unknown }).setTimeout = function setTimeout(
    fn: TimerFn | string,
    delay?: number,
    ...args: unknown[]
  ): number {
    const task = coerceInitTimerTask(fn);
    const fakeId = nextFakeId++;
    queuedTimers.push({
      fakeId,
      fn: task,
      delay: typeof delay === "number" ? delay : 0,
      args,
    });
    return fakeId;
  };

  (globalThis as { clearTimeout: unknown }).clearTimeout = function clearTimeout(
    id: number | undefined,
  ): void {
    if (typeof id !== "number") return;
    if (fakeToReal.has(id)) {
      const realId = fakeToReal.get(id)!;
      realClearTimeout!(realId);
      fakeToReal.delete(id);
      return;
    }
    canceled.add(id);
  };

  (globalThis as { setInterval: unknown }).setInterval = function setInterval(
    fn: TimerFn | string,
    delay?: number,
    ...args: unknown[]
  ): number {
    const task = coerceInitTimerTask(fn);
    const fakeId = nextFakeId++;
    queuedIntervals.push({
      fakeId,
      fn: task,
      delay: typeof delay === "number" ? delay : 0,
      args,
    });
    return fakeId;
  };

  (globalThis as { clearInterval: unknown }).clearInterval = function clearInterval(
    id: number | undefined,
  ): void {
    if (typeof id !== "number") return;
    if (fakeIntervalToReal.has(id)) {
      const realId = fakeIntervalToReal.get(id)!;
      realClearInterval!(realId);
      fakeIntervalToReal.delete(id);
      return;
    }
    canceledIntervals.add(id);
  };

  (globalThis as { fetch: unknown }).fetch = function fetch(
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> {
    let resolve!: (value: Response) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<Response>((resolveResponse, rejectResponse) => {
      resolve = resolveResponse;
      reject = rejectResponse;
    });
    const entry: QueuedFetch = {
      resolve,
      reject,
      input,
      init,
      aborted: false,
    };
    const signal = init?.signal;
    if (signal && signal.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return promise;
    }
    if (signal && typeof signal.addEventListener === "function") {
      signal.addEventListener(
        "abort",
        () => {
          entry.aborted = true;
          entry.reject(new DOMException("The operation was aborted.", "AbortError"));
        },
        { once: true },
      );
    }
    queuedFetches.push(entry);
    return promise;
  };
}

export function drainInitShims(): void {
  if (!installed) return;
  (globalThis as { setTimeout: unknown }).setTimeout = realSetTimeout!;
  (globalThis as { clearTimeout: unknown }).clearTimeout = realClearTimeout!;
  (globalThis as { setInterval: unknown }).setInterval = realSetInterval!;
  (globalThis as { clearInterval: unknown }).clearInterval = realClearInterval!;
  (globalThis as { fetch: unknown }).fetch = realFetch!;
  installed = false;

  for (const t of queuedTimers) {
    if (canceled.has(t.fakeId)) {
      canceled.delete(t.fakeId);
      continue;
    }
    const realId = realSetTimeout!(() => {
      try {
        t.fn.call(globalThis, ...t.args);
      } catch (e) {
        console.warn("[kitesurf init-shim] deferred timer threw:", e);
      }
      fakeToReal.delete(t.fakeId);
    }, t.delay);
    fakeToReal.set(t.fakeId, realId);
  }
  queuedTimers = [];

  for (const iv of queuedIntervals) {
    if (canceledIntervals.has(iv.fakeId)) {
      canceledIntervals.delete(iv.fakeId);
      continue;
    }
    const realId = realSetInterval!(() => {
      try {
        iv.fn.call(globalThis, ...iv.args);
      } catch (e) {
        console.warn("[kitesurf init-shim] deferred interval threw:", e);
      }
    }, iv.delay);
    fakeIntervalToReal.set(iv.fakeId, realId);
  }
  queuedIntervals = [];

  for (const f of queuedFetches) {
    if (f.aborted) continue;
    Promise.resolve()
      .then(() => realFetch!(f.input, f.init))
      .then(f.resolve, f.reject);
  }
  queuedFetches = [];
}
