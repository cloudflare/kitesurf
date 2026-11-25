// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { OpenSessionInit } from "@kitesurf/jsrpc-types/page-script";
import { openHostedPageEntrypoint } from "../src/eval/page-script.ts";
import type {
  RpcSessionCallable,
  RpcSessionEntrypoint,
} from "../src/eval/page-script-rpc-session.ts";

function makeStub(): {
  stub: RpcSessionEntrypoint;
  kills: Array<string | undefined>;
  disposed: () => boolean;
} {
  const kills: Array<string | undefined> = [];
  let isDisposed = false;
  const stub: RpcSessionEntrypoint = {
    openSession: vi.fn(async () => ({}) as RpcSessionCallable),
    killIsolate: vi.fn(async (reason?: string) => {
      kills.push(reason);
    }),
    [Symbol.dispose]: () => {
      isDisposed = true;
    },
  };
  return { stub, kills, disposed: () => isDisposed };
}

function makeCode(): WorkerLoaderWorkerCode {
  return {
    compatibilityDate: "2026-09-11",
    mainModule: "page.js",
    modules: { "page.js": "export default {}", "baked.wasm": { wasm: new Uint8Array(16) } },
  };
}

describe("openHostedPageEntrypoint", () => {
  it("uses the hosted handle and never falls back on normal open", async () => {
    const hosted = makeStub();
    const loaderLoad = vi.fn();
    const loader: Pick<WorkerLoader, "load"> = { load: loaderLoad };
    const host = { open: vi.fn(() => Promise.resolve(hosted.stub)) };

    const entry = openHostedPageEntrypoint(
      loader,
      host,
      makeCode(),
      { KS_TAIL_TOKEN: "t", KS_ISOLATE_STAMP: "s" },
      "mod-1",
    );

    await entry.openSession({} as OpenSessionInit);
    await entry.killIsolate?.("nav");
    entry[Symbol.dispose]?.();
    await Promise.resolve();

    expect(loaderLoad).not.toHaveBeenCalled();
    expect(hosted.kills).toEqual(["nav"]);
    expect(hosted.disposed()).toBe(true);
  });

  it("falls back to direct load on a stash miss and disposes the direct stub", async () => {
    const direct = makeStub();
    const loaded: WorkerLoaderWorkerCode[] = [];
    const loader: Pick<WorkerLoader, "load"> = {
      load(c) {
        loaded.push(c);
        // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- WorkerStub has a recursive RPC type.
        return { getEntrypoint: () => direct.stub } as unknown as WorkerStub;
      },
    };
    const host = {
      open: vi.fn(() =>
        Promise.reject(new Error("PageIsolateHost.open: missing stashed page modules")),
      ),
    };

    const code = makeCode();
    const entry = openHostedPageEntrypoint(
      loader,
      host,
      code,
      { KS_TAIL_TOKEN: "t", KS_ISOLATE_STAMP: "s" },
      "mod-2",
    );

    await entry.openSession({} as OpenSessionInit);
    await entry.killIsolate?.("close");
    entry[Symbol.dispose]?.();

    expect(loaded).toEqual([code]);
    expect(direct.kills).toEqual(["close"]);
    expect(direct.disposed()).toBe(true);
  });

  it("does not fall back on non-stash-miss errors", async () => {
    const loaderLoad = vi.fn();
    const host = {
      open: vi.fn(() => Promise.reject(new Error("boom"))),
    };

    const entry = openHostedPageEntrypoint(
      { load: loaderLoad },
      host,
      makeCode(),
      { KS_TAIL_TOKEN: "t", KS_ISOLATE_STAMP: "s" },
      "mod-3",
    );

    await expect(entry.openSession({} as OpenSessionInit)).rejects.toThrow("boom");
    expect(loaderLoad).not.toHaveBeenCalled();
  });
});
