// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Top-level let/const/class live in one global lexical scope shared by later
// classic scripts, and are not properties of window.
// https://html.spec.whatwg.org/multipage/webappapis.html#run-a-classic-script
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<script>
  let ready = false;
  const config = { answer: 42 };
  class Widget { constructor() { this.tag = "w"; } }
  function init() { ready = true; }
</script>
<script>
  init();
  globalThis.__lexicalReport = JSON.stringify({
    ready: ready,
    answer: config.answer,
    widget: typeof Widget,
    instance: new Widget().tag,
  });
</script>`;

test("later scripts share top-level lexical bindings", async ({ page, cdpSession }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__lexicalReport")).toEqual({
    ready: true,
    answer: 42,
    widget: "function",
    instance: "w",
  });
}, 60_000);

// Stripping a declaration keyword must not change how the program parses.
const shapes = `<script>
  const { a, b } = { a: 1, b: 2 };
  const c = 1
  const [d] = [2]
  class A {}
  (function () { globalThis.__iife = "ran"; })()
  globalThis.__shapes = JSON.stringify({ sum: a + b, c: c, d: d, iife: globalThis.__iife });
</script>
<script>
  globalThis.__afterShapes = JSON.stringify({ ran: 1 });
</script>`;

test("destructuring, ASI and a class before an IIFE keep their meaning", async ({
  page,
  cdpSession,
}) => {
  await setContent(page, shapes, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__shapes")).toEqual({
    sum: 3,
    c: 1,
    d: 2,
    iife: "ran",
  });
  expect(await readJsonReport(cdpSession, "globalThis.__afterShapes")).toEqual({ ran: 1 });
}, 60_000);

// A destructured binding and a reassigned function both have to reach later scripts.
const sharing = `<script>
  const { a, b } = { a: 1, b: 2 };
  function f() { return "first"; }
  f = function () { return "second"; };
</script>
<script>
  globalThis.__shared = JSON.stringify({ sum: a + b, f: f() });
</script>`;

test("destructured bindings and reassigned functions reach later scripts", async ({
  page,
  cdpSession,
}) => {
  await setContent(page, sharing, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__shared")).toEqual({
    sum: 3,
    f: "second",
  });
}, 60_000);

// A top-level function declaration exists from the start of its script, and its name is
// the binding later scripts share. https://tc39.es/ecma262/#sec-globaldeclarationinstantiation
const hoisting = `<script>
  init();
  var early = typeof onReady;
  function init() { globalThis.__initRan = true; }
  function onReady() {}
  function twice() { return "first"; }
  function twice() { return "last"; }
  function lazy() { lazy = function () { return "cached"; }; return "first"; }
  async function later() { return "async"; }
  function* gen() { yield "gen"; }
  !function iife() {}();
  var expr = function named() {};
</script>
<script>
  lazy();
  later().then(function (value) {
    globalThis.__hoisting = JSON.stringify({
      init: globalThis.__initRan === true,
      early: early,
      twice: twice(),
      lazy: lazy(),
      later: value,
      gen: gen().next().value,
      name: init.name,
      iife: typeof iife,
      named: typeof named,
    });
  });
</script>`;

test("a function can be used before its declaration, and keeps its name and form", async ({
  page,
  cdpSession,
}) => {
  await setContent(page, hoisting, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__hoisting")).toEqual({
    init: true,
    early: "function",
    twice: "last",
    lazy: "cached",
    later: "async",
    gen: "gen",
    name: "init",
    iife: "undefined",
    named: "undefined",
  });
}, 60_000);

// A nested template literal desyncs the declaration scan. The segment must still run:
// the scan used to list the IIFE's function as top-level and the hoist line threw.
const desynced = [
  "<script>",
  "  !function () {",
  "    var c = `${`}`}`;",
  "    function helper() { return 1; }",
  "    globalThis.__helper = helper();",
  "  }();",
  "</script>",
  "<script>",
  "  globalThis.__afterDesync = JSON.stringify({ helper: globalThis.__helper });",
  "</script>",
].join("\n");

test("a script whose scan desyncs on a nested template still runs", async ({
  page,
  cdpSession,
}) => {
  await setContent(page, desynced, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__afterDesync")).toEqual({ helper: 1 });
}, 60_000);

// Callbacks inside a top-level function's call arguments must not unbalance the body scan:
// a premature close hoists nested functions out of scope, and a swallowed close hides later
// top-level declarations from the next script.
const nestedCallbacks = `<script>
  function runWithNested() {
    var out = [];
    function first() {
      [1].forEach(function (v) { out.push(v); });
    }
    function second() {
      out.push(2);
    }
    first();
    second();
    return out;
  }
  const sharedColor = "green";
  function afterCallback() {
    return sharedColor;
  }
</script>
<script>
  globalThis.__nestedCallbacks = JSON.stringify({
    nested: runWithNested(),
    after: afterCallback(),
  });
</script>`;

test("a top-level function with callbacks inside parens keeps nested and later decls intact", async ({
  page,
  cdpSession,
}) => {
  await setContent(page, nestedCallbacks, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__nestedCallbacks")).toEqual({
    nested: [1, 2],
    after: "green",
  });
}, 60_000);
