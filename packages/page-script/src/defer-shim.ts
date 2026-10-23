// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Retries and parks page I/O until workerd allows it in a handler context.

import { isEngineScheduling } from "./native-scheduling.ts";
import { ksGlobal } from "./state.ts";

let installed = false;
let nextFakeId = 1;
const nativeApply = Reflect.apply;

let pageTimerSchedules = 0;
export function timersScheduledCount(): number {
  return pageTimerSchedules;
}

const parked: Array<() => void> = [];

export function deferShimStats(): {
  outstanding: number;
  pending: number;
  parked: number;
  liveTimers: number;
  liveIntervals: number;
} {
  return {
    outstanding,
    pending: pending.length,
    parked: parked.length,
    liveTimers: fakeToRealTimer.size,
    liveIntervals: fakeToRealInterval.size,
  };
}

// Module-init has no I/O context; replay parked calls when a session method enters handler scope.
export function drainDeferParked(): void {
  while (parked.length > 0) {
    const callback = parked.shift() as () => void;
    try {
      callback();
    } catch {}
  }
}

export function retryWhenIoAllowed(attempt: () => void): void {
  let attempts = 0;
  const tryOnce = (): void => {
    attempts++;
    try {
      attempt();
    } catch (e) {
      if (!isDisallowedError(e)) {
        if (attempts === 1) throw e;
        console.warn("[ks defer-shim] deferred engine call threw:", e);
        return;
      }
      if (attempts < MAX_RETRIES) scheduleRetry(tryOnce);
      else
        parked.push(() => {
          attempts = 0;
          tryOnce();
        });
    }
  };
  tryOnce();
}

const fakeToRealTimer = new Map<number, number>();
const fakeToRealInterval = new Map<number, number>();
const deferredTimer = new Set<number>();
const deferredInterval = new Set<number>();
const canceledTimer = new Set<number>();
const canceledInterval = new Set<number>();

const MAX_RETRIES = 64;

export function isDisallowedError(error: unknown): boolean {
  if (!error || typeof (error as Error).message !== "string") return false;
  const message = (error as Error).message;
  return (
    message.includes("Disallowed operation called within global scope") ||
    message.includes("Disallowed operation called")
  );
}

function scheduleRetry(fn: () => void): void {
  try {
    queueMicrotask(fn);
  } catch {
    try {
      Promise.resolve().then(fn);
    } catch {
      try {
        fn();
      } catch {}
    }
  }
}

function wrapAsync<T>(
  real: (...args: unknown[]) => Promise<T>,
): (...args: unknown[]) => Promise<T> {
  return function (this: unknown, ...args: unknown[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let attempts = 0;
      const tryOnce = (): void => {
        attempts++;
        let operationPromise: Promise<T>;
        try {
          operationPromise = nativeApply(real, this, args);
        } catch (e) {
          if (isDisallowedError(e)) {
            if (attempts < MAX_RETRIES) scheduleRetry(tryOnce);
            else
              parked.push(() => {
                attempts = 0;
                tryOnce();
              });
            return;
          }
          reject(e);
          return;
        }
        Promise.resolve(operationPromise).then(resolve, (err: unknown) => {
          if (isDisallowedError(err)) {
            if (attempts < MAX_RETRIES) scheduleRetry(tryOnce);
            else
              parked.push(() => {
                attempts = 0;
                tryOnce();
              });
          } else {
            reject(err);
          }
        });
      };
      tryOnce();
    });
  };
}

const TIMER_CAP = 8000;
let outstanding = 0;
const pending: Array<() => void> = [];
function drainPending(): void {
  while (pending.length > 0 && outstanding < TIMER_CAP) {
    const before = outstanding;
    const start = pending.shift() as () => void;
    start();
    if (outstanding > before) break;
  }
}

function makeTimerWrapper(
  real: (fn: () => void, delay: number, ...args: unknown[]) => number,
  isInterval: boolean,
  fakeToReal: Map<number, number>,
  deferred: Set<number>,
  cancelSet: Set<number>,
): (fn: unknown, delay?: number, ...args: unknown[]) => number {
  return function (fn: unknown, delay?: number, ...args: unknown[]): number {
    if (typeof fn !== "function") {
      throw new TypeError(
        (isInterval ? "setInterval" : "setTimeout") + " requires a function as the first argument",
      );
    }
    if (!isEngineScheduling()) pageTimerSchedules++;
    const fakeId = nextFakeId++;
    const userFn = fn as (...a: unknown[]) => void;
    const userDelay = typeof delay === "number" ? delay : 0;
    let attempts = 0;
    const tryOnce = (): void => {
      if (cancelSet.has(fakeId)) {
        cancelSet.delete(fakeId);
        deferred.delete(fakeId);
        return;
      }
      if (outstanding >= TIMER_CAP) {
        deferred.add(fakeId);
        pending.push(tryOnce);
        return;
      }
      attempts++;
      try {
        const realId = real(() => {
          if (cancelSet.has(fakeId)) {
            cancelSet.delete(fakeId);
            if (!isInterval) {
              fakeToReal.delete(fakeId);
              outstanding--;
              drainPending();
            }
            return;
          }
          try {
            userFn.call(globalThis, ...args);
          } catch (cbErr) {
            console.warn(
              "[ks defer-shim] " + (isInterval ? "setInterval" : "setTimeout") + " callback threw:",
              cbErr,
            );
          }
          if (!isInterval) {
            fakeToReal.delete(fakeId);
            outstanding--;
            drainPending();
          }
        }, userDelay);
        fakeToReal.set(fakeId, realId);
        deferred.delete(fakeId);
        outstanding++;
      } catch (e) {
        if (isDisallowedError(e)) {
          deferred.add(fakeId);
          if (attempts < MAX_RETRIES) {
            scheduleRetry(tryOnce);
          } else {
            parked.push(() => {
              attempts = 0;
              tryOnce();
            });
            console.warn(
              "[ks defer-shim] " +
                (isInterval ? "setInterval" : "setTimeout") +
                " parked after " +
                attempts +
                " module-init attempts; " +
                "will replay at the next handler-scope entry",
            );
          }
        } else {
          deferred.delete(fakeId);
          console.warn(
            "[ks defer-shim] " +
              (isInterval ? "setInterval" : "setTimeout") +
              " gave up after " +
              attempts +
              " attempts:",
            e,
          );
        }
      }
    };
    tryOnce();
    return fakeId;
  };
}

function makeClearTimerWrapper(
  realClear: (id: number) => void,
  fakeToReal: Map<number, number>,
  deferred: Set<number>,
  cancelSet: Set<number>,
): (id: unknown) => void {
  return function (id: unknown): void {
    if (typeof id !== "number") return;
    const realId = fakeToReal.get(id);
    if (realId !== undefined) {
      try {
        realClear(realId);
      } catch {}
      fakeToReal.delete(id);
      outstanding--;
      drainPending();
      return;
    }
    if (deferred.has(id)) cancelSet.add(id);
  };
}

export function installDeferShim(): void {
  if (installed) return;
  installed = true;

  const realSetTimeout = ksGlobal.setTimeout.bind(globalThis);
  const realClearTimeout = ksGlobal.clearTimeout.bind(globalThis);
  const realSetInterval = ksGlobal.setInterval.bind(globalThis);
  const realClearInterval = ksGlobal.clearInterval.bind(globalThis);

  ksGlobal.setTimeout = makeTimerWrapper(
    realSetTimeout,
    false,
    fakeToRealTimer,
    deferredTimer,
    canceledTimer,
  );
  ksGlobal.setInterval = makeTimerWrapper(
    realSetInterval,
    true,
    fakeToRealInterval,
    deferredInterval,
    canceledInterval,
  );
  ksGlobal.clearTimeout = makeClearTimerWrapper(
    realClearTimeout,
    fakeToRealTimer,
    deferredTimer,
    canceledTimer,
  );
  ksGlobal.clearInterval = makeClearTimerWrapper(
    realClearInterval,
    fakeToRealInterval,
    deferredInterval,
    canceledInterval,
  );

  // AbortSignal.timeout arms a native timer, so module scope refuses it. The fallback aborts a
  // native controller from the deferred setTimeout, so fetch and AbortSignal.any still accept the
  // signal. Capture the controller before globals.ts swaps in its lazy one.
  const realAbortTimeout = AbortSignal.timeout;
  const NativeAbortController = AbortController;
  const deferredSetTimeout = ksGlobal.setTimeout;
  AbortSignal.timeout = function timeout(delay: number): AbortSignal {
    // Convert once so a stateful valueOf runs once, as it does natively.
    const ms = delay === undefined ? delay : Number(delay);
    try {
      return nativeApply(realAbortTimeout, AbortSignal, [ms]);
    } catch (e) {
      if (!isDisallowedError(e)) throw e;
    }
    const controller = new NativeAbortController();
    deferredSetTimeout(() => {
      controller.abort(
        new DOMException("The operation was aborted due to timeout", "TimeoutError"),
      );
    }, ms);
    return controller.signal;
  };

  if (typeof ksGlobal.fetch === "function") {
    const realFetch = ksGlobal.fetch.bind(globalThis);
    ksGlobal.fetch = wrapAsync(realFetch);
  }

  const cryptoObj = ksGlobal.crypto;
  if (cryptoObj && typeof cryptoObj === "object") {
    const subtle = cryptoObj.subtle;
    if (subtle && typeof subtle === "object") {
      const methods = [
        "digest",
        "encrypt",
        "decrypt",
        "sign",
        "verify",
        "generateKey",
        "deriveKey",
        "deriveBits",
        "importKey",
        "exportKey",
        "wrapKey",
        "unwrapKey",
      ];
      for (const name of methods) {
        const subtleMethod = subtle[name];
        if (typeof subtleMethod !== "function") continue;
        const bound = subtleMethod.bind(subtle);
        const wrapped = wrapAsync(bound);
        try {
          subtle[name] =
            name === "deriveBits"
              ? function (this: unknown, ...args: unknown[]) {
                  const length = args[2];
                  if (length !== null && length !== undefined) {
                    if (typeof length === "bigint") {
                      return Promise.reject(new TypeError("deriveBits: length must be a number"));
                    }
                    let number: number;
                    try {
                      number = Number(length);
                    } catch (error) {
                      return Promise.reject(error);
                    }
                    number = Math.trunc(number);
                    const MAX_DERIVE_BITS_LENGTH = 0xffff_ffff;
                    if (!Number.isFinite(number) || number < 0 || number > MAX_DERIVE_BITS_LENGTH) {
                      return Promise.reject(
                        new TypeError("deriveBits: length is outside the accepted range"),
                      );
                    }
                    args[2] = number;
                  }
                  return nativeApply(wrapped, this, args);
                }
              : wrapped;
        } catch {}
      }
    }
  }
}
