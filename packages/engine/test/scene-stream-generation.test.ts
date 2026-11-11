// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0
import { expect, test, vi } from "vitest";
import type { DispatchCtx } from "../src/cdp/dispatch.ts";
import { sceneStreamCommand, type SceneStreamRequest } from "../src/cdp/scene-stream.ts";
import type { TargetState } from "../src/cdp/types.ts";
import type { PageScriptStub } from "../src/eval/page-script.ts";
// One font-data entry (hash 5) with a one-byte inline body.
const fontBatch = new Uint8Array([1, 0, 0, 0, 3, 5, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0]);
test("delivered scene resources reset per navigation generation", async () => {
  const records: Array<{ haveFonts?: Uint8Array }> = [];
  const stub = {
    queryDom: (_method: string, args: { haveFonts?: Uint8Array }) => {
      records.push(args);
      return Promise.resolve({ scene: new Uint8Array(1), resourceBatch: fontBatch });
    },
  } as PageScriptStub;
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
  try {
    await send("Kitesurf.startSceneStream", { width: 800, height: 600 });
    await vi.waitFor(() => expect(records.at(-1)?.haveFonts?.length).toBe(8));
    const before = records.length;
    target.navigateGeneration = 1;
    await vi.waitFor(() => expect(records.length).toBeGreaterThan(before));
    expect(records[before]?.haveFonts?.length).toBe(0);
  } finally {
    await send("Kitesurf.stopSceneStream");
  }
});
