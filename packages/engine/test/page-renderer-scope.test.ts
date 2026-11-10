// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("../src/eval/page-script.ts", () => ({
  loadWasmBytesFromVfs: () => new Uint8Array(0),
}));

import type { RenderFrameOpts, RenderPortStub } from "@kitesurf/jsrpc-types/page-renderer";
import { PageRendererManager, type RendererEnv } from "../src/eval/page-renderer.ts";

// The renderer cache serves resources a page reports by hash, so a render RPC may only use the
// resources of the isolate that supplied it.
describe("renderer resource scope", () => {
  it("binds each render RPC to the supplying source", async () => {
    const scopes: Array<string | undefined> = [];
    const record = () => async (_port: RenderPortStub, opts: RenderFrameOpts) => {
      scopes.push(opts.scope);
      return { bytes: new Uint8Array([1]), seq: 1, scrollX: 0, scrollY: 0 };
    };
    const stub = { renderFrame: record(), renderPdf: record() };
    const env = { LOADER: { load: () => ({ getEntrypoint: () => stub }) } };
    const ctx = { exports: { DeniedOutbound: () => ({}), PageScriptTail: () => ({}) } };
    const manager = new PageRendererManager(
      // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- partial platform fixtures.
      env as unknown as RendererEnv,
      // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- partial platform fixtures.
      ctx as unknown as ExecutionContext,
      "test-connection",
    );
    const source = () => ({ getRenderPort: async () => ({}) as RenderPortStub });
    const [a, b] = [source(), source()];
    const frame = { format: "jpeg", quality: 80, omitBackground: false };
    const pdf = {
      paperWidth: 8.5,
      paperHeight: 11,
      omitBackground: false,
      marginTop: 0,
      marginRight: 0,
      marginBottom: 0,
      marginLeft: 0,
    };
    const results = await Promise.all([
      manager.renderFrame(a, frame),
      manager.renderFrame(b, frame),
      manager.renderPdf(a, pdf),
      manager.renderFrame(a, frame),
    ]);
    expect(results.map((result) => result.ok)).toEqual([true, true, true, true]);
    const [aFrame, bFrame, aPdf, aFrameAgain] = scopes;
    expect(aFrame, "every render RPC carries a scope").toBeTruthy();
    expect(aPdf).toBe(aFrame);
    expect(aFrameAgain).toBe(aFrame);
    expect(bFrame).not.toBe(aFrame);
  });
});
