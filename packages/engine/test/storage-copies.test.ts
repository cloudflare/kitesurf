// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import type { WebStorageParams, WebStorageReply } from "@kitesurf/jsrpc-types/page-script";

import type { DispatchCtx } from "../src/cdp/dispatch.ts";
import { changeLocalStorage, StorageCopy } from "../src/cdp/storage-copies.ts";
import type { CdpEvent, TargetState } from "../src/cdp/types.ts";
import type { PageScriptStub } from "../src/eval/page-script.ts";
import { LOCAL_STORAGE_AREA_LIMIT_UNITS, LocalStorage } from "../src/state/local-storage.ts";
import { MemorySessionStore } from "../src/state/session-store.ts";

const A = "https://a.test";

function fakeStub() {
  const calls: WebStorageParams[] = [];
  const stub = {
    webStorage: async (params: WebStorageParams): Promise<WebStorageReply> => {
      calls.push(params);
      return { seq: 0 };
    },
  } as PageScriptStub;
  return { stub, calls };
}

function setup() {
  const targets = new Map<string, TargetState>();
  const emitted: CdpEvent[] = [];
  const storage = new LocalStorage(new MemorySessionStore());
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only the fields these read.
  const ctx = {
    browser: { targets, localStorage: storage, contexts: new Map() },
    emit: (e: CdpEvent) => emitted.push(e),
  } as unknown as DispatchCtx;
  const page = (id: string, url = `${A}/`) => {
    const target = {
      targetId: id,
      type: "page",
      navigateGeneration: 1,
      url,
      pageScriptUrl: url,
      domStorageSessions: new Set<string>(),
    } as TargetState;
    targets.set(id, target);
    const { stub, calls } = fakeStub();
    const copy = new StorageCopy(targets, target, 1, stub, storage, new URL(url).origin, url);
    copy.seed();
    return { target, copy, calls };
  };
  return { ctx, storage, emitted, page };
}

describe("changeLocalStorage", () => {
  it("sends a page's changes to the other live copies of the origin, not back to it", async () => {
    const { ctx, storage, page } = setup();
    const one = page("one");
    const two = page("two");
    const other = page("other", "https://b.test/");
    const ops = [{ op: "set", key: "k", value: "v" }] as const;
    await changeLocalStorage(ctx, storage, A, ops, { source: one.copy, url: one.copy.url });
    expect(one.calls).toEqual([]);
    expect(two.calls).toEqual([{ op: "apply", area: "local", ops, url: `${A}/` }]);
    expect(other.calls).toEqual([]);
    expect(storage.entries(A)).toEqual([["k", "v"]]);
  });

  it("skips a copy whose document was replaced or whose target closed", async () => {
    const { ctx, storage, page } = setup();
    const replaced = page("replaced");
    const closed = page("closed");
    replaced.target.navigateGeneration = 2;
    ctx.browser.targets.delete("closed");
    await changeLocalStorage(ctx, storage, A, [{ op: "clear" }], { url: null });
    expect(replaced.calls).toEqual([]);
    expect(closed.calls).toEqual([]);
  });

  it("does not send a set the area limit dropped", async () => {
    const { ctx, storage, page } = setup();
    const two = page("two");
    const huge = "x".repeat(LOCAL_STORAGE_AREA_LIMIT_UNITS);
    const result = await changeLocalStorage(
      ctx,
      storage,
      A,
      [{ op: "set", key: "k", value: huge }],
      {
        url: null,
      },
    );
    expect(result.applied).toEqual([]);
    expect(two.calls).toEqual([]);
  });

  it("emits DOMStorage events to sessions on a page of the origin", async () => {
    const { ctx, storage, emitted, page } = setup();
    const watcher = page("watcher");
    watcher.target.domStorageSessions.add("s1");
    page("elsewhere", "https://b.test/").target.domStorageSessions.add("s2");
    const ops = [
      { op: "set", key: "k", value: "1" },
      { op: "set", key: "k", value: "1" },
      { op: "set", key: "k", value: "2" },
      { op: "remove", key: "k" },
      { op: "remove", key: "missing" },
      { op: "clear" },
      { op: "set", key: "j", value: "3" },
      { op: "clear" },
    ] as const;
    await changeLocalStorage(ctx, storage, A, ops, { url: null });
    const storageId = { securityOrigin: A, storageKey: `${A}/`, isLocalStorage: true };
    expect(emitted).toEqual([
      {
        method: "DOMStorage.domStorageItemAdded",
        params: { storageId, key: "k", newValue: "1" },
        sessionId: "s1",
      },
      {
        method: "DOMStorage.domStorageItemUpdated",
        params: { storageId, key: "k", oldValue: "1", newValue: "2" },
        sessionId: "s1",
      },
      {
        method: "DOMStorage.domStorageItemRemoved",
        params: { storageId, key: "k" },
        sessionId: "s1",
      },
      {
        method: "DOMStorage.domStorageItemAdded",
        params: { storageId, key: "j", newValue: "3" },
        sessionId: "s1",
      },
      { method: "DOMStorage.domStorageItemsCleared", params: { storageId }, sessionId: "s1" },
    ]);
  });
});

describe("StorageCopy.settled", () => {
  it("waits for the batch and gives up after the deadline", async () => {
    const { page } = setup();
    const { copy } = page("one");
    let done = false;
    const waiting = copy.settled(2, 60_000).then(() => (done = true));
    copy.received(1);
    await Promise.resolve();
    expect(done).toBe(false);
    copy.received(2);
    await waiting;
    expect(done).toBe(true);
    await copy.settled(1, 60_000);
    const started = Date.now();
    await copy.settled(3, 20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });
});
