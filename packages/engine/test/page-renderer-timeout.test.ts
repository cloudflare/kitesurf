// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/eval/page-script.ts", () => ({
  loadWasmBytesFromVfs: () => new Uint8Array(0),
}));

import type { RenderPortStub } from "@kitesurf/jsrpc-types/page-renderer";
import { PageRendererManager, type RendererEnv } from "../src/eval/page-renderer.ts";

function harness(renderFrame: () => Promise<unknown>) {
  const counts = { loads: 0, kills: 0 };
  const stub = {
    renderFrame,
    killIsolate: () => {
      counts.kills += 1;
      return Promise.resolve();
    },
  };
  const env = {
    LOADER: {
      get: () => {
        throw new Error("harness: LOADER.get unused");
      },
      load: () => {
        counts.loads += 1;
        // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- partial platform WorkerStub.
        return {
          getEntrypoint: () => stub,
          getDurableObjectClass: () => {
            throw new Error("harness: getDurableObjectClass unused");
          },
        } as unknown as WorkerStub;
      },
    },
    FONT_ASSETS: {
      fetch: () => {
        throw new Error("harness: FONT_ASSETS.fetch unused");
      },
      connect: () => {
        throw new Error("harness: FONT_ASSETS.connect unused");
      },
    },
  } satisfies RendererEnv;
  const ctx = {
    exports: {
      DeniedOutbound: () => ({}),
      PageScriptTail: () => ({}),
      SpanSink: () => ({}),
    },
    waitUntil: () => {},
    passThroughOnException: () => {},
  };
  const manager = new PageRendererManager(
    env,
    // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- partial renderer context fixture.
    ctx as unknown as ExecutionContext,
    "test-connection",
  );
  const source = { getRenderPort: async () => ({}) as RenderPortStub };
  const render = () =>
    manager.renderFrame(source, {
      format: "jpeg",
      quality: 80,
      omitBackground: false,
    });
  return { counts, render };
}

describe("renderer retry policy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not retry a renderFrame that never returns", async () => {
    const { counts, render } = harness(() => new Promise(() => {}));
    const p = render();
    await vi.advanceTimersByTimeAsync(40_000);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timeout/);
    expect(counts.kills).toBe(1);
    expect(counts.loads).toBe(1);
  });

  it("still retries a raster-stage failure reply", async () => {
    const { counts, render } = harness(async () => ({
      error: "boom",
      stage: "raster",
    }));
    const p = render();
    await vi.advanceTimersByTimeAsync(40_000);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(counts.loads).toBe(2);
  });

  it("does not relaunch on a record-stage failure reply", async () => {
    const { counts, render } = harness(async () => ({
      error: "dying generation",
      stage: "record",
    }));
    const p = render();
    await vi.advanceTimersByTimeAsync(40_000);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.stage).toBe("record");
    expect(counts.loads).toBe(1);
    expect(counts.kills).toBe(0);
  });
});
