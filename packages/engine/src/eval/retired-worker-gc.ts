// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A retired loaded worker stays alive until this isolate's GC collects the last stub to it, and
// V8 does not count that worker's memory, so dozens can pile up. A local workerd started with V8's
// --expose-gc exposes gc(); the engine then collects after a retirement, at most once a second.
// A timer would not do: it dies with the request context that scheduled it.

const RETIRED_WORKER_GC_INTERVAL_MS = 1_000;

let lastCollectedAt = 0;

/** Collects this isolate's garbage after a loaded worker retires; a no-op without gc(). */
export function collectRetiredWorkers(): void {
  const gc: unknown = Reflect.get(globalThis, "gc");
  if (typeof gc !== "function") return;
  const now = Date.now();
  // A clock that stepped back does not throttle, or collection would stop until it caught up.
  if (now >= lastCollectedAt && now - lastCollectedAt < RETIRED_WORKER_GC_INTERVAL_MS) return;
  lastCollectedAt = now;
  try {
    Reflect.apply(gc, globalThis, []);
  } catch {}
}
