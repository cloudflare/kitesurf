// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Both store backends behave like a Map: the same values back, insertion order kept across an
// update, deletes visible and tables apart. The SQLite backend runs on node:sqlite through the
// surface of Durable Object storage, so what passes here is the SQL a Durable Object runs.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { NetworkEventTracker } from "../../src/cdp/network-events.ts";
import type { CdpEvent } from "../../src/cdp/types.ts";
import {
  MemorySessionStore,
  isStoredString,
  type SessionStore,
} from "../../src/state/session-store.ts";
import {
  SQLITE_STORE_LIMITS,
  SqliteSessionStore,
  type SqliteStorage,
} from "../../src/state/sqlite-session-store.ts";
import { nodeSqlite } from "./node-sqlite.ts";

// A Durable Object's storage is what a host passes: this fails to typecheck if it does not fit.
type Fits<T extends SqliteStorage> = T;
export type DurableObjectStorageFits = Fits<DurableObjectStorage>;

const anyValue = (_v: unknown): _v is unknown => true;
const isNumber = (v: unknown): v is number => typeof v === "number";

const backends: Array<[string, () => SessionStore]> = [
  ["memory", () => new MemorySessionStore()],
  ["sqlite", () => new SqliteSessionStore(nodeSqlite())],
];

for (const [name, make] of backends) {
  describe(`the ${name} store`, () => {
    test("round-trips strings, bytes and JSON", () => {
      const t = make().table("t", anyValue);
      t.set("s", "héllo 🪁");
      t.set("b", new Uint8Array([0, 1, 255]));
      t.set("j", { a: [1, "x", null], b: { c: true } });
      assert.equal(t.get("s"), "héllo 🪁");
      assert.deepEqual(t.get("b"), new Uint8Array([0, 1, 255]));
      assert.deepEqual(t.get("j"), { a: [1, "x", null], b: { c: true } });
      assert.equal(t.get("missing"), undefined);
    });

    // SQLite writes a lone surrogate as U+FFFD, and page JS can store one in Web Storage.
    test("round-trips lone surrogates in keys and values", () => {
      const t = make().table("t", isStoredString);
      const hi = String.fromCharCode(0xd800);
      const lo = String.fromCharCode(0xdc00);
      const escapeLike = String.fromCharCode(0xffff) + '"x"';
      t.set(hi, "a" + lo + "b")
        .set(lo, hi)
        .set(escapeLike, "plain")
        .set("🪁", "🪁");
      assert.equal(t.get(hi), "a" + lo + "b");
      assert.equal(t.get(lo), hi);
      assert.equal(t.get(escapeLike), "plain");
      assert.deepEqual([...t.keys()], [hi, lo, escapeLike, "🪁"]);
      assert.deepEqual([...t.values()], ["a" + lo + "b", hi, "plain", "🪁"]);
      assert.equal(t.delete(hi), true);
      assert.equal(t.has(lo), true);
    });

    test("keeps insertion order across an update", () => {
      const t = make().table("t", isNumber);
      t.set("a", 1).set("b", 2).set("c", 3);
      t.set("a", 10);
      assert.deepEqual([...t.keys()], ["a", "b", "c"]);
      assert.deepEqual([...t.values()], [10, 2, 3]);
      assert.deepEqual(
        [...t.entries()],
        [
          ["a", 10],
          ["b", 2],
          ["c", 3],
        ],
      );
      assert.equal(t.size, 3);
    });

    test("deletes, and lets a caller delete while it iterates", () => {
      const t = make().table("t", isNumber);
      t.set("a", 1).set("b", 2).set("c", 3);
      assert.equal(t.delete("a"), true);
      assert.equal(t.delete("a"), false);
      assert.equal(t.has("a"), false);
      for (const k of t.keys()) if (k !== "b") t.delete(k);
      assert.deepEqual([...t.keys()], ["b"]);
      t.clear();
      assert.equal(t.size, 0);
    });

    test("keeps tables apart, and drop and clear remove them", () => {
      const store = make();
      store.table("x", isNumber).set("k", 1);
      store.table("y", isNumber).set("k", 2);
      assert.equal(store.table("x", isNumber).get("k"), 1);
      store.drop("x");
      assert.equal(store.table("x", isNumber).size, 0);
      assert.equal(store.table("y", isNumber).get("k"), 2);
      store.clear();
      assert.equal(store.table("y", isNumber).size, 0);
    });

    test("counts keys and value bytes per table, alike on both backends", () => {
      const store = make();
      store.table("a", anyValue).set("s", "héllo").set("b", new Uint8Array(10));
      store.table("b", anyValue).set("j", { x: 1 });
      store.table("a", anyValue).set("s", "hé");
      const st = store.stats();
      assert.deepEqual(st.tables.a, { keys: 2, bytes: 3 + 10 });
      assert.deepEqual(st.tables.b, { keys: 1, bytes: JSON.stringify({ x: 1 }).length });
      assert.equal(st.keys, 3);
      assert.equal(st.valueBytes, 13 + 7);
      assert.ok(st.bytes >= st.valueBytes);
    });

    test("round-trips values that span several rows", () => {
      const t = make().table("t", anyValue);
      // A naive split would cut a surrogate pair at every chunk boundary.
      const big = "a" + "🪁".repeat(1_100_000);
      const bytes = new Uint8Array(13 * 1024 * 1024 + 7).map((_, i) => i % 251);
      t.set("s", big);
      t.set("b", bytes);
      t.set("j", { big });
      assert.equal(t.get("s"), big);
      assert.deepEqual(t.get("b"), bytes);
      assert.deepEqual(t.get("j"), { big });
      // A smaller value drops the extra chunks of the old one.
      t.set("s", "small");
      assert.equal(t.get("s"), "small");
      assert.deepEqual([...t.values()].slice(0, 1), ["small"]);
    });

    test("reads a row that fails the table's guard as missing", () => {
      const store = make();
      store.table("t", anyValue).set("n", 42).set("s", "str");
      const strings = store.table("t", isStoredString);
      assert.equal(strings.get("s"), "str");
      assert.equal(strings.get("n"), undefined);
      assert.deepEqual(Array.from(strings.entries()), [["s", "str"]]);
    });
  });
}

describe("the SQLite store", () => {
  test("declares limits off the heap, which a host can change", () => {
    assert.deepEqual(new SqliteSessionStore(nodeSqlite()).limits, SQLITE_STORE_LIMITS);
    const store = new SqliteSessionStore(nodeSqlite(), { networkRequests: 10 });
    assert.equal(store.limits.networkRequests, 10);
    assert.equal(store.limits.onHeap, false);
  });

  // A value of several chunks is several statements. A failure midway must keep the old value.
  test("keeps the old value when a write fails midway", () => {
    const base = nodeSqlite();
    let failChunks = false;
    const storage: SqliteStorage = {
      sql: {
        exec(query, ...bindings) {
          if (failChunks && query.includes("VALUES (?, ?, ?, ?, ?)")) throw new Error("FULL");
          return base.sql.exec(query, ...bindings);
        },
        get databaseSize() {
          return base.sql.databaseSize;
        },
      },
      transactionSync: (fn) => base.transactionSync(fn),
    };
    const t = new SqliteSessionStore(storage).table("t", isStoredString);
    // Each value takes two chunks, so the second chunk's insert is the one that fails.
    const old = "a".repeat(2_500_000);
    t.set("k", old);
    failChunks = true;
    assert.throws(() => t.set("k", "b".repeat(2_500_000)), /FULL/);
    failChunks = false;
    assert.equal(t.get("k"), old);
  });

  test("refuses every write once fenced, and still reads", () => {
    const store = new SqliteSessionStore(nodeSqlite());
    const t = store.table("t", anyValue);
    t.set("a", "1");
    store.fence();
    assert.equal(store.fenced, true);
    assert.throws(() => t.set("b", "2"), /takes no writes/);
    assert.throws(() => t.delete("a"), /takes no writes/);
    assert.throws(() => t.clear(), /takes no writes/);
    assert.throws(() => store.table("u", anyValue).set("c", "3"), /takes no writes/);
    assert.throws(() => store.drop("t"), /takes no writes/);
    assert.throws(() => store.clear(), /takes no writes/);
    assert.equal(t.get("a"), "1");
    assert.equal(t.has("b"), false);
  });

  test("reads a row that does not decode as missing", () => {
    const storage = nodeSqlite();
    const t = new SqliteSessionStore(storage).table("t", anyValue);
    t.set("bad", { a: 1 }).set("good", { b: 2 });
    storage.raw(`UPDATE ks_session_store SET v = '{' WHERE k = 'bad'`);
    assert.equal(t.get("bad"), undefined);
    assert.deepEqual(Array.from(t.entries()), [["good", { b: 2 }]]);
  });

  test("holds a session's network log, and its root-session events keep no session id", () => {
    const store = new SqliteSessionStore(nodeSqlite(), { networkRequests: 2 });
    const events: CdpEvent[] = [];
    const tracker = new NetworkEventTracker((ev) => events.push(ev), "conn-sqlite", store);
    tracker.setEnabled(undefined, true);
    tracker.setEnabled("s1", true);
    const ids = ["one", "two", "three"].map((body) => {
      const url = `https://example.test/${body}`;
      const id = tracker.beginRequest({
        url,
        method: "GET",
        headers: {},
        type: "XHR",
        initiator: { type: "other" },
        loaderId: "loader-1",
        frameId: "frame-1",
        sessionIds: [undefined, "s1"],
      });
      tracker.completeRequest(id, {
        url,
        status: 200,
        statusText: "OK",
        headers: {},
        mimeType: "application/json",
        bodyLength: body.length,
        body,
      });
      return id;
    });
    tracker.drain();

    assert.equal(store.stats().tables["network.requests"]?.keys, 2);
    assert.equal(tracker.getResponseBody(ids[0] ?? ""), null);
    assert.deepEqual(tracker.getResponseBody(ids[2] ?? ""), {
      body: "three",
      base64Encoded: false,
    });
    const sessions = events
      .filter((e) => e.method === "Network.responseReceived")
      .map((e) => e.sessionId);
    assert.deepEqual(sessions, [undefined, "s1", undefined, "s1", undefined, "s1"]);
    tracker.dispose();
  });
});
