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

// A chain of thenables needs one turn per link, and `cs-microtask.html` relies
// on five. Only a script that read document.currentScript pays this: draining
// every classic script this deep cost 15 s of microtask work that
// one turn does in 1.3 s.
export const SETTLE_MICROTASK_TURNS = 32;

const PAGE_TASK_YIELD_GRACE_MS = 50;

// Deep settles are budgeted per navigation. A page that reads
// document.currentScript from every script would otherwise pay the deep chain
// cost per script, which reached 15 s on such a page.
const DEEP_SETTLE_BUDGET_TURNS = 64;
let deepSettleTurnsLeft = DEEP_SETTLE_BUDGET_TURNS;

export function resetDeepSettleBudget(): void {
  deepSettleTurnsLeft = DEEP_SETTLE_BUDGET_TURNS;
}

export async function drainSettleMicrotasks(turns: number = SETTLE_MICROTASK_TURNS): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await NativePromise.resolve();
  }
}

export async function drainScriptSettleMicrotasks(deep: boolean): Promise<void> {
  let limit = 1;
  if (deep && deepSettleTurnsLeft > 0) {
    limit = Math.min(SETTLE_MICROTASK_TURNS, deepSettleTurnsLeft);
    deepSettleTurnsLeft -= limit;
  }
  await drainSettleMicrotasks(limit);
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
