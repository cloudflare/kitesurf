// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import type { WebStorageParams, WebStorageReply } from "@kitesurf/jsrpc-types/page-script";

import type { DispatchCtx } from "../src/cdp/dispatch.ts";
import { changeLocalStorage, opChunks, StorageCopy } from "../src/cdp/storage-copies.ts";
import type { CdpEvent, TargetState } from "../src/cdp/types.ts";
import type { PageScriptStub } from "../src/eval/page-script.ts";
import {
  LOCAL_STORAGE_AREA_LIMIT_UNITS,
  LOCAL_STORAGE_QUOTA_UNITS,
  LocalStorage,
} from "../src/state/local-storage.ts";
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
  const page = (id: string, url = `${A}/`, seeded = true) => {
    const target = {
      targetId: id,
      type: "page",
      navigateGeneration: 1,
      url,
      pageScriptUrl: url,
      domStorageSessions: new Map(),
    } as TargetState;
    targets.set(id, target);
    const { stub, calls } = fakeStub();
    const copy = new StorageCopy(targets, target, 1, stub, storage, new URL(url).origin, url);
    if (seeded) void copy.seed();
    return { target, copy, calls };
  };
  return { ctx, storage, emitted, page };
}

describe("changeLocalStorage", () => {
  it("sends a page's changes to the other live copies of the origin and acks the page", async () => {
    const { ctx, storage, page } = setup();
    const one = page("one");
    const two = page("two");
    const other = page("other", "https://b.test/");
    const ops = [{ op: "set", key: "k", value: "v" }] as const;
    const from = { source: one.copy, seq: 3, url: one.copy.url };
    await changeLocalStorage(ctx, storage, A, ops, from);
    expect(one.calls).toEqual([{ op: "apply", area: "local", ops: [], url: null, seq: 3 }]);
    expect(two.calls).toEqual([{ op: "apply", area: "local", ops, url: `${A}/`, seq: 0 }]);
    expect(other.calls).toEqual([]);
    expect(storage.entries(A)).toEqual([["k", "v"]]);
    // A later change from elsewhere tells each copy which of its own batches the area holds.
    await changeLocalStorage(ctx, storage, A, [{ op: "clear" }], { url: null });
    expect(one.calls.at(-1)).toMatchObject({ ops: [{ op: "clear" }], seq: 3 });
    expect(two.calls.at(-1)).toMatchObject({ ops: [{ op: "clear" }], seq: 0 });
  });

  it("sends a tab's sessionStorage changes to its copy as the session area", async () => {
    const { ctx, storage, page } = setup();
    const { target } = page("one");
    const { stub, calls } = fakeStub();
    const tab = storage.forTab("one");
    const copy = new StorageCopy(ctx.browser.targets, target, 1, stub, tab, A, `${A}/`);
    tab.apply(A, [{ op: "set", key: "step", value: "1" }]);
    expect(await copy.seed()).toEqual([["step", "1"]]);
    await changeLocalStorage(ctx, tab, A, [{ op: "set", key: "step", value: "2" }], { url: null });
    expect(calls).toEqual([
      {
        op: "apply",
        area: "session",
        ops: [{ op: "set", key: "step", value: "2" }],
        url: null,
        seq: 0,
      },
    ]);
    expect(storage.entries(A)).toEqual([]);
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

  it("sends a set the area limit dropped to no copy, and the area's value to its source", async () => {
    const { ctx, storage, page } = setup();
    const one = page("one");
    const two = page("two");
    storage.apply(A, [{ op: "set", key: "k", value: "old" }]);
    const huge = "x".repeat(LOCAL_STORAGE_AREA_LIMIT_UNITS);
    const ops = [
      { op: "set", key: "k", value: huge },
      { op: "set", key: "new", value: huge },
    ] as const;
    const from = { source: one.copy, seq: 1, url: one.copy.url };
    const result = await changeLocalStorage(ctx, storage, A, ops, from);
    expect(result.applied).toEqual([]);
    expect(two.calls).toEqual([]);
    const fixes = [
      { op: "set", key: "k", value: "old" },
      { op: "remove", key: "new" },
    ];
    expect(one.calls).toEqual([{ op: "apply", area: "local", ops: fixes, url: null, seq: 1 }]);
  });

  it("holds a change from no page to the quota, and a page's batch to the area limit", async () => {
    const { ctx, storage, page } = setup();
    const one = page("one");
    const set = [{ op: "set", key: "k", value: "x".repeat(LOCAL_STORAGE_QUOTA_UNITS) }] as const;
    const refused = await changeLocalStorage(ctx, storage, A, set, { url: null });
    expect(refused.applied).toEqual([]);
    expect(storage.entries(A)).toEqual([]);
    const from = { source: one.copy, seq: 1, url: one.copy.url };
    const kept = await changeLocalStorage(ctx, storage, A, set, from);
    expect(kept.applied).toEqual(set);
  });

  it("emits DOMStorage events to sessions on a page of the origin", async () => {
    const { ctx, storage, emitted, page } = setup();
    const watcher = page("watcher");
    watcher.target.domStorageSessions.set("s1", null);
    page("elsewhere", "https://b.test/").target.domStorageSessions.set("s2", null);
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

describe("opChunks", () => {
  it("splits a long op list in order, under the message cap", () => {
    const big = "v".repeat(3 * 1024 * 1024);
    const ops = [
      { op: "clear" as const },
      { op: "set" as const, key: "a", value: big },
      { op: "set" as const, key: "b", value: big },
      { op: "remove" as const, key: "c" },
    ];
    const chunks = opChunks(ops);
    expect(chunks.flat()).toEqual(ops);
    expect(chunks.map((c) => c.length)).toEqual([2, 2]);
  });

  it("still makes one chunk for no ops, which acks the source page", () => {
    expect(opChunks([])).toEqual([[]]);
  });
});

describe("StorageCopy.seed", () => {
  // The estimate the engine budgets with: framing per entry, two bytes per code unit.
  const bytes = (entries: Array<[string, string]>) =>
    entries.reduce((n, [k, v]) => n + 32 + 2 * (k.length + v.length), 0);

  it("sends a large area ahead of navigate in chunks, in order, each under its budget", async () => {
    const { storage, page } = setup();
    const ops = Array.from({ length: 300_000 }, (_, i) => ({
      op: "set" as const,
      key: `k${i}`,
      value: "\u00e9",
    }));
    storage.apply(A, ops);
    const { copy, calls } = page("next", `${A}/`, false);
    const inline = await copy.seed();
    const ahead = calls.flatMap((c) => (c.op === "seed" ? [c.entries] : []));
    expect(calls).toHaveLength(ahead.length);
    expect(ahead.length).toBeGreaterThan(1);
    for (const chunk of ahead) expect(bytes(chunk)).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(bytes(inline)).toBeLessThanOrEqual(1024 * 1024);
    expect([...ahead.flat(), ...inline]).toEqual(storage.entries(A));
  });

  it("sends an entry too large to go inline ahead of navigate", async () => {
    const { storage, page } = setup();
    const big = "x".repeat(1024 * 1024);
    storage.apply(A, [{ op: "set", key: "big", value: big }]);
    const { copy, calls } = page("next", `${A}/`, false);
    expect(await copy.seed()).toEqual([]);
    expect(calls).toEqual([{ op: "seed", area: "local", entries: [["big", big]] }]);
  });

  it("sends a small area inline only", async () => {
    const { storage, page } = setup();
    storage.apply(A, [{ op: "set", key: "k", value: "v" }]);
    const { copy, calls } = page("next", `${A}/`, false);
    expect(await copy.seed()).toEqual([["k", "v"]]);
    expect(calls).toEqual([]);
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
