// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// The two host seams, exercised without a worker: the store a session keeps its data in, and
// the entry module the engine synthesizes so a host class is reachable from the page isolate.

import assert from "node:assert/strict";
import { test } from "node:test";

import { pageIsolateEntry } from "../../src/eval/page-isolate-entry.ts";
import { MemorySessionStore, isStoredString } from "../../src/state/session-store.ts";

test("a table behaves like a Map, and stats see what it holds", () => {
  const store = new MemorySessionStore();
  const t = store.table("cookies", isStoredString);
  t.set("a", "1").set("b", "22");
  assert.equal(t.get("a"), "1");
  assert.equal(t.size, 2);
  // Insertion order, like a Map: re-setting a key must not move it.
  t.set("a", "9");
  assert.deepEqual([...t.keys()], ["a", "b"]);
  const stats = store.stats();
  assert.equal(stats.keys, 2);
  assert.ok(stats.valueBytes > 0);
  assert.ok(stats.tables.cookies);
});

test("a value of the wrong shape reads as missing instead of reaching the caller", () => {
  const store = new MemorySessionStore();
  // Two callers disagreeing on a table's type is the case this guards: the row is there, but
  // it is not a string, so a reader asking for strings must not receive it.
  (
    store.table("mixed", (_v): _v is unknown => true) as { set(k: string, v: unknown): unknown }
  ).set("n", 42);
  const strings = store.table("mixed", isStoredString);
  assert.equal(strings.get("n"), undefined);
  // `has` answers presence, not type: it returns nothing a caller could mistake for a V, so a
  // reader that branches on `has` and then uses `get` must still handle undefined.
  assert.equal(strings.has("n"), true);
});

test("drop and clear remove a table and everything in it", () => {
  const store = new MemorySessionStore();
  store.table("a", isStoredString).set("k", "v");
  store.table("b", isStoredString).set("k", "v");
  store.drop("a");
  assert.equal(store.stats().tables.a, undefined);
  store.clear();
  assert.equal(store.stats().keys, 0);
});

test("without a host class the isolate keeps its own entry module", () => {
  const modules: Record<string, unknown> = { "page.js": "export default {}" };
  assert.equal(pageIsolateEntry(modules, undefined), "page.js");
  assert.equal(pageIsolateEntry(modules, { modules: { "h.js": "" } }), "page.js");
  assert.deepEqual(Object.keys(modules), ["page.js", "h.js"]);
});

test("a host class gets an entry that re-exports it and the engine's own runtime", () => {
  const modules: Record<string, unknown> = { "page.js": "export default {}" };
  const entry = pageIsolateEntry(modules, {
    modules: { "__ks_host.js": "export class Facet {}" },
    hostClassName: "Facet",
  });
  assert.notEqual(entry, "page.js");
  const source = String(modules[entry]);
  // The class lookup reads the entry module alone, so all three exports have to be here.
  assert.match(source, /export \* from "page\.js"/);
  assert.match(source, /export \{ default \} from "page\.js"/);
  assert.match(source, /export \{ Facet \} from "__ks_host\.js"/);
});

test("a host cannot replace the engine's own modules, or inject through the class name", () => {
  const modules: Record<string, unknown> = { "page.js": "ENGINE", "wasm-glue.js": "ENGINE" };
  pageIsolateEntry(modules, {
    modules: { "page.js": "HOST", "wasm-glue.js": "HOST", "h.js": "export class A {}" },
    hostClassName: "A",
  });
  assert.equal(modules["page.js"], "ENGINE");
  assert.equal(modules["wasm-glue.js"], "ENGINE");

  const sneaky: Record<string, unknown> = { "page.js": "ENGINE" };
  const entry = pageIsolateEntry(sneaky, {
    modules: { "h.js": "" },
    hostClassName: 'A }; import("evil");export {',
  });
  assert.equal(entry, "page.js");
});
