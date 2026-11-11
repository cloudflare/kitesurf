// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { makeMainFrameState } from "../src/cdp/frames.ts";
import { closeTargetInternal, createPageTarget } from "../src/cdp/target.ts";
import type { DispatchCtx } from "../src/cdp/dispatch.ts";
import type { PageScriptStub } from "../src/eval/page-script.ts";
import { DynamicWorkerBudget } from "../src/eval/worker-budget.ts";
import { DedicatedWorkers } from "../src/cdp/dedicated-workers.ts";
import { SANDBOX_ALLOW_ALL } from "@kitesurf/script-gate";
import {
  notifyIsolateLimit,
  registerIsolateLimitListener,
  unregisterIsolateLimitListener,
} from "../src/eval/limit-registry.ts";

function makeCtx(budget: DynamicWorkerBudget, background: Promise<unknown>[]) {
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- partial DispatchCtx teardown fixture.
  return {
    browser: {
      targets: new Map(),
      screencasts: new Map(),
      workerBudget: budget,
      dedicatedWorkers: new DedicatedWorkers(budget, (p: Promise<unknown>) => {
        background.push(p);
      }),
      networkEvents: {
        deleteTargetAttribution: vi.fn(),
        forgetSession: vi.fn(),
      },
      layoutMode: "full",
    },
    emit: vi.fn(),
    ctx: {
      waitUntil: (promise: Promise<unknown>) => {
        background.push(promise);
      },
    },
    connectionId: "test",
  } as unknown as DispatchCtx;
}

describe("closeTargetInternal", () => {
  it("does not await an in-flight OOPIF prespawn", async () => {
    const budget = new DynamicWorkerBudget();
    const background: Promise<unknown>[] = [];
    const ctx = makeCtx(budget, background);
    const target = createPageTarget(ctx, "https://example.com");
    const frame = makeMainFrameState({
      frameId: "child",
      loaderId: "child-loader",
      url: "https://example.net",
    });
    frame.parentFrameId = target.frameId;
    frame.pageScriptLease = budget.acquire("oopif");
    frame.oopifPrespawn = {
      url: frame.url,
      sandbox: SANDBOX_ALLOW_ALL,
      ancestorOrigins: [],
      promise: new Promise<never>(() => {}),
    };
    target.frames.set(frame.frameId, frame);

    const closing = closeTargetInternal(ctx, target.targetId);
    expect(budget.liveOf("oopif")).toBe(0);
    await expect(closing).resolves.toBe(true);
    expect(background).toHaveLength(1);
  });

  it("awaits its PageScript isolate teardown", async () => {
    const budget = new DynamicWorkerBudget();
    const ctx = makeCtx(budget, []);
    const target = createPageTarget(ctx, "https://example.com");
    let releaseKill = () => {};
    // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- partial lifecycle RPC stub.
    target.pageScript = {
      close: vi.fn(),
      killIsolate: vi.fn(() => new Promise<void>((resolve) => (releaseKill = resolve))),
    } as unknown as PageScriptStub;
    target.pageScriptLease = budget.acquire("pageScript");

    const closing = closeTargetInternal(ctx, target.targetId);
    let closed = false;
    void closing.then(() => (closed = true));
    await Promise.resolve();

    expect(target.pageScript).toBeNull();
    expect(budget.liveOf("pageScript")).toBe(0);
    expect(closed).toBe(false);

    releaseKill();
    await expect(closing).resolves.toBe(true);
    expect(budget.isolatesKilled).toBe(1);
  });

  it("retires the target's isolate-limit listener and keeps its sibling's", async () => {
    const ctx = makeCtx(new DynamicWorkerBudget(), []);
    const fired: string[] = [];
    const target = createPageTarget(ctx, "https://example.com");
    const sibling = createPageTarget(ctx, "https://example.net");
    for (const t of [target, sibling]) {
      registerIsolateLimitListener(t.targetId, () => fired.push(t.url), {
        owner: "test",
        targetId: t.targetId,
      });
    }
    await closeTargetInternal(ctx, target.targetId);
    for (const t of [target, sibling]) {
      notifyIsolateLimit(t.targetId, { kind: "cpu", capMs: 50, fromTail: true });
    }
    unregisterIsolateLimitListener(sibling.targetId);
    expect(fired).toEqual(["https://example.net"]);
  });
});
