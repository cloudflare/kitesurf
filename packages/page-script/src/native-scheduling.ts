// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Keep engine waits on captured natives after page code replaces shared-realm timers or Promise.
const nativeSetTimeoutRaw = globalThis.setTimeout;
const nativeClearTimeoutRaw = globalThis.clearTimeout;

export const NativePromise: PromiseConstructor = globalThis.Promise;

export const nativeSetTimeout: typeof setTimeout =
  typeof nativeSetTimeoutRaw === "function"
    ? nativeSetTimeoutRaw.bind(globalThis)
    : nativeSetTimeoutRaw;

export const nativeClearTimeout: typeof clearTimeout =
  typeof nativeClearTimeoutRaw === "function"
    ? nativeClearTimeoutRaw.bind(globalThis)
    : nativeClearTimeoutRaw;

export function nativeSleep(ms: number): Promise<void> {
  return new NativePromise<void>((resolve) => {
    nativeSetTimeout(resolve, ms);
  });
}

// A chain of thenables needs one turn per link. A shallower drain lets the next
// script start mid-chain, and yielding a real task lets error events land before
// an inline handler is installed, so every classic script drains the full window.
export const SETTLE_MICROTASK_TURNS = 32;

const PAGE_TASK_YIELD_GRACE_MS = 50;

export async function drainSettleMicrotasks(turns: number = SETTLE_MICROTASK_TURNS): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await NativePromise.resolve();
  }
}

export async function drainScriptSettleMicrotasks(): Promise<void> {
  // Drain the whole settle window: a promise chain of any length must finish before the next
  // script runs, which is what a browser guarantees.
  await drainSettleMicrotasks(SETTLE_MICROTASK_TURNS);
}

let engineScheduling = false;
export function isEngineScheduling(): boolean {
  return engineScheduling;
}

export function yieldToPageTasks(ms = 0): Promise<void> {
  const cap = Math.max(ms, 0) + PAGE_TASK_YIELD_GRACE_MS;
  const pageTurn = new NativePromise<void>((resolve) => {
    try {
      engineScheduling = true;
      (globalThis as { setTimeout?: (cb: () => void, d?: number) => unknown }).setTimeout?.(
        () => resolve(),
        ms,
      );
    } catch {
      resolve();
    } finally {
      engineScheduling = false;
    }
  });
  return NativePromise.race([pageTurn, nativeSleep(cap)]) as Promise<void>;
}
