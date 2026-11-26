// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerUpstreamHandler } from "../src/eval/dedicated-worker.ts";

type SpawnOpts = {
  label: string;
  origin: string;
  onUpstream: WorkerUpstreamHandler;
};
const spawned: Array<{
  terminate: ReturnType<typeof vi.fn>;
  deliverMessage: ReturnType<typeof vi.fn>;
  opts: SpawnOpts;
}> = [];
vi.mock("../src/eval/dedicated-worker.ts", () => ({
  spawnDedicatedWorker: (_env: unknown, _ctx: unknown, opts: SpawnOpts) => {
    const handle = {
      opts,
      start: vi.fn(async () => ({ ok: true })),
      deliverMessage: vi.fn(async () => {}),
      terminate: vi.fn(async () => {}),
    };
    spawned.push(handle);
    return handle;
  },
}));

import { DedicatedWorkers, MAX_PENDING_WORKER_MESSAGES } from "../src/cdp/dedicated-workers.ts";
import {
  DynamicWorkerBudget,
  MAX_DYNAMIC_WORKERS,
  MAX_WORKER_QUEUE_WAIT_MS,
} from "../src/eval/worker-budget.ts";
import { notifyIsolateLimit } from "../src/eval/limit-registry.ts";
import type { DispatchCtx } from "../src/cdp/dispatch.ts";
import type { TargetState } from "../src/cdp/types.ts";
import type { PageScriptStub } from "../src/eval/page-script.ts";
import { testClient } from "./client-state.ts";

const PAGE = "https://example.test/app.html";
const PAGE_ORIGIN = "https://example.test";

function fakeStub() {
  const delivered: unknown[] = [];
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- partial worker-event RPC fixture.
  const stub = {
    deliverWorkerEvent: vi.fn(async (p: unknown) => {
      delivered.push(p);
      return { ok: true };
    }),
  } as unknown as PageScriptStub;
  return { stub, delivered };
}

function setup(env: Record<string, string> = {}) {
  const budget = new DynamicWorkerBudget();
  budget.acquire("pageScript");
  budget.acquire("renderer");
  const workers = new DedicatedWorkers(budget, () => {});
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only worker-owner fields are set.
  const target = {
    targetId: "t1",
    frameId: "t1",
    browserContextId: undefined,
    extraHeaders: {},
    userAgentOverride: "",
  } as unknown as TargetState;
  const ctx = {
    browser: {
      wsClosing: false,
      isolateCapOverrides: undefined,
      sandboxOutbound: {},
      targets: new Map([["t1", target]]),
    },
    env: { LOADER: {}, ...env },
    ctx: {},
    connectionId: "c1",
    client: testClient(),
  } as DispatchCtx;
  const page = fakeStub();
  const owner = workers.ownerFor(target, "t1", page.stub, PAGE, "l1", PAGE_ORIGIN);
  const create = (workerId: number, own = owner, url = "blob:https://example.test/1") =>
    workers.handle(ctx, own, "kitesurf.workerCreate", {
      workerId,
      url,
      name: "",
      source: "postMessage(1)",
      navigator: {},
    });
  return { budget, workers, delivered: page.delivered, target, ctx, owner, create };
}

const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("DedicatedWorkers", () => {
  beforeEach(() => {
    spawned.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("takes a worker lease and gives it back on terminate", async () => {
    const { budget, workers, create, ctx, owner } = setup();
    create(1);
    await settle();
    expect(budget.liveOf("worker")).toBe(1);
    expect(spawned[0]!.opts.origin).toBe("https://example.test");
    workers.handle(ctx, owner, "kitesurf.workerTerminate", { workerId: 1 });
    expect(budget.liveOf("worker")).toBe(0);
    expect(spawned[0]!.terminate).toHaveBeenCalledOnce();
  });

  it("holds a worker past the budget and starts it when a slot frees", async () => {
    const { budget, workers, create, ctx, owner, delivered } = setup();
    // pageScript, renderer and one navigation slot are already taken.
    const cap = MAX_DYNAMIC_WORKERS - 3;
    for (let id = 1; id <= cap; id++) create(id);
    await settle();
    expect(spawned).toHaveLength(cap);
    expect(budget.liveOf("worker")).toBe(cap);

    // A worker beyond the cap waits instead of failing.
    create(cap + 1);
    await settle();
    expect(spawned).toHaveLength(cap);
    expect(delivered).toEqual([]);

    workers.handle(ctx, owner, "kitesurf.workerTerminate", { workerId: 1 });
    await settle();
    expect(spawned).toHaveLength(cap + 1);
    expect(budget.liveOf("worker")).toBe(cap);
    expect(delivered).toEqual([]);
  });

  it("buffers messages posted to a queued worker and cancels a terminated queued worker", async () => {
    const { budget, workers, create, ctx, owner, delivered } = setup();
    const cap = MAX_DYNAMIC_WORKERS - 3;
    for (let id = 1; id <= cap; id++) create(id);
    await settle();

    // Queue one worker and terminate it before a slot frees, and queue another with buffered posts.
    create(cap + 1);
    workers.handle(ctx, owner, "kitesurf.workerTerminate", { workerId: cap + 1 });
    create(cap + 2);
    workers.handle(ctx, owner, "kitesurf.workerPostMessage", { workerId: cap + 2, data: "first" });
    workers.handle(ctx, owner, "kitesurf.workerPostMessage", { workerId: cap + 2, data: "second" });
    await settle();
    expect(spawned).toHaveLength(cap);

    // Freeing a slot skips the terminated worker and delivers buffered posts to the live one.
    workers.handle(ctx, owner, "kitesurf.workerTerminate", { workerId: 1 });
    await settle();
    expect(spawned).toHaveLength(cap + 1);
    expect(spawned[cap]!.opts.label).toContain(`-${cap + 2}`);
    expect(spawned[cap]!.deliverMessage).toHaveBeenNthCalledWith(1, "first");
    expect(spawned[cap]!.deliverMessage).toHaveBeenNthCalledWith(2, "second");
    expect(budget.liveOf("worker")).toBe(cap);
    expect(delivered).toEqual([]);
  });

  it("fails a queued worker with an error when the slot wait deadline expires", async () => {
    vi.useFakeTimers();
    const { budget, workers, create, ctx, owner, delivered } = setup();
    const cap = MAX_DYNAMIC_WORKERS - 3;
    for (let id = 1; id <= cap; id++) create(id);
    await vi.advanceTimersByTimeAsync(0);

    create(cap + 1);
    await vi.advanceTimersByTimeAsync(MAX_WORKER_QUEUE_WAIT_MS);
    expect(spawned).toHaveLength(cap);
    expect(delivered).toContainEqual(
      expect.objectContaining({
        workerId: cap + 1,
        type: "error",
        message: "Failed to start worker: no isolate slot is free for this worker",
      }),
    );
    expect(delivered).toContainEqual({ workerId: cap + 1, type: "closed" });

    // Freeing a slot afterward must not spawn the timed-out worker.
    workers.handle(ctx, owner, "kitesurf.workerTerminate", { workerId: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(spawned).toHaveLength(cap);
    expect(budget.liveOf("worker")).toBe(cap - 1);
  });

  it("fails a queued worker when buffered postMessage count exceeds the cap", async () => {
    vi.useFakeTimers();
    const { workers, create, ctx, owner, delivered } = setup();
    const cap = MAX_DYNAMIC_WORKERS - 3;
    for (let id = 1; id <= cap; id++) create(id);
    await vi.advanceTimersByTimeAsync(0);

    create(cap + 1);
    for (let i = 0; i <= MAX_PENDING_WORKER_MESSAGES; i++) {
      workers.handle(ctx, owner, "kitesurf.workerPostMessage", { workerId: cap + 1, data: i });
    }
    expect(delivered).toContainEqual(
      expect.objectContaining({
        workerId: cap + 1,
        type: "error",
        message: "Worker message queue limit exceeded before startup",
      }),
    );
    expect(delivered).toContainEqual({ workerId: cap + 1, type: "closed" });
  });

  it("delivers more than the queued cap when a starting worker already holds a slot", async () => {
    const { workers, create, ctx, owner, delivered } = setup();
    create(1);
    const total = MAX_PENDING_WORKER_MESSAGES + 1;
    for (let i = 0; i < total; i++) {
      workers.handle(ctx, owner, "kitesurf.workerPostMessage", { workerId: 1, data: i });
    }
    await settle();
    expect(delivered).toEqual([]);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.deliverMessage).toHaveBeenCalledTimes(total);
    expect(spawned[0]!.deliverMessage).toHaveBeenNthCalledWith(1, 0);
    expect(spawned[0]!.deliverMessage).toHaveBeenNthCalledWith(total, total - 1);
  });

  it("keeps workers of different documents apart even with equal ids", async () => {
    const { workers, create, budget, target } = setup();
    create(1);
    await settle();
    workers.terminateTarget("t1", "parent navigate");
    const next = workers.ownerFor(target, "t1", fakeStub().stub, PAGE, "l2", PAGE_ORIGIN);
    create(1, next);
    await settle();
    expect(spawned).toHaveLength(2);
    expect(budget.liveOf("worker")).toBe(1);
  });

  it("refuses a worker from a document whose workers were already torn down", async () => {
    const { workers, create, budget, delivered } = setup();
    workers.terminateTarget("t1", "parent navigate");
    create(1);
    await settle();
    expect(spawned).toHaveLength(0);
    expect(budget.liveOf("worker")).toBe(0);
    expect(delivered[0]).toMatchObject({ workerId: 1, type: "error" });
  });

  it("delivers a worker's messages only to the isolate that created it", async () => {
    const { workers, create, ctx, owner, target, delivered } = setup();
    create(1);
    await settle();
    const newer = fakeStub();
    workers.ownerFor(target, "t1", newer.stub, PAGE, "l2", PAGE_ORIGIN);
    workers.handle(ctx, owner, "kitesurf.workerPostMessage", { workerId: 1, data: "x" });
    expect(spawned[0]!.deliverMessage).toHaveBeenCalledWith("x");
    spawned[0]!.opts.onUpstream({ event: "worker.message", params: { data: "reply" } });
    expect(delivered).toEqual([{ workerId: 1, type: "message", data: "reply" }]);
    expect(newer.delivered).toEqual([]);
  });

  it("enforces the page wall cap on the worker", async () => {
    vi.useFakeTimers();
    const { create, delivered, budget } = setup({ KITESURF_PAGE_WALL_MS_CAP: "5000" });
    create(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(budget.liveOf("worker")).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(budget.liveOf("worker")).toBe(0);
    expect(spawned[0]!.terminate).toHaveBeenCalledOnce();
    expect(spawned[0]!.terminate, "the isolate is still alive").toHaveBeenCalledWith(
      expect.any(String),
      { gone: false },
    );
    expect(delivered).toContainEqual({ workerId: 1, type: "closed" });
  });

  it("retires a worker its tail reports as killed by a limit", async () => {
    const { create, delivered, budget } = setup();
    create(1);
    await settle();
    notifyIsolateLimit(spawned[0]!.opts.label, { kind: "cpu", capMs: 0, fromTail: true });
    expect(budget.liveOf("worker")).toBe(0);
    expect(spawned[0]!.terminate, "the platform ended the isolate").toHaveBeenCalledWith(
      expect.any(String),
      { gone: true },
    );
    expect(delivered).toContainEqual({ workerId: 1, type: "closed" });
  });

  it("retires a worker whose message delivery fails", async () => {
    const { create, delivered, budget, workers, ctx, owner } = setup();
    create(1);
    await settle();
    spawned[0]!.deliverMessage.mockRejectedValueOnce(new Error("isolate gone"));
    workers.handle(ctx, owner, "kitesurf.workerPostMessage", { workerId: 1, data: "x" });
    await settle();
    expect(budget.liveOf("worker")).toBe(0);
    expect(delivered).toContainEqual({ workerId: 1, type: "closed" });
  });

  it("seals blob workers with the creator's origin and refuses cross-origin http", async () => {
    const { create, delivered } = setup();
    create(1, undefined, "https://other.test/w.js");
    await settle();
    expect(spawned).toHaveLength(0);
    expect(delivered[0]).toMatchObject({ workerId: 1, type: "error" });
  });
});
