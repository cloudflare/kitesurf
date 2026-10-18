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
