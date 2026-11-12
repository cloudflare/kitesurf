// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";

import type { WebStorageOp } from "@kitesurf/jsrpc-types/page-script";
import {
  WEB_STORAGE_QUOTA_UNITS,
  WEB_STORAGE_TOTAL_UNITS,
  WebStorage,
  webStorageOrigin,
} from "../src/state/web-storage.ts";
import { MemorySessionStore } from "../src/state/session-store.ts";
import {
  memoryArea,
  QUOTA_UNITS,
  sharedArea,
  Storage,
  storageObject,
} from "../../page-script/src/web-storage.ts";

const ORIGIN = "https://example.com";
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("a page's localStorage batch", () => {
  // Rewriting a near-quota key a few times in one task used to queue a batch over the RPC size
  // cap, and the refused send lost every write in it.
  it("keeps the last write per key, so it stays within the quota", async () => {
    const sent: WebStorageOp[][] = [];
    const area = sharedArea([], (ops) => sent.push(ops));
    const big = (c: string) => c.repeat(2 * 1024 * 1024);
    for (const c of "abcdefgh") area.set("big", big(c));
    area.set("x", "1");
    area.remove("x");
    area.set("y", "2");
    await settle();
    expect(sent).toHaveLength(1);
    expect(
      sent[0]?.map((op) => (op.op === "set" ? [op.op, op.key, op.value.length] : [op.op])),
    ).toEqual([["set", "big", 2 * 1024 * 1024], ["remove"], ["set", "y", 1]]);
    expect(sent[0]?.[0]?.op === "set" && sent[0][0].value[0]).toBe("h");
  });

  it("drops what came before a clear, and still sends the clear", async () => {
    const sent: WebStorageOp[][] = [];
    const area = sharedArea([["old", "v"]], (ops) => sent.push(ops));
    area.set("a", "1");
    area.clear();
    area.set("b", "2");
    await settle();
    expect(sent).toEqual([[{ op: "clear" }, { op: "set", key: "b", value: "2" }]]);
    area.remove("gone");
    await settle();
    expect(sent[1]).toEqual([{ op: "remove", key: "gone" }]);
  });
});

describe("the engine's merged localStorage area", () => {
  it("has the quota the page enforces on its copy", () => {
    expect(WEB_STORAGE_QUOTA_UNITS).toBe(QUOTA_UNITS);
  });

  // Each area is bounded, but a page can fill one per origin it visits: the areas of one
  // connection, localStorage and sessionStorage alike, share a total.
  it("refuses a write that would take a connection's areas over their total", () => {
    const ls = new WebStorage(new MemorySessionStore());
    const tab = ls.forTab("t1");
    const context = ls.forContext("c1");
    const full = "x".repeat(WEB_STORAGE_QUOTA_UNITS - 1);
    const fills = WEB_STORAGE_TOTAL_UNITS / WEB_STORAGE_QUOTA_UNITS;
    const areas = [ls, tab, context];
    for (let i = 0; i < fills; i++) {
      areas[i % areas.length]?.apply(`https://o${i}.example`, [
        { op: "set", key: "k", value: full },
      ]);
    }
    expect(ls.totalUnits()).toBe(fills * WEB_STORAGE_QUOTA_UNITS);

    tab.apply("https://more.example", [{ op: "set", key: "k", value: "v" }]);
    expect(tab.entries("https://more.example")).toEqual([]);
    // A write that shrinks its area is never refused, or a page past the total could not
    // make room; what it frees is there for the next write.
    ls.apply("https://o0.example", [{ op: "set", key: "k", value: "" }]);
    expect(ls.entries("https://o0.example")).toEqual([["k", ""]]);
    tab.apply("https://more.example", [{ op: "set", key: "k", value: "v" }]);
    expect(tab.entries("https://more.example")).toEqual([["k", "v"]]);

    tab.dispose();
    context.clear();
    ls.clear();
    expect(ls.totalUnits()).toBe(0);
  });

  it("gives the stand-in URL of about:blank and setContent documents no shared area", () => {
    expect(webStorageOrigin("https://kitesurf.local/")).toBeNull();
    expect(webStorageOrigin("about:blank")).toBeNull();
    expect(webStorageOrigin("https://example.com/a?b")).toBe("https://example.com");
  });

  it("refuses a write that would take it over the quota, keeping the old value", () => {
    const ls = new WebStorage(new MemorySessionStore());
    const half = "x".repeat(WEB_STORAGE_QUOTA_UNITS / 2);
    ls.apply(ORIGIN, [{ op: "set", key: "a", value: half }]); // two pages, each under quota
    ls.apply(ORIGIN, [{ op: "set", key: "b", value: half }]);
    expect(ls.entries(ORIGIN).map(([k]) => k)).toEqual(["a"]);
  });

  it("counts an overwrite, a remove and a clear against what the area holds", () => {
    const ls = new WebStorage(new MemorySessionStore());
    const big = "x".repeat(WEB_STORAGE_QUOTA_UNITS - 10);
    ls.apply(ORIGIN, [{ op: "set", key: "a", value: big }]);
    ls.apply(ORIGIN, [{ op: "set", key: "a", value: big.slice(1) }]); // the old value is freed
    ls.apply(ORIGIN, [
      { op: "remove", key: "a" },
      { op: "set", key: "b", value: big },
    ]);
    expect(ls.entries(ORIGIN).map(([k]) => k)).toEqual(["b"]);
    ls.apply(ORIGIN, [{ op: "clear" }, { op: "set", key: "c", value: big }]);
    expect(ls.entries(ORIGIN).map(([k]) => k)).toEqual(["c"]);
  });
});

interface StorageShape {
  [name: string]: unknown;
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
}

const storage = (): StorageShape => storageObject(memoryArea()) as StorageShape;

describe("a Storage object", () => {
  it("lists its stored keys, and only them, as its own enumerable properties", () => {
    const s = storage();
    s.setItem("foo", "1");
    s.setItem("bar", "2");
    expect(Object.keys(s)).toEqual(["foo", "bar"]);
    expect(Object.getOwnPropertyNames(s)).toEqual(["foo", "bar"]);
    expect({ ...s }).toEqual({ foo: "1", bar: "2" });
    expect(JSON.stringify(s)).toBe('{"foo":"1","bar":"2"}');
    expect(Object.getOwnPropertyDescriptor(s, "foo")).toEqual({
      value: "1",
      writable: true,
      enumerable: true,
      configurable: true,
    });
  });

  it("maps a named get, set, `in` and delete to the area", () => {
    const s = storage();
    expect(s.missing).toBe(undefined);
    s.name = 5;
    s[9] = { toString: () => "nine" };
    expect(s.getItem("name")).toBe("5");
    expect(s.getItem("9")).toBe("nine");
    expect(s.name).toBe("5");
    expect("name" in s).toBe(true);
    expect(delete s.name).toBe(true);
    expect(s.getItem("name")).toBe(null);
    expect("name" in s).toBe(false);
    expect(Object.defineProperty(s, "d", { value: "v" })).toBe(s);
    expect(s.getItem("d")).toBe("v");
    expect(() => Object.defineProperty(s, "g", { get: () => "x" })).toThrow(TypeError);
  });

  it("stores names the prototype has without hiding the built-ins", () => {
    const s = storage();
    s.setItem("length", "be");
    Reflect.set(s, "key", "too");
    s.setItem("clear", "almost");
    expect(s.length).toBe(3);
    expect(typeof s.key).toBe("function");
    expect(s.getItem("key")).toBe("too");
    expect(Object.keys(s)).toEqual([]); // every one is shadowed by Storage.prototype
    expect(Reflect.deleteProperty(s, "length")).toBe(true);
    expect(s.getItem("length")).toBe("be");
    s.clear();
    expect(s.length).toBe(0);
  });

  it("keeps symbols as ordinary properties of the object", () => {
    const s = storage() as StorageShape & Record<symbol, unknown>;
    const sym = Symbol("s");
    s[sym] = "x";
    expect(s[sym]).toBe("x");
    expect(s.length).toBe(0);
    expect(Reflect.ownKeys(s)).toEqual([sym]);
    expect(delete s[sym]).toBe(true);
    expect(s[sym]).toBe(undefined);
  });

  it("is a Storage, brand-checked and not constructible", () => {
    const s = storage();
    expect(s instanceof Storage).toBe(true);
    expect(Object.getPrototypeOf(s)).toBe(Storage.prototype);
    expect(Object.prototype.toString.call(s)).toBe("[object Storage]");
    const getItem: unknown = Reflect.get(Storage.prototype, "getItem");
    expect(s.getItem).toBe(getItem);
    expect(() => new Storage()).toThrow(TypeError);
    expect(() => Reflect.apply(s.getItem, {}, ["k"])).toThrow(TypeError);
    expect(() => Reflect.apply(s.getItem, s, [])).toThrow(TypeError);
    expect(() => Object.preventExtensions(s)).toThrow(TypeError);
    s.setItem("a", "1");
    expect(s.key(2 ** 32)).toBe("a"); // unsigned long wraps modulo 2^32
    expect(s.key(-1)).toBe(null);
  });
});
