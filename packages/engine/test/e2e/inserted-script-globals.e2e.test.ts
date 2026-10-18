// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("an inserted script shares globals with the page as a browser does", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html><title>t</title><script>
    window.ns = { widgets: {} };
    var s = document.createElement("script");
    s.textContent = "var ns = ns || {}; ns.widgets.flow = 1; var counter = 1; function helper() { return 7; } function bump() { counter += 1; }";
    document.head.appendChild(s);
    setTimeout(function () {
      bump();
      document.title = JSON.stringify({ flow: window.ns.widgets.flow, helper: typeof window.helper === "function" ? window.helper() : null, counter: window.counter });
    }, 100);
  </script>`,
  );
  await page.waitForFunction(() => document.title.startsWith("{"), { timeout: 20_000 });
  expect(JSON.parse(await page.title())).toEqual({ flow: 1, helper: 7, counter: 2 });
}, 60_000);

test("an inserted top-level var replaces a readonly window attribute", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html><title>t</title><script>
    var s = document.createElement("script");
    s.textContent = 'var origin = "x"; var outerWidth = 7; window.__readBack = [origin, outerWidth];';
    document.head.appendChild(s);
    setTimeout(function () {
      document.title = JSON.stringify({ origin: window.origin, outerWidth: window.outerWidth, readBack: window.__readBack });
    }, 100);
  </script>`,
  );
  await page.waitForFunction(() => document.title.startsWith("{"), { timeout: 20_000 });
  expect(JSON.parse(await page.title())).toEqual({
    origin: "x",
    outerWidth: 7,
    readBack: ["x", 7],
  });
}, 60_000);

const STRICT_BODY =
  '"use strict"; var tag = 1; (window.__strict = window.__strict || []).push([(function () { return this; })() === undefined, (function () { try { undeclaredStrict = 1; return false; } catch (e) { return e instanceof ReferenceError; } })()]);';

test("a strict inserted script stays strict, inline and external", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html><title>t</title><script>
    var inline = document.createElement("script");
    inline.textContent = ${JSON.stringify(STRICT_BODY)};
    document.head.appendChild(inline);
    var exp = document.createElement("script");
    exp.textContent = '"use strict"; var exports = { ok: 1 }; window.__exportsSeen = exports.ok;';
    document.head.appendChild(exp);
    var ext = document.createElement("script");
    ext.src = "data:text/javascript," + encodeURIComponent(${JSON.stringify(STRICT_BODY)});
    ext.onload = ext.onerror = function (e) {
      document.title = JSON.stringify({ event: e.type, strict: window.__strict, leaked: "undeclaredStrict" in window, exportsSeen: window.__exportsSeen });
    };
    document.head.appendChild(ext);
  </script>`,
  );
  await page.waitForFunction(() => document.title.startsWith("{"), { timeout: 20_000 });
  expect(JSON.parse(await page.title())).toEqual({
    event: "load",
    strict: [
      [true, true],
      [true, true],
    ],
    leaked: false,
    exportsSeen: 1,
  });
}, 60_000);

test("an inserted script's syntax error reports its own line", async ({ page }) => {
  const warnings: string[] = [];
  page.on("console", (m) => {
    if (m.text().includes("inserted-script eval failed")) warnings.push(m.text());
  });
  await setContent(
    page,
    `<!doctype html><title>t</title><script>
    var s = document.createElement("script");
    s.textContent = "var a = 1;\\n\\n)";
    document.head.appendChild(s);
    document.title = "done";
  </script>`,
  );
  await page.waitForFunction(() => document.title === "done", { timeout: 20_000 });
  expect(warnings).toEqual([expect.stringContaining("line 3")]);
}, 60_000);
