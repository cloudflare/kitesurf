// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Page } from "@cloudflare/puppeteer";

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const BOA = [
  "window.ns = {",
  "  Klass: class Foo { constructor(v) { this.v = v; } get dbl() { return this.v * 2; } },",
  "  Widget: function Widget(v) { this.v = v; },",
  "  count: 0, inc: function () { this.count++; return this.count; },",
  "  data: { a: 1 },",
  "  h2: { a: 1 }, m4: { x: 1 }, list: [1, 2],",
  "  frozen: Object.freeze({ a: 1 }), closed: Object.preventExtensions({ a: 1 }),",
  "  fixed: Object.defineProperty({}, 'k', { value: 1, enumerable: true }),",
  "  v8frozen: { a: 1, n: { b: 2 } }, gone: Object.preventExtensions({ a: 1, b: 2 }),",
  "};",
  "ns.Widget.prototype.get = function () { return this.v; };",
  "ns.bound = ns.Widget.bind(null);",
  "ns.drop = function (o, k) { return delete o[k]; };",
].join("\n");

async function onBoaObjects(page: Page, v8: string): Promise<unknown> {
  await setContent(
    page,
    `<!doctype html><title>t</title><script>
    var s = document.createElement("script");
    s.textContent = ${JSON.stringify(BOA)};
    document.head.appendChild(s);
    function step(f) { try { return f(); } catch (e) { return "threw " + e.name; } }
    (function run() {
      if (!window.ns) return setTimeout(run, 10);
      document.title = JSON.stringify((function () { ${v8} })());
    })();
  </script>`,
  );
  await page.waitForFunction(() => document.title.startsWith("{"), { timeout: 20_000 });
  return JSON.parse(await page.title());
}

test("page code constructs boa classes and defines properties on boa objects", async ({ page }) => {
  expect(
    await onBoaObjects(
      page,
      `
    var k = new ns.Klass(21), w = new ns.Widget(4), got;
    Object.defineProperty(ns.data, "hidden", { value: 9 });
    Object.defineProperty(ns.data, "acc", { get: function () { return "g"; }, set: function (v) { got = v; }, configurable: true });
    ns.data.acc = "x";
    Object.defineProperty(ns.Klass.prototype, "tripled", { get: function () { return this.v * 3; }, configurable: true });
    return {
      klass: [k.dbl, k instanceof ns.Klass, k.tripled],
      widget: [w.get(), w instanceof ns.Widget],
      method: [ns.inc(), ns.inc(), ns.count],
      define: [ns.data.hidden, Object.keys(ns.data).join(","), ns.data.acc, got],
    };
  `,
    ),
  ).toEqual({
    klass: [42, true, 63],
    widget: [4, true],
    method: [1, 2, 2],
    define: [9, "a", "g", "x"],
  });
}, 60_000);

test("a define on a boa object reports boa's resulting property", async ({ page }) => {
  expect(
    await onBoaObjects(
      page,
      `
    var o = ns.h2;
    return {
      defineA: step(function () { Object.defineProperty(o, "a", { configurable: false }); return "ok"; }),
      readA: step(function () { return o.a; }),
      writeA: step(function () { o.a = 2; return o.a; }),
      descA: step(function () { return Object.getOwnPropertyDescriptor(o, "a"); }),
      defineB: step(function () { Object.defineProperty(o, "b", { value: 9 }); return o.b; }),
      descB: step(function () { return Object.getOwnPropertyDescriptor(o, "b"); }),
      redefineB: step(function () { return [Reflect.defineProperty(o, "b", { value: 10 }), Reflect.defineProperty(o, "b", { value: 9 }), o.b]; }),
      tag: step(function () { Object.defineProperty(o, Symbol.toStringTag, { value: "Mod" }); return [Object.prototype.toString.call(o), Object.keys(o).join(",")]; }),
    };
  `,
    ),
  ).toEqual({
    defineA: "ok",
    readA: 1,
    writeA: 2,
    descA: { value: 2, writable: true, enumerable: true, configurable: false },
    defineB: 9,
    descB: { value: 9, writable: false, enumerable: false, configurable: false },
    redefineB: [false, true, 9],
    tag: ["[object Mod]", "a"],
  });
}, 60_000);

test("babel's writable:false define over a boa function's prototype succeeds", async ({ page }) => {
  expect(
    await onBoaObjects(
      page,
      `
    var W = ns.Widget, arr = ns.list;
    return {
      proto: step(function () {
        Object.defineProperty(W, "prototype", { writable: false });
        var d = Object.getOwnPropertyDescriptor(W, "prototype");
        return [d.writable, d.configurable, new W(3).get(), new W(3) instanceof W];
      }),
      length: step(function () {
        Object.defineProperty(arr, "length", { writable: false });
        var d = Object.getOwnPropertyDescriptor(arr, "length");
        return [d.value, d.writable, arr.length, Reflect.set(arr, "length", 0), arr.length];
      }),
    };
  `,
    ),
  ).toEqual({
    proto: [false, false, 3, true],
    length: [2, false, 2, false, 2],
  });
}, 60_000);

test("page code checking before it defines on a closed boa object never throws", async ({
  page,
}) => {
  expect(
    await onBoaObjects(
      page,
      `
    function observe(o) {
      if (Object.isExtensible(o)) Object.defineProperty(o, "__ob__", { value: 1, configurable: true, writable: true });
      return "ok ext=" + Object.isExtensible(o);
    }
    function redefine(o) {
      var d = Object.getOwnPropertyDescriptor(o, "k");
      if (d.configurable) Object.defineProperty(o, "k", { get: function () { return 2; } });
      return "ok configurable=" + d.configurable;
    }
    return {
      frozen: step(function () { return observe(ns.frozen); }),
      closed: step(function () { return observe(ns.closed); }),
      fixed: step(function () { return redefine(ns.fixed); }),
      frozenState: step(function () { var o = ns.frozen; return [Object.isFrozen(o), Object.keys(o).join(","), o.a, Object.getOwnPropertyDescriptor(o, "a")]; }),
      closedState: step(function () { var o = ns.closed; return [Object.isSealed(o), Object.keys(o).join(","), Reflect.set(o, "a", 5), o.a, Reflect.set(o, "z", 1), "z" in o]; }),
    };
  `,
    ),
  ).toEqual({
    frozen: "ok ext=false",
    closed: "ok ext=false",
    fixed: "ok configurable=false",
    frozenState: [
      true,
      "a",
      1,
      { value: 1, writable: false, enumerable: true, configurable: false },
    ],
    closedState: [false, "a", true, 5, false, false],
  });
}, 60_000);

test("page code freezing a boa object freezes it in boa", async ({ page }) => {
  expect(
    await onBoaObjects(
      page,
      `
    var o = ns.v8frozen, g = ns.gone;
    return {
      freeze: step(function () { Object.freeze(o); return [Object.isFrozen(o), Object.keys(o).join(","), o.a, Reflect.set(o, "a", 9), o.a, Reflect.set(o, "z", 1)]; }),
      nested: step(function () { return [Object.isFrozen(o.n), Reflect.set(o.n, "b", 3), o.n.b]; }),
      desc: step(function () { return Object.getOwnPropertyDescriptor(o, "a"); }),
      removed: step(function () { return [Object.isExtensible(g), ns.drop(g, "a"), "a" in g, Object.keys(g).join(","), Object.getOwnPropertyDescriptor(g, "a")]; }),
      deleted: step(function () { return [delete g.b, Object.keys(g).join(","), "b" in g]; }),
    };
  `,
    ),
  ).toEqual({
    freeze: [true, "a,n", 1, false, 1, false],
    nested: [false, true, 3],
    desc: { value: 1, writable: false, enumerable: true, configurable: false },
    removed: [false, true, false, "b", null],
    deleted: [true, "", false],
  });
  expect(
    await page.evaluate(() => {
      const o = (window as typeof window & { ns: { v8frozen: object } }).ns.v8frozen;
      return [
        Object.isExtensible(o),
        Reflect.set(o, "a", 2),
        Object.getOwnPropertyDescriptor(o, "a"),
      ];
    }),
  ).toEqual([false, false, { value: 1, writable: false, enumerable: true, configurable: false }]);
}, 60_000);

test("a define V8 rejects on a boa object's shell leaves boa unchanged", async ({ page }) => {
  expect(
    await onBoaObjects(
      page,
      `
    var o = ns.m4, before = String(ns.bound.prototype);
    Object.preventExtensions(o);
    return {
      define: step(function () { Object.defineProperty(o, "nk", { value: 5, writable: true, enumerable: true, configurable: true }); return "defined"; }),
      leaked: step(function () { return [o.nk === undefined, "nk" in o]; }),
      reflect: step(function () { return [Reflect.defineProperty(o, "nk2", { value: 1, configurable: true }), "nk2" in o]; }),
      fixed: step(function () { return Reflect.defineProperty(ns.bound, "prototype", { value: 1, enumerable: true, configurable: true }); }),
      fixedLeaked: step(function () { return [before, String(ns.bound.prototype)]; }),
    };
  `,
    ),
  ).toEqual({
    define: "threw TypeError",
    leaked: [true, false],
    reflect: [false, false],
    fixed: false,
    fixedLeaked: ["undefined", "undefined"],
  });
}, 60_000);
