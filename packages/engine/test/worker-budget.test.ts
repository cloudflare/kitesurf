// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DynamicWorkerBudget,
  MAX_QUEUED_WORKER_STARTS,
  MAX_WORKER_QUEUE_WAIT_MS,
  type WorkerLease,
} from "../src/eval/worker-budget.ts";

function steadyStateBudget(): DynamicWorkerBudget {
  const budget = new DynamicWorkerBudget();
  budget.acquire("pageScript");
  budget.acquire("renderer");
  return budget;
}

/** Takes worker leases until the budget refuses one, as a busy page would. */
function fillWorkers(budget: DynamicWorkerBudget): WorkerLease[] {
  const leases: WorkerLease[] = [];
  for (;;) {
    const lease = budget.acquire("worker");
    if (!lease) return leases;
    leases.push(lease);
  }
}

describe("DynamicWorkerBudget worker kind", () => {
  it("starts with empty live counts, peaks and denials", () => {
    expect(new DynamicWorkerBudget().snapshot()).toEqual({
      live: 0,
      peak: 0,
      liveByKind: { pageScript: 0, renderer: 0, oopif: 0, worker: 0 },
      peakByKind: { pageScript: 0, renderer: 0, oopif: 0, worker: 0 },
      oopifDenied: 0,
      workerDenied: 0,
    });
  });

  it("retains simultaneous peaks and denials after lease turnover and teardown", () => {
    const budget = new DynamicWorkerBudget();
    const oldPage = budget.acquire("pageScript");
    const renderer = budget.acquire("renderer");
    const newPage = budget.acquire("pageScript");
    oldPage?.release();
    const workers = fillWorkers(budget);
    expect(workers.length).toBeGreaterThan(0);
    const worker = workers[0];
    worker?.release();
    worker?.release();
    const frame = budget.acquire("oopif");
    expect(frame).not.toBeNull();
    expect(budget.acquire("oopif")).toBeNull();
    expect(budget.acquire("worker")).toBeNull();
    expect(budget.workerDenied).toBeGreaterThan(0);

    const active = budget.snapshot();
    expect(active.liveByKind).toEqual({
      pageScript: 1,
      renderer: 1,
      oopif: 1,
      worker: 0,
    });
    expect(active.peakByKind).toEqual({ pageScript: 2, renderer: 1, oopif: 1, worker: 1 });
    expect(active.oopifDenied).toBe(1);

    newPage?.release();
    renderer?.release();
    frame?.release();
    for (const lease of workers) lease.release();
    expect(budget.snapshot()).toEqual({
      ...active,
      live: 0,
      liveByKind: { pageScript: 0, renderer: 0, oopif: 0, worker: 0 },
    });
  });

  it("grants a worker the free slot", () => {
    const budget = steadyStateBudget();
    const lease = budget.acquire("worker");
    expect(lease).not.toBeNull();
    expect(budget.liveOf("worker")).toBe(1);
    expect(budget.live).toBe(3);
  });

  it("shares the slot with OOPIFs, first come first served", () => {
    const budget = steadyStateBudget();
    const workers = fillWorkers(budget);
    expect(workers.length).toBeGreaterThan(0);
    expect(budget.canSpawnOopif()).toBe(false);
    expect(budget.acquire("oopif")).toBeNull();
    expect(budget.workerDenied).toBe(1);

    workers.pop()?.release();
    const frame = budget.acquire("oopif");
    expect(frame).not.toBeNull();
    expect(budget.acquire("worker")).toBeNull();
    expect(budget.workerDenied).toBe(2);
  });

  it("keeps the unloaded renderer's reserved slot out of reach", () => {
    const budget = new DynamicWorkerBudget();
    budget.acquire("pageScript");
    fillWorkers(budget);
    expect(budget.acquire("worker")).toBeNull();
    // The reserve is real: the renderer still gets its slot.
    expect(budget.acquire("renderer")).not.toBeNull();
  });

  it("returns the slot when the lease is released twice", () => {
    const budget = steadyStateBudget();
    const lease = budget.acquire("worker");
    lease?.release();
    lease?.release();
    expect(budget.liveOf("worker")).toBe(0);
    expect(budget.acquire("worker")).not.toBeNull();
  });
});

describe("DynamicWorkerBudget worker queue", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("grants at once when a slot is free", () => {
    const budget = steadyStateBudget();
    const granted: WorkerLease[] = [];
    expect(budget.admitWorker((lease) => granted.push(lease))).toEqual({ status: "granted" });
    expect(granted).toHaveLength(1);
    expect(budget.liveOf("worker")).toBe(1);
  });

  it("holds a start until a lease is released, in creation order", () => {
    vi.useFakeTimers();
    const budget = steadyStateBudget();
    const held = fillWorkers(budget);
    expect(held.length).toBeGreaterThan(0);
    const order: string[] = [];
    const granted: WorkerLease[] = [];
    const admit = (name: string) => (lease: WorkerLease) => {
      order.push(name);
      granted.push(lease);
    };
    expect(budget.admitWorker(admit("second")).status).toBe("queued");
    expect(budget.admitWorker(admit("third")).status).toBe("queued");
    expect(order).toEqual([]);

    held[0]?.release();
    expect(order).toEqual(["second"]);
    expect(budget.liveOf("worker")).toBe(held.length);

    granted[0]?.release();
    expect(order).toEqual(["second", "third"]);
    expect(budget.liveOf("worker")).toBe(held.length);
  });

  it("does not count a queued start as denied", () => {
    vi.useFakeTimers();
    const budget = steadyStateBudget();
    fillWorkers(budget);
    const denied = budget.workerDenied;
    const admission = budget.admitWorker(() => {});
    expect(admission.status).toBe("queued");
    expect(budget.workerDenied).toBe(denied);
  });

  it("expires a queued start after the wait deadline and counts the denial", () => {
    vi.useFakeTimers();
    const budget = steadyStateBudget();
    const held = fillWorkers(budget);
    const deniedBefore = budget.workerDenied;
    let granted = false;
    let timedOut = false;

    const admission = budget.admitWorker(
      () => {
        granted = true;
      },
      () => {
        timedOut = true;
      },
    );
    expect(admission.status).toBe("queued");

    vi.advanceTimersByTime(MAX_WORKER_QUEUE_WAIT_MS - 1);
    expect(timedOut).toBe(false);
    vi.advanceTimersByTime(1);
    expect(timedOut).toBe(true);
    expect(budget.workerDenied).toBe(deniedBefore + 1);

    held[0]?.release();
    expect(granted).toBe(false);
  });

  it("cancels a queued start without denying or consuming a released slot", () => {
    vi.useFakeTimers();
    const budget = steadyStateBudget();
    const held = fillWorkers(budget);
    const deniedBefore = budget.workerDenied;
    const order: string[] = [];

    const first = budget.admitWorker(() => order.push("first"));
    expect(first.status).toBe("queued");
    const second = budget.admitWorker(() => order.push("second"));
    expect(second.status).toBe("queued");

    if (first.status === "queued") first.cancel();
    held[0]?.release();
    expect(order).toEqual(["second"]);
    expect(budget.workerDenied).toBe(deniedBefore);
  });

  it("releases the lease if a queued onGrant callback throws", () => {
    vi.useFakeTimers();
    const budget = steadyStateBudget();
    const held = fillWorkers(budget);
    const liveBefore = budget.liveOf("worker");
    budget.admitWorker(() => {
      throw new Error("boom");
    });
    held[0]?.release();
    expect(budget.liveOf("worker")).toBe(liveBefore - 1);
  });

  it("refuses when the reserves alone fill the budget", () => {
    const budget = new DynamicWorkerBudget();
    budget.acquire("pageScript");
    budget.acquire("renderer");
    // An OOPIF leaves the worker slots structurally at zero: waiting cannot help.
    expect(budget.acquire("oopif")).not.toBeNull();
    const granted: WorkerLease[] = [];
    expect(budget.admitWorker((lease) => granted.push(lease))).toEqual({ status: "full" });
    expect(granted).toEqual([]);
    expect(budget.workerDenied).toBe(1);
  });

  it("refuses past the queue cap and counts the denial", () => {
    vi.useFakeTimers();
    const budget = steadyStateBudget();
    fillWorkers(budget);
    for (let i = 0; i < MAX_QUEUED_WORKER_STARTS; i++) {
      expect(budget.admitWorker(() => {}).status).toBe("queued");
    }
    const denied = budget.workerDenied;
    expect(budget.admitWorker(() => {})).toEqual({ status: "full" });
    expect(budget.workerDenied).toBe(denied + 1);
  });
});
