// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Fires workerd's promise rejection events at the window, and reports an unhandled rejection
// over CDP as Chrome does, so a script that fails inside an async function is not silent.

import { reportEngineError } from "./engine-error.ts";
import { pushException } from "./exception-buffer.ts";
import { shimEventCtor, state } from "./state.ts";
import { ks_set_promise_rejection_hook } from "./wasm-glue.js";

// installGlobals later publishes the window's addEventListener over the global scope's own, which
// is the only one workerd fires unhandledrejection and rejectionhandled at.
const nativeAddEventListener = globalThis.addEventListener?.bind(globalThis);
const nativeSetTimeout = globalThis.setTimeout;
const nativeApply = Reflect.apply;

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
  // V8 promises the boa bridge attached its own handler to: the rejectionhandled that attach makes
  // V8 fire is not page code handling them, and boa reports what its code leaves unhandled.
  const bridged = new WeakSet<object>();
  const reportUnhandled = (promise: object, reason: unknown): boolean => {
    dispatching.add(promise);
    const notCanceled = fire("unhandledrejection", promise, reason);
    dispatching.delete(promise);
    if (!handledInDispatch.has(promise)) outstanding.set(promise, reason);
    if (!notCanceled) return false;
    pushException(reason, { scriptId: "", url: "", text: "Uncaught (in promise)" });
    return true;
  };
  const onUnhandled = (native: Event) => {
    const promise = promiseOf(native);
    if (!promise || !state.window) return;
    const reason = "reason" in native ? native.reason : undefined;
    // Canceling also silences workerd's own report, as it silences the console in Chrome; an
    // uncanceled rejection reaches CDP clients the way Chrome reports it.
    if (!reportUnhandled(promise, reason)) native.preventDefault();
  };
  const onHandled = (native: Event) => {
    const promise = promiseOf(native);
    if (!promise || bridged.has(promise)) return;
    reportHandled(promise);
  };
  const reportHandled = (promise: object) => {
    if (dispatching.has(promise)) handledInDispatch.add(promise);
    if (!outstanding.has(promise)) return;
    const reason = outstanding.get(promise);
    outstanding.delete(promise);
    // HTML queues rejectionhandled as a task, while workerd fires its event inside the call that
    // attached the handler, where page listeners would run re-entrantly.
    nativeApply(nativeSetTimeout, globalThis, [() => fire("rejectionhandled", promise, reason), 0]);
  };
  // Boa reports from inside its job drain, where page listeners must not run, so the event is a
  // task; a handler that arrives before that task runs drops the report, as HTML checks then.
  const queuedReports = new WeakSet<object>();
  const fromBoa = (kind: unknown, promise: unknown, reason: unknown) => {
    if (typeof promise !== "object" || promise === null) return;
    if (kind === "bridged") {
      bridged.add(promise);
      return;
    }
    if (kind === "handled" && queuedReports.delete(promise)) return;
    if (kind === "handled" && dispatching.has(promise)) {
      handledInDispatch.add(promise);
      return;
    }
    if (kind === "unhandled") queuedReports.add(promise);
    nativeApply(nativeSetTimeout, globalThis, [
      () => {
        if (kind === "handled") reportHandled(promise);
        else if (queuedReports.delete(promise) && state.window && !outstanding.has(promise)) {
          reportUnhandled(promise, reason);
        }
      },
      0,
    ]);
  };
  try {
    nativeAddEventListener("unhandledrejection", onUnhandled);
    nativeAddEventListener("rejectionhandled", onHandled);
    ks_set_promise_rejection_hook(fromBoa);
  } catch (error) {
    reportEngineError("shim", error, "promise rejection events");
  }
}
