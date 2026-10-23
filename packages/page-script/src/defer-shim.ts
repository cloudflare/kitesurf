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
  let tryOnce: () => void;
  const resumeParked = (): void => {
    attempts = 0;
    tryOnce();
  };
  tryOnce = (): void => {
    attempts++;
    try {
      attempt();
    } catch (error) {
      handleRetryFailure(error, attempts, tryOnce, resumeParked);
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

function scheduleRetryOrPark(attempts: number, retry: () => void, resume: () => void): void {
  if (attempts < MAX_RETRIES) scheduleRetry(retry);
  else parked.push(resume);
}

function handleRetryFailure(
  error: unknown,
  attempts: number,
  retry: () => void,
  resume: () => void,
): void {
  if (!isDisallowedError(error)) {
    if (attempts === 1) throw error;
    console.warn("[ks defer-shim] deferred engine call threw:", error);
    return;
  }
  scheduleRetryOrPark(attempts, retry, resume);
}

function handleAsyncFailure(
  error: unknown,
  attempts: number,
  retry: () => void,
  resume: () => void,
  reject: (reason?: unknown) => void,
): void {
  if (isDisallowedError(error)) {
    scheduleRetryOrPark(attempts, retry, resume);
    return;
  }
  reject(error);
}

function wrapAsync<T>(
  real: (...args: unknown[]) => Promise<T>,
): (...args: unknown[]) => Promise<T> {
  return function (this: unknown, ...args: unknown[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let attempts = 0;
      let tryOnce: () => void;
      const resumeParked = (): void => {
        attempts = 0;
        tryOnce();
      };
      tryOnce = (): void => {
        attempts++;
        let operationPromise: Promise<T>;
        try {
          operationPromise = nativeApply(real, this, args);
        } catch (error) {
          handleAsyncFailure(error, attempts, tryOnce, resumeParked, reject);
          return;
        }
        Promise.resolve(operationPromise).then(resolve, (error: unknown) =>
          handleAsyncFailure(error, attempts, tryOnce, resumeParked, reject),
        );
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

function timerName(isInterval: boolean): string {
  return isInterval ? "setInterval" : "setTimeout";
}

function discardCanceledTimer(
  fakeId: number,
  cancelSet: Set<number>,
  deferred: Set<number>,
): boolean {
  if (!cancelSet.has(fakeId)) return false;
  cancelSet.delete(fakeId);
  deferred.delete(fakeId);
  return true;
}

function queueTimerAtCapacity(fakeId: number, deferred: Set<number>, retry: () => void): boolean {
  if (outstanding < TIMER_CAP) return false;
  deferred.add(fakeId);
  pending.push(retry);
  return true;
}

function releaseOneShotTimer(fakeId: number, fakeToReal: Map<number, number>): void {
  fakeToReal.delete(fakeId);
  outstanding--;
  drainPending();
}

function fireTimerCallback(
  fakeId: number,
  isInterval: boolean,
  fakeToReal: Map<number, number>,
  cancelSet: Set<number>,
  userFn: (...args: unknown[]) => void,
  args: unknown[],
): void {
  if (cancelSet.has(fakeId)) {
    cancelSet.delete(fakeId);
    if (!isInterval) releaseOneShotTimer(fakeId, fakeToReal);
    return;
  }
  try {
    userFn.call(globalThis, ...args);
  } catch (error) {
    console.warn("[ks defer-shim] " + timerName(isInterval) + " callback threw:", error);
  }
  if (!isInterval) releaseOneShotTimer(fakeId, fakeToReal);
}

function warnTimerParked(isInterval: boolean, attempts: number): void {
  console.warn(
    "[ks defer-shim] " +
      timerName(isInterval) +
      " parked after " +
      attempts +
      " module-init attempts; " +
      "will replay at the next handler-scope entry",
  );
}

function scheduleTimerRetryOrPark(
  attempts: number,
  retry: () => void,
  resume: () => void,
  isInterval: boolean,
): void {
  if (attempts < MAX_RETRIES) {
    scheduleRetry(retry);
    return;
  }
  parked.push(resume);
  warnTimerParked(isInterval, attempts);
}

function handleTimerScheduleFailure(
  error: unknown,
  fakeId: number,
  isInterval: boolean,
  attempts: number,
  retry: () => void,
  resume: () => void,
  deferred: Set<number>,
): void {
  if (isDisallowedError(error)) {
    deferred.add(fakeId);
    scheduleTimerRetryOrPark(attempts, retry, resume, isInterval);
    return;
  }
  deferred.delete(fakeId);
  console.warn(
    "[ks defer-shim] " + timerName(isInterval) + " gave up after " + attempts + " attempts:",
    error,
  );
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
    let tryOnce: () => void;
    const resumeParked = (): void => {
      attempts = 0;
      tryOnce();
    };
    tryOnce = (): void => {
      if (discardCanceledTimer(fakeId, cancelSet, deferred)) return;
      if (queueTimerAtCapacity(fakeId, deferred, tryOnce)) return;
      attempts++;
      try {
        const realId = real(() => {
          fireTimerCallback(fakeId, isInterval, fakeToReal, cancelSet, userFn, args);
        }, userDelay);
        fakeToReal.set(fakeId, realId);
        deferred.delete(fakeId);
        outstanding++;
      } catch (error) {
        handleTimerScheduleFailure(
          error,
          fakeId,
          isInterval,
          attempts,
          tryOnce,
          resumeParked,
          deferred,
        );
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
  installTimerGlobals();
  installAbortTimeout();
  installFetchWrapper();
  installSubtleWrappers();
}

function installTimerGlobals(): void {
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
}

function installAbortTimeout(): void {
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
}

function installFetchWrapper(): void {
  if (typeof ksGlobal.fetch === "function") {
    const realFetch = ksGlobal.fetch.bind(globalThis);
    ksGlobal.fetch = wrapAsync(realFetch);
  }
}

function isPropertyRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function subtleCrypto(): Record<string, unknown> | null {
  const cryptoObj: unknown = ksGlobal.crypto;
  if (!isPropertyRecord(cryptoObj)) return null;
  const subtle = cryptoObj.subtle;
  if (!isPropertyRecord(subtle)) return null;
  return subtle;
}

function installSubtleWrappers(): void {
  const subtle = subtleCrypto();
  if (!subtle) return;
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
  for (const name of methods) installSubtleMethod(subtle, name);
}

function installSubtleMethod(subtle: Record<string, unknown>, name: string): void {
  const subtleMethod = subtle[name];
  if (typeof subtleMethod !== "function") return;
  const wrapped = wrapAsync(subtleMethod.bind(subtle));
  try {
    subtle[name] = name === "deriveBits" ? deriveBitsWrapper(wrapped) : wrapped;
  } catch {}
}

type DeriveBitsLengthResult =
  | { valid: true; replace: false }
  | { valid: true; replace: true; value: number }
  | { valid: false; error: unknown };

const MAX_DERIVE_BITS_LENGTH = 0xffff_ffff;

function normalizeDeriveBitsLength(length: unknown): DeriveBitsLengthResult {
  if (length === null || length === undefined) return { valid: true, replace: false };
  if (typeof length === "bigint") {
    return { valid: false, error: new TypeError("deriveBits: length must be a number") };
  }
  return convertDeriveBitsLength(length);
}

function isValidDeriveBitsLength(length: number): boolean {
  return Number.isFinite(length) && length >= 0 && length <= MAX_DERIVE_BITS_LENGTH;
}

function convertDeriveBitsLength(length: unknown): DeriveBitsLengthResult {
  let number: number;
  try {
    number = Number(length);
  } catch (error) {
    return { valid: false, error };
  }
  number = Math.trunc(number);
  if (!isValidDeriveBitsLength(number)) {
    return {
      valid: false,
      error: new TypeError("deriveBits: length is outside the accepted range"),
    };
  }
  return { valid: true, replace: true, value: number };
}

function deriveBitsWrapper(
  wrapped: (...args: unknown[]) => Promise<unknown>,
): (...args: unknown[]) => Promise<unknown> {
  return function (this: unknown, ...args: unknown[]) {
    const length = normalizeDeriveBitsLength(args[2]);
    if (!length.valid) return Promise.reject(length.error);
    if (length.replace) args[2] = length.value;
    return nativeApply(wrapped, this, args);
  };
}
