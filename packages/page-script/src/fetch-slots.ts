// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Schedules subresource requests under per-host and global concurrency limits.

export const FETCH_CONCURRENCY_PER_HOST = 6;

export const FETCH_CONCURRENCY_GLOBAL = 24;
const MISORDER_WINDOW_MS = 30;

export const CLASS_STYLESHEET = 0;
export const CLASS_FONT = 1;
export const CLASS_IMAGE_VIEWPORT = 2;
export const CLASS_IMAGE = 3;
export const CLASS_MEDIA = 4;
export const CLASS_DEFERRED = 5;

export function classForKind(kind: string): number {
  switch (kind) {
    case "Script":
    case "Stylesheet":
      return CLASS_STYLESHEET;
    case "Font":
      return CLASS_FONT;
    case "Media":
      return CLASS_MEDIA;
    default:
      return CLASS_IMAGE;
  }
}

export function allHintsLazy(hints: ReadonlyArray<{ priority: string; lazy: boolean }>): boolean {
  return hints.length > 0 && hints.every((hint) => hint.lazy);
}

export function classForImageHints(
  hints: ReadonlyArray<{ priority: string; lazy: boolean }>,
): number {
  if (hints.length === 0) return CLASS_IMAGE;
  let anyHigh = false;
  let allDeferred = true;
  for (const hint of hints) {
    if (hint.priority === "high") anyHigh = true;
    if (!(hint.priority === "low" || hint.lazy)) allDeferred = false;
  }
  if (anyHigh) return CLASS_FONT;
  if (allDeferred) return CLASS_DEFERRED;
  return CLASS_IMAGE;
}

const NativePromiseCtor = Promise;
const scheduleMicrotaskNative: (fn: () => void) => void =
  typeof queueMicrotask === "function"
    ? queueMicrotask.bind(globalThis)
    : (fn) => {
        void NativePromiseCtor.resolve().then(fn);
      };

export function fetchHostKey(url: string): string {
  try {
    return new URL(url).host || "\u2205";
  } catch {
    return "\u2205";
  }
}

interface Waiter {
  url: string;
  host: string;
  resourceClass: number;
  arrivalSequence: number;
  firstDrain: boolean;
  resume: () => void;
}

export class FetchSlots {
  private hostInflight = new Map<string, number>();
  private globalInflight = 0;
  private pending: Waiter[] = [];
  private nextArrivalSequence = 0;
  private drainScheduled = false;

  private uncontendedCount = 0;
  private misorderHitCount = 0;
  private lastContestedAdmission: {
    resourceClass: number;
    host: string;
    admittedAt: number;
  } | null = null;

  private boostProbe: ((url: string) => number | null) | null = null;

  constructor(
    private readonly perHostLimit = FETCH_CONCURRENCY_PER_HOST,
    private readonly globalLimit = FETCH_CONCURRENCY_GLOBAL,
    private readonly now: () => number = Date.now,
  ) {}

  acquire(url: string, resourceClass: number = CLASS_IMAGE): Promise<void> {
    const host = fetchHostKey(url);
    const lastContestedAdmission = this.lastContestedAdmission;
    if (
      lastContestedAdmission &&
      resourceClass < lastContestedAdmission.resourceClass &&
      host === lastContestedAdmission.host &&
      this.now() - lastContestedAdmission.admittedAt <= MISORDER_WINDOW_MS
    ) {
      this.misorderHitCount++;
    }
    return new NativePromiseCtor<void>((resolve) => {
      this.pending.push({
        url,
        host,
        resourceClass,
        arrivalSequence: this.nextArrivalSequence++,
        firstDrain: true,
        resume: resolve,
      });
      this.scheduleDrain();
    });
  }

  poke(): void {
    this.scheduleDrain();
  }

  setBoostProbe(probe: ((url: string) => number | null) | null): void {
    this.boostProbe = probe;
  }

  release(url: string): void {
    const host = fetchHostKey(url);
    const remaining = (this.hostInflight.get(host) ?? 1) - 1;
    if (remaining <= 0) {
      this.hostInflight.delete(host);
    } else {
      this.hostInflight.set(host, remaining);
    }
    if (this.globalInflight > 0) this.globalInflight--;
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    scheduleMicrotaskNative(() => {
      this.drainScheduled = false;
      this.drain();
    });
  }

  private drain(): void {
    if (this.pending.length === 0) return;
    if (this.boostProbe) {
      const memo = new Map<string, number | null>();
      for (const waiter of this.pending) {
        if (waiter.resourceClass !== CLASS_IMAGE) continue;
        let boostedClass = memo.get(waiter.url);
        if (boostedClass === undefined) {
          try {
            boostedClass = this.boostProbe(waiter.url);
          } catch {
            boostedClass = null;
          }
          memo.set(waiter.url, boostedClass);
        }
        if (typeof boostedClass === "number" && boostedClass < waiter.resourceClass) {
          waiter.resourceClass = boostedClass;
        }
      }
    }
    this.pending.sort(
      (left, right) =>
        left.resourceClass - right.resourceClass || left.arrivalSequence - right.arrivalSequence,
    );
    const remainingWaiters: Waiter[] = [];
    for (const waiter of this.pending) {
      const hostInflightCount = this.hostInflight.get(waiter.host) ?? 0;
      if (this.globalInflight < this.globalLimit && hostInflightCount < this.perHostLimit) {
        this.hostInflight.set(waiter.host, hostInflightCount + 1);
        this.globalInflight++;
        if (waiter.firstDrain) {
          this.uncontendedCount++;
        } else {
          this.lastContestedAdmission = {
            resourceClass: waiter.resourceClass,
            host: waiter.host,
            admittedAt: this.now(),
          };
        }
        waiter.resume();
      } else {
        waiter.firstDrain = false;
        remainingWaiters.push(waiter);
      }
    }
    this.pending = remainingWaiters;
  }

  stats(): {
    global: number;
    hosts: number;
    queued: number;
    uncontended: number;
    misorderHits: number;
  } {
    return {
      global: this.globalInflight,
      hosts: this.hostInflight.size,
      queued: this.pending.length,
      uncontended: this.uncontendedCount,
      misorderHits: this.misorderHitCount,
    };
  }
}
