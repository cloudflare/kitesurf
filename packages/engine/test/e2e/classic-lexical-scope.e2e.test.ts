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
