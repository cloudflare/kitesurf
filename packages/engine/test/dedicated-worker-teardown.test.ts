// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { spawnDedicatedWorker } from "../src/eval/dedicated-worker.ts";

function harness(opts: { openError?: Error; deliverError?: Error } = {}) {
  const kills: string[] = [];
  const session = {
    start: async () => ({ ok: true }),
    deliverMessage: async () => {
      if (opts.deliverError) throw opts.deliverError;
    },
    close: async () => {},
  };
  const entrypoint = {
    openSession: async () => {
      if (opts.openError) throw opts.openError;
      return session;
    },
    killIsolate: async (reason: string) => {
      kills.push(reason);
    },
  };
  const env = { LOADER: { load: () => ({ getEntrypoint: () => entrypoint }) } };
  const ctx = { exports: { PageScriptTail: () => ({}) } };
  const handle = spawnDedicatedWorker(
    // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- partial WorkerLoader fixture.
    env as unknown as { LOADER: WorkerLoader },
    // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- partial loader context fixture.
    ctx as unknown as ExecutionContext,
    {
      connectionId: "c1",
      cookieKey: "k1",
      label: "worker-1",
      origin: "https://example.test",
      creatorUrl: "https://example.test/",
      frameId: "f1",
      loaderId: "l1",
      extraHeaders: {},
      cpuMs: 1_000,
      source: "postMessage(1)",
      sandboxOutbound: {
        loaded: () => ({}),
        session: () => ({ outbound: async () => new Response(null), cancelBodies() {} }),
      } as never,
      onUpstream: () => {},
    },
  );
  return { handle, kills };
}

describe("dedicated worker teardown", () => {
  it("kills a live worker", async () => {
    const { handle, kills } = harness();
    await handle.deliverMessage("x");
    await handle.terminate("parent navigate");
    expect(kills).toEqual(["parent navigate"]);
  });

  it("does not kill a worker whose session never opened", async () => {
    const { handle, kills } = harness({
      openError: new Error("Too many dynamic workers are starting concurrently."),
    });
    await expect(handle.deliverMessage("x")).rejects.toThrow(/starting concurrently/);
    await handle.terminate("start failed");
    expect(kills, "a kill would start the isolate only to abort it").toEqual([]);
  });

  it("does not kill a worker evicted while it was busy", async () => {
    const { handle, kills } = harness({ deliverError: new Error("Too many dynamic workers.") });
    await expect(handle.deliverMessage("x")).rejects.toThrow(/Too many dynamic workers/);
    await handle.terminate("delivery failed");
    expect(kills).toEqual([]);
  });

  it("does not kill a worker the platform already ended", async () => {
    const { handle, kills } = harness();
    await handle.deliverMessage("x");
    await handle.terminate("cpu limit", { gone: true });
    expect(kills).toEqual([]);
  });

  it("collects garbage once a terminated worker is torn down", async () => {
    // Only Date is fake: the gc throttle is module state, so start well clear of it.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 0, 1, 1));
    const gc = vi.fn();
    vi.stubGlobal("gc", gc);
    try {
      const { handle, kills } = harness();
      await handle.deliverMessage("x");
      await handle.terminate("worker.terminate()");
      expect(kills).toEqual(["worker.terminate()"]);
      expect(gc).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
