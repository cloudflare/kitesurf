// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  LOCAL_STORAGE_AREA_LIMIT_UNITS,
  LOCAL_STORAGE_QUOTA_UNITS,
  LocalStorage,
  localStorageOrigin,
  readLocalStorageOps,
} from "../src/state/local-storage.ts";
import { MemorySessionStore } from "../src/state/session-store.ts";

const A = "https://a.test";
const B = "https://b.test";

describe("LocalStorage", () => {
  it("keeps one area per origin", () => {
    const ls = new LocalStorage(new MemorySessionStore());
    ls.apply(A, [{ op: "set", key: "k", value: "a" }]);
    ls.apply(B, [{ op: "set", key: "k", value: "b" }]);
    expect(ls.entries(A)).toEqual([["k", "a"]]);
    expect(ls.entries(B)).toEqual([["k", "b"]]);
    expect(ls.entries("https://c.test")).toEqual([]);
    expect(ls.origins()).toEqual([A, B]);
  });

  it("applies set, remove and clear in order", () => {
    const ls = new LocalStorage(new MemorySessionStore());
    ls.apply(A, [
      { op: "set", key: "a", value: "1" },
      { op: "set", key: "b", value: "2" },
      { op: "set", key: "a", value: "3" },
      { op: "remove", key: "b" },
      { op: "remove", key: "never-set" },
    ]);
    expect(ls.entries(A)).toEqual([["a", "3"]]);
    ls.apply(A, [{ op: "clear" }, { op: "set", key: "c", value: "4" }]);
    expect(ls.entries(A)).toEqual([["c", "4"]]);
    // An origin whose area empties leaves the index.
    ls.apply(A, [{ op: "clear" }]);
    expect(ls.origins()).toEqual([]);
  });

  it("gives each browser context its own areas in the same store", () => {
    const store = new MemorySessionStore();
    const base = new LocalStorage(store);
    const ctx1 = base.forContext("ctx-1");
    const ctx2 = base.forContext("ctx-2");
    base.apply(A, [{ op: "set", key: "k", value: "default" }]);
    ctx1.apply(A, [{ op: "set", key: "k", value: "one" }]);
    expect(base.entries(A)).toEqual([["k", "default"]]);
    expect(ctx1.entries(A)).toEqual([["k", "one"]]);
    expect(ctx2.entries(A)).toEqual([]);
    expect(Object.keys(store.stats().tables).sort()).toEqual([
      "localStorage",
      "localStorage:ctx-1",
      "localStorage:ctx-1|https://a.test",
      "localStorage:ctx-2",
      "localStorage|https://a.test",
    ]);
  });

  it("gives each tab sessionStorage areas of its own, apart from its context's", () => {
    const store = new MemorySessionStore();
    const base = new LocalStorage(store);
    const tab = base.forContext("ctx-1").forTab("T1");
    base.apply(A, [{ op: "set", key: "k", value: "local" }]);
    tab.apply(A, [{ op: "set", key: "k", value: "session" }]);
    expect(base.forTab("T2").entries(A)).toEqual([]);
    expect(tab.entries(A)).toEqual([["k", "session"]]);
    expect(base.entries(A)).toEqual([["k", "local"]]);
    tab.dispose();
    expect(Object.keys(store.stats().tables).some((t) => t.includes("T1"))).toBe(false);
  });

  it("drops a disposed context's areas and ignores its late writes", () => {
    const store = new MemorySessionStore();
    const base = new LocalStorage(store);
    const ctx = base.forContext("ctx-1");
    base.apply(A, [{ op: "set", key: "k", value: "default" }]);
    ctx.apply(A, [{ op: "set", key: "k", value: "one" }]);
    ctx.dispose();
    ctx.apply(A, [{ op: "set", key: "late", value: "1" }]);
    expect(ctx.entries(A)).toEqual([]);
    expect(base.entries(A)).toEqual([["k", "default"]]);
    expect(Object.keys(store.stats().tables).some((t) => t.includes("ctx-1"))).toBe(false);
  });

  it("keeps a set the page accepted past the quota, up to the area limit", () => {
    const ls = new LocalStorage(new MemorySessionStore());
    const half = "x".repeat(LOCAL_STORAGE_QUOTA_UNITS / 2);
    // Two copies of one area, each under the quota alone, together over it.
    ls.apply(A, [{ op: "set", key: "a", value: half }]);
    ls.apply(A, [{ op: "set", key: "b", value: half }]);
    expect(ls.entries(A).map(([k]) => k)).toEqual(["a", "b"]);
    ls.apply(A, [{ op: "set", key: "c", value: half }]);
    expect(ls.entries(A).map(([k]) => k)).toEqual(["a", "b", "c"]);
    // A fourth half passes the area limit and is dropped.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ls.apply(A, [{ op: "set", key: "d", value: half }]);
    expect(ls.entries(A).map(([k]) => k)).toEqual(["a", "b", "c"]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
    // Replacing a value frees the old one first: this set fits only after "c" is freed.
    ls.apply(A, [{ op: "set", key: "c", value: half + "x" }]);
    expect(ls.entries(A).map(([k, v]) => [k, v.length])).toEqual([
      ["a", half.length],
      ["b", half.length],
      ["c", half.length + 1],
    ]);
    expect(LOCAL_STORAGE_AREA_LIMIT_UNITS).toBe(2 * LOCAL_STORAGE_QUOTA_UNITS);
  });
});

describe("localStorageOrigin", () => {
  it.each([
    ["https://a.test/x?q#f", "https://a.test"],
    ["http://a.test:8080/", "http://a.test:8080"],
    ["about:blank", null],
    // The stand-in URL about:blank and a blank setDocumentContent page render under.
    ["https://kitesurf.local/", null],
    ["data:text/html,x", null],
    ["blob:https://a.test/uuid", null],
    ["not a url", null],
  ])("%s -> %s", (url, origin) => {
    expect(localStorageOrigin(url)).toBe(origin);
  });
});

describe("readLocalStorageOps", () => {
  it("keeps well-formed ops in order", () => {
    expect(
      readLocalStorageOps({
        ops: [{ op: "set", key: "a", value: "1" }, { op: "remove", key: "a" }, { op: "clear" }],
      }),
    ).toEqual([{ op: "set", key: "a", value: "1" }, { op: "remove", key: "a" }, { op: "clear" }]);
  });

  it("drops malformed ops", () => {
    expect(
      readLocalStorageOps({
        ops: [
          { op: "set", key: 1, value: "1" },
          { op: "set", key: "a", value: 1 },
          { op: "set", key: "a" },
          { op: "remove", key: null },
          { op: "rename", key: "a", value: "b" },
          null,
          "clear",
          { op: "set", key: "ok", value: "1", extra: true },
        ],
      }),
    ).toEqual([{ op: "set", key: "ok", value: "1" }]);
  });

  it.each([{}, { ops: null }, { ops: "clear" }, { ops: { 0: { op: "clear" } } }])(
    "reads no ops from %j",
    (params) => {
      expect(readLocalStorageOps(params)).toEqual([]);
    },
  );
});
