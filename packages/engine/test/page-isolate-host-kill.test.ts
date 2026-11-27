// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageRendererEntrypoint } from "@kitesurf/jsrpc-types/page-renderer";
import {
  KILL_REPLY_WAIT_MS,
  PageIsolateHandle,
  RendererIsolateHandle,
} from "../src/eval/page-isolate-host.ts";
import type {
  RpcSessionCallable,
  RpcSessionEntrypoint,
} from "../src/eval/page-script-rpc-session.ts";

function pageHandle(kill: (reason?: string) => Promise<unknown>): PageIsolateHandle {
  const entrypoint: RpcSessionEntrypoint = {
    openSession: vi.fn(async () => ({}) as RpcSessionCallable),
    killIsolate: vi.fn(kill),
  };
  return new PageIsolateHandle(entrypoint);
}

function rendererHandle(kill: (reason?: string) => Promise<unknown>): RendererIsolateHandle {
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only killIsolate is exercised.
  const entrypoint = { killIsolate: vi.fn(kill) } as unknown as Fetcher<PageRendererEntrypoint>;
  return new RendererIsolateHandle(entrypoint);
}

async function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  await vi.advanceTimersByTimeAsync(ms);
  return settled;
}

const NEVER = (): Promise<unknown> => new Promise(() => {});

describe("hosted isolate kills", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  for (const [name, make] of [
    ["page", pageHandle],
    ["renderer", rendererHandle],
  ] as const) {
    it(`${name}: settles when the aborted isolate never replies`, async () => {
      const kill = vi.fn(NEVER);
      const killing = make(kill).killIsolate("nav");
      expect(kill).toHaveBeenCalledWith("nav");
      expect(await settledWithin(killing, KILL_REPLY_WAIT_MS - 1)).toBe(false);
      expect(await settledWithin(killing, 1)).toBe(true);
    });

    it(`${name}: settles at once, without rejecting, when the abort fails the call`, async () => {
      const handle = make(() => Promise.reject(new Error("abortIsolate() was called.")));
      const killing = handle.killIsolate("nav");
      expect(await settledWithin(killing, 0)).toBe(true);
      await expect(killing).resolves.toBeUndefined();
    });
  }

  it("waits less than the engine's 1s teardown grace", () => {
    expect(KILL_REPLY_WAIT_MS).toBeLessThan(1_000);
  });
});
