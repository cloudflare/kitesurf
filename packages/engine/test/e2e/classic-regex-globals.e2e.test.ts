// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("declarations after a regex literal with quotes become globals", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html><title>t</title>
    <script>
      var xss = /[<>'"]/, half = 4 / 2;
      var experiments = {}, WIDTH, B = window.lib = { ready: true };
      function later() { return /}/.test("}"); }
    </script>
    <script>
      document.title = JSON.stringify([window.B === B, !!(window.B && window.B.ready), typeof window.later, "WIDTH" in window, half]);
    </script>`,
  );
  expect(JSON.parse(await page.title())).toEqual([true, true, "function", true, 2]);
}, 60_000);

test("a division after an identifier spelled like a keyword is not a regex", async ({ page }) => {
  const inserted =
    "var o2 = { in: 4 }; var a2 = o2.in/2; function f2() { return 1 } var b2 = a2/3; window.ran2 = 1;";
  await setContent(
    page,
    `<!doctype html><title>t</title>
    <script>!function(){var of=g(4),x=of/2;function s(e){var t=e+1;return t/2}var k=5;function g(n){return n}}();</script>
    <script>var of=4;var a=of/2;function f(){return 1}var b=a/3;var c=1;</script>
    <script>
      var s = document.createElement("script");
      s.textContent = ${JSON.stringify(inserted)};
      document.head.appendChild(s);
      (function done() {
        if (!window.ran2) return setTimeout(done, 10);
        document.title = JSON.stringify([typeof window.k, typeof window.f, typeof window.b, typeof window.f2, typeof window.b2]);
      })();
    </script>`,
  );
  await page.waitForFunction(() => document.title.startsWith("["), { timeout: 20_000 });
  expect(JSON.parse(await page.title())).toEqual([
    "undefined",
    "function",
    "number",
    "function",
    "number",
  ]);
}, 60_000);

test("a division after a string is not a regex that hides later declarations", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html><title>t</title>
    <script>var ratio = "50" / 2, R2 = 1; function afterDivision() { return ratio; }</script>
    <script>var q = "8" / 2; function scoped(n) { var h = n / 2; var local = h; return local; }</script>
    <script>
      document.title = JSON.stringify([typeof window.afterDivision, window.R2, scoped(4), "local" in window]);
    </script>`,
  );
  expect(JSON.parse(await page.title())).toEqual(["function", 1, 2, false]);
}, 60_000);
