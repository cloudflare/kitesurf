// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Fires workerd's promise rejection events at the window, and reports an unhandled rejection
// over CDP as Chrome does, so a script that fails inside an async function is not silent.

import { reportEngineError } from "./engine-error.ts";
import { pushException } from "./exception-buffer.ts";
import { shimEventCtor, state } from "./state.ts";

// installGlobals later publishes the window's addEventListener over the global scope's own, which
// is the only one workerd fires unhandledrejection and rejectionhandled at.
const nativeAddEventListener = globalThis.addEventListener?.bind(globalThis);
const nativeSetTimeout = globalThis.setTimeout;

type DispatchTrusted = (target: unknown, event: unknown) => boolean;

function promiseOf(native: Event): object | null {
  const promise = "promise" in native ? native.promise : undefined;
  return typeof promise === "object" && promise !== null ? promise : null;
}

export function installPromiseRejectionEvents(dispatchTrusted: DispatchTrusted): void {
  if (typeof nativeAddEventListener !== "function") return;
  // HTML's outstanding rejected promises: workerd's own rejectionhandled carries no reason, and
  // also fires for a promise that a listener handled while its unhandledrejection was dispatched.
  const outstanding = new WeakMap<object, unknown>();
  const dispatching = new Set<object>();
  const handledInDispatch = new WeakSet<object>();
  const fire = (type: string, promise: object, reason: unknown): boolean => {
    const win = state.window;
    if (!win) return true;
    try {
      const PromiseRejectionEvent = shimEventCtor("PromiseRejectionEvent");
      const cancelable = type === "unhandledrejection";
      return dispatchTrusted(win, new PromiseRejectionEvent(type, { cancelable, promise, reason }));
    } catch {
      return true;
    }
  };
  const onUnhandled = (native: Event) => {
    const promise = promiseOf(native);
    if (!promise || !state.window) return;
    const reason = "reason" in native ? native.reason : undefined;
    dispatching.add(promise);
    const notCanceled = fire("unhandledrejection", promise, reason);
    dispatching.delete(promise);
    if (!handledInDispatch.has(promise)) outstanding.set(promise, reason);
    // Canceling also silences workerd's own report, as it silences the console in Chrome; an
    // uncanceled rejection reaches CDP clients the way Chrome reports it.
    if (!notCanceled) native.preventDefault();
    else pushException(reason, { scriptId: "", url: "", text: "Uncaught (in promise)" });
  };
  const onHandled = (native: Event) => {
    const promise = promiseOf(native);
    if (!promise) return;
    if (dispatching.has(promise)) handledInDispatch.add(promise);
    if (!outstanding.has(promise)) return;
    const reason = outstanding.get(promise);
    outstanding.delete(promise);
    // HTML queues rejectionhandled as a task, while workerd fires its event inside the call that
    // attached the handler, where page listeners would run re-entrantly.
    Reflect.apply(nativeSetTimeout, globalThis, [
      () => fire("rejectionhandled", promise, reason),
      0,
    ]);
  };
  try {
    nativeAddEventListener("unhandledrejection", onUnhandled);
    nativeAddEventListener("rejectionhandled", onHandled);
  } catch (error) {
    reportEngineError("shim", error, "promise rejection events");
  }
}
