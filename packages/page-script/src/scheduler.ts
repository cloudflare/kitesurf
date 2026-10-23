// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements the page-facing Scheduler.postTask API.

type PostTaskOptions = { priority?: string; delay?: number; signal?: AbortSignal };

const PRIORITIES = new Set(["user-blocking", "user-visible", "background"]);

function hasInvalidPriority(priority: string | undefined): priority is string {
  return priority !== undefined && !PRIORITIES.has(String(priority));
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return !!signal?.aborted;
}

function taskOptions(options: PostTaskOptions | null | undefined): PostTaskOptions {
  return options ?? {};
}

type TaskFailure = { kind: "priority"; priority: string } | { kind: "aborted"; reason: unknown };

function taskFailure(
  priority: string | undefined,
  signal: AbortSignal | undefined,
): TaskFailure | null {
  if (hasInvalidPriority(priority)) return { kind: "priority", priority };
  if (isAborted(signal)) return { kind: "aborted", reason: signal?.reason };
  return null;
}

function rejectTaskFailure<T>(failure: TaskFailure): Promise<T> {
  if (failure.kind === "priority") {
    return Promise.reject(
      new TypeError(`Scheduler.postTask: invalid priority '${failure.priority}'`),
    );
  }
  return Promise.reject(failure.reason);
}

function scheduleTask(
  setTimeoutFn: (cb: () => void, ms?: number) => unknown,
  run: () => void,
  delay: number,
  signal: AbortSignal | undefined,
  reject: (reason?: unknown) => void,
): void {
  if (!signal) {
    setTimeoutFn(run, delay);
    return;
  }
  const onAbort = () => reject(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  setTimeoutFn(() => {
    signal.removeEventListener("abort", onAbort);
    if (!signal.aborted) run();
  }, delay);
}

function runTaskCallback<T>(
  callback: () => T,
  resolve: (value: T | PromiseLike<T>) => void,
  reject: (reason?: unknown) => void,
): void {
  try {
    resolve(callback());
  } catch (err) {
    reject(err);
  }
}

export function createScheduler(setTimeoutFn: (cb: () => void, ms?: number) => unknown): object {
  class Scheduler {
    postTask<T>(callback: () => T, options: PostTaskOptions = {}): Promise<T> {
      if (typeof callback !== "function") {
        return Promise.reject(new TypeError("Scheduler.postTask: callback is not a function"));
      }
      const { priority, delay, signal } = taskOptions(options);
      const failure = taskFailure(priority, signal);
      if (failure) return rejectTaskFailure(failure);
      const ms = Math.max(0, Number(delay) || 0);
      return new Promise<T>((resolve, reject) => {
        const run = () => runTaskCallback(callback, resolve, reject);
        scheduleTask(setTimeoutFn, run, ms, signal, reject);
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
