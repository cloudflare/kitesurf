// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Counts dynamic-worker leases and reserves capacity for navigation and rendering.

// The platform allows four dynamic workers per request, so this cannot grow:
// page-script, the renderer and a navigation reserve share the same four.
export const MAX_DYNAMIC_WORKERS = 4;

export const RENDERER_RESERVED_SLOTS = 1;

export const NAVIGATE_HEADROOM_SLOTS = 1;

export const MAX_CONCURRENT_OOPIF = 1;

// Starts waiting for a slot, in creation order. A page that creates workers in a
// burst (a preview per keystroke) outlives the budget instead of losing them.
export const MAX_QUEUED_WORKER_STARTS = 8;

/** Whether a worker start ran now, waits for a released slot, or was refused. */
export type WorkerAdmission = "granted" | "queued" | "full";

export type DynamicWorkerKind = "pageScript" | "renderer" | "oopif" | "worker";

/** Engine lease counts, not runtime in-flight requests or resident isolates. */
export interface WorkerLeaseStats {
  live: number;
  peak: number;
  liveByKind: Readonly<Record<DynamicWorkerKind, number>>;
  peakByKind: Readonly<Record<DynamicWorkerKind, number>>;
  oopifDenied: number;
  workerDenied: number;
}

export interface WorkerLease {
  readonly kind: DynamicWorkerKind;
  released: boolean;
  release(): void;
}

export class DynamicWorkerBudget {
  private counts: Record<DynamicWorkerKind, number> = {
    pageScript: 0,
    renderer: 0,
    oopif: 0,
    worker: 0,
  };
  private peaks: Record<DynamicWorkerKind, number> = {
    pageScript: 0,
    renderer: 0,
    oopif: 0,
    worker: 0,
  };
  private peak = 0;
  private workerStarts: Array<(lease: WorkerLease) => void> = [];
  oopifDenied = 0;
  workerDenied = 0;

  isolatesKilled = 0;

  noteIsolateKilled(): void {
    this.isolatesKilled += 1;
  }

  countPageTargets: () => number = () => 1;

  liveOf(kind: DynamicWorkerKind): number {
    return this.counts[kind];
  }

  get live(): number {
    return this.counts.pageScript + this.counts.renderer + this.counts.oopif + this.counts.worker;
  }

  snapshot(): WorkerLeaseStats {
    return {
      live: this.live,
      peak: this.peak,
      liveByKind: { ...this.counts },
      peakByKind: { ...this.peaks },
      oopifDenied: this.oopifDenied,
      workerDenied: this.workerDenied,
    };
  }

  canSpawnOopif(): boolean {
    return this.freeForOopif() >= 1;
  }

  /** Returns a release-once lease, or `null` if an OOPIF or worker slot limit denies it. */
  acquire(kind: DynamicWorkerKind): WorkerLease | null {
    if (kind === "oopif" && this.freeForOopif() < 1) {
      this.oopifDenied += 1;
      return null;
    }
    if (kind === "worker" && this.freeSlots() < 1) {
      this.workerDenied += 1;
      return null;
    }
    return this.takeLease(kind);
  }

  /** Runs a worker start now, or holds it until a lease is released. `"full"`
   * means the queue is at its cap, so the caller reports the old failure. */
  admitWorker(onGrant: (lease: WorkerLease) => void): WorkerAdmission {
    const free = this.freeSlots();
    if (free >= 1) {
      onGrant(this.takeLease("worker"));
      return "granted";
    }
    // Waiting only helps when workers fill the budget: if the renderer and
    // navigation reserves alone do, no release can free a slot (an OOPIF, say).
    if (free + this.counts.worker < 1 || this.workerStarts.length >= MAX_QUEUED_WORKER_STARTS) {
      this.workerDenied += 1;
      return "full";
    }
    this.workerStarts.push(onGrant);
    return "queued";
  }

  private takeLease(kind: DynamicWorkerKind): WorkerLease {
    this.counts[kind] += 1;
    this.peaks[kind] = Math.max(this.peaks[kind], this.counts[kind]);
    this.peak = Math.max(this.peak, this.live);
    const lease: WorkerLease = {
      kind,
      released: false,
      release: () => {
        if (lease.released) return;
        lease.released = true;
        if (this.counts[kind] > 0) this.counts[kind] -= 1;
        this.grantQueuedWorker();
      },
    };
    return lease;
  }

  /** Starts the oldest queued worker when a release left a slot free. */
  private grantQueuedWorker(): void {
    while (this.workerStarts.length > 0 && this.freeSlots() >= 1) {
      const next = this.workerStarts.shift();
      if (next) next(this.takeLease("worker"));
    }
  }

  describe(): string {
    return (
      `live=${this.live}/${MAX_DYNAMIC_WORKERS} ` +
      `pageScript=${this.counts.pageScript} ` +
      `renderer=${this.counts.renderer} ` +
      `oopif=${this.counts.oopif}/${MAX_CONCURRENT_OOPIF} ` +
      `worker=${this.counts.worker} ` +
      `headroom=${this.navigateHeadroom()} ` +
      `denied=${this.oopifDenied} workerDenied=${this.workerDenied} ` +
      `killed=${this.isolatesKilled}`
    );
  }

  private navigateHeadroom(): number {
    let targets = 1;
    try {
      targets = this.countPageTargets();
    } catch {}
    if (!Number.isFinite(targets) || targets < 1) targets = 1;
    return NAVIGATE_HEADROOM_SLOTS * Math.floor(targets);
  }

  private freeForOopif(): number {
    if (this.counts.oopif >= MAX_CONCURRENT_OOPIF) return 0;
    return this.freeSlots();
  }

  private freeSlots(): number {
    const reserved =
      (this.counts.renderer > 0 ? 0 : RENDERER_RESERVED_SLOTS) + this.navigateHeadroom();
    return MAX_DYNAMIC_WORKERS - this.live - reserved;
  }
}
