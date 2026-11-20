// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Counts dynamic-worker leases and reserves capacity for navigation and rendering.

export const MAX_DYNAMIC_WORKERS = 4;

export const RENDERER_RESERVED_SLOTS = 1;

export const NAVIGATE_HEADROOM_SLOTS = 1;

export const MAX_CONCURRENT_OOPIF = 1;

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
      },
    };
    return lease;
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
