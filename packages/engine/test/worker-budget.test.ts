// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";

import { DynamicWorkerBudget } from "../src/eval/worker-budget.ts";

function steadyStateBudget(): DynamicWorkerBudget {
  const budget = new DynamicWorkerBudget();
  budget.acquire("pageScript");
  budget.acquire("renderer");
  return budget;
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
    const worker = budget.acquire("worker");
    worker?.release();
    worker?.release();
    const frame = budget.acquire("oopif");
    expect(frame).not.toBeNull();
    expect(budget.acquire("oopif")).toBeNull();
    expect(budget.acquire("worker")).toBeNull();

    const active = budget.snapshot();
    expect(active).toEqual({
      live: 3,
      peak: 3,
      liveByKind: { pageScript: 1, renderer: 1, oopif: 1, worker: 0 },
      peakByKind: { pageScript: 2, renderer: 1, oopif: 1, worker: 1 },
      oopifDenied: 1,
      workerDenied: 1,
    });

    newPage?.release();
    renderer?.release();
    frame?.release();
    expect(budget.snapshot()).toEqual({
      ...active,
      live: 0,
      liveByKind: { pageScript: 0, renderer: 0, oopif: 0, worker: 0 },
    });
    expect(active.liveByKind).toEqual({ pageScript: 1, renderer: 1, oopif: 1, worker: 0 });
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
    const worker = budget.acquire("worker");
    expect(worker).not.toBeNull();
    expect(budget.canSpawnOopif()).toBe(false);
    expect(budget.acquire("oopif")).toBeNull();
    expect(budget.acquire("worker")).toBeNull();
    expect(budget.workerDenied).toBe(1);

    worker?.release();
    const frame = budget.acquire("oopif");
    expect(frame).not.toBeNull();
    expect(budget.acquire("worker")).toBeNull();
    expect(budget.workerDenied).toBe(2);
  });

  it("keeps the unloaded renderer's reserved slot out of reach", () => {
    const budget = new DynamicWorkerBudget();
    budget.acquire("pageScript");
    const worker = budget.acquire("worker");
    expect(worker).not.toBeNull();
    expect(budget.acquire("worker")).toBeNull();
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
