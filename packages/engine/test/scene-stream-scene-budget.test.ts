// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0
import { expect, test, vi } from "vitest";
import type { DispatchCtx } from "../src/cdp/dispatch.ts";
import { sceneStreamCommand, type SceneStreamRequest } from "../src/cdp/scene-stream.ts";
import type { TargetState } from "../src/cdp/types.ts";
import type { PageScriptStub } from "../src/eval/page-script.ts";
import { MAX_CONCURRENT_READ_BYTES } from "../src/read-capped.ts";

test("warns once when a scene is over the read cap", async () => {
  const oversized = new Uint8Array(MAX_CONCURRENT_READ_BYTES + 1);
  let records = 0;
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only recordScene is stubbed.
  const stub = {
    queryDom: () => {
      records++;
      return Promise.resolve({ scene: oversized, resourceBatch: null });
    },
  } as unknown as PageScriptStub;
  const target = {
    targetId: "t",
    type: "page",
    frames: new Map(),
    pageScript: stub,
    navigateGeneration: 0,
  } as TargetState;
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- partial dispatch context fixture.
  const ctx = {
    browser: { targets: new Map([["t", target]]) },
    emit: () => {},
    ctx: { waitUntil: () => {} },
  } as unknown as DispatchCtx;
  const send = (method: SceneStreamRequest["method"], params: Record<string, unknown> = {}) =>
    sceneStreamCommand(ctx, { id: 1, method, params } as SceneStreamRequest);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await send("Kitesurf.startSceneStream", { width: 800, height: 600 });
    await vi.waitFor(() => expect(records).toBeGreaterThanOrEqual(2));
    const overBudget = warn.mock.calls.filter((call) => String(call[0]).includes("scene of"));
    expect(overBudget).toHaveLength(1);
    expect(String(overBudget[0]?.[0])).toContain(String(oversized.length));
    expect(String(overBudget[0]?.[0])).toContain(String(MAX_CONCURRENT_READ_BYTES));
  } finally {
    warn.mockRestore();
    await send("Kitesurf.stopSceneStream");
  }
});
