// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements the page-facing Scheduler.postTask API.

type PostTaskOptions = { priority?: string; delay?: number; signal?: AbortSignal };

const PRIORITIES = new Set(["user-blocking", "user-visible", "background"]);

export function createScheduler(setTimeoutFn: (cb: () => void, ms?: number) => unknown): object {
  class Scheduler {
    postTask<T>(callback: () => T, options: PostTaskOptions = {}): Promise<T> {
      if (typeof callback !== "function") {
        return Promise.reject(new TypeError("Scheduler.postTask: callback is not a function"));
      }
      const { priority, delay, signal } = options ?? {};
      if (priority !== undefined && !PRIORITIES.has(String(priority))) {
        return Promise.reject(new TypeError(`Scheduler.postTask: invalid priority '${priority}'`));
      }
      if (signal?.aborted) return Promise.reject(signal.reason);
      const ms = Math.max(0, Number(delay) || 0);
      return new Promise<T>((resolve, reject) => {
        const run = () => {
          try {
            resolve(callback());
          } catch (err) {
            reject(err);
          }
        };
        if (!signal) {
          setTimeoutFn(run, ms);
          return;
        }
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        setTimeoutFn(() => {
          signal.removeEventListener("abort", onAbort);
          if (!signal.aborted) run();
        }, ms);
      });
    }

    yield(): Promise<void> {
      return new Promise<void>((resolve) => setTimeoutFn(resolve, 0));
    }
  }
  Object.defineProperty(Scheduler.prototype, Symbol.toStringTag, {
    value: "Scheduler",
    configurable: true,
  });
  return new Scheduler();
}
