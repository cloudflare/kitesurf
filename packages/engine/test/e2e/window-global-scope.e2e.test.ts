// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("assigning an unforgeable window property no-ops instead of throwing", async ({ page }) => {
  await setContent(
    page,
    `<script>
      window.__r = {};
      try { window.document = 5; __r.sloppy = "no-op"; }
      catch (e) { __r.sloppy = "throw: " + e.message; }
      try { window.window = 5; __r.sloppyWindow = "no-op"; }
      catch (e) { __r.sloppyWindow = "throw: " + e.message; }
      __r.documentIntact = !!(window.document && window.document.getElementById);
      __r.windowIntact = window.window === window;
      (function () {
        "use strict";
        try { window.document = 5; __r.strict = "no throw"; }
        catch (e) { __r.strict = e.constructor.name; }
      })();
    </script>`,
    { waitUntil: "domcontentloaded" },
  );

  expect(await page.evaluate(() => (globalThis as any).__r)).toEqual({
    sloppy: "no-op",
    sloppyWindow: "no-op",
    documentIntact: true,
    windowIntact: true,
    strict: "TypeError",
  });
});

test("an accessor defined on window is readable as a bare global", async ({ page }) => {
  await setContent(
    page,
    `<script>
      window.__r = {};
      var backing = { n: 1 };
      Object.defineProperty(window, "liveHandle", {
        configurable: true,
        get: function () { return backing; },
      });
      __r.viaWindow = window.liveHandle.n;
      try { __r.bare = liveHandle.n; } catch (e) { __r.bare = "throw: " + e.message; }
      // Live, not a snapshot taken at define time.
      backing = { n: 2 };
      try { __r.bareAfterSwap = liveHandle.n; } catch (e) { __r.bareAfterSwap = "throw: " + e.message; }
       // A getter with no setter stays read-only on both sides.
       window.liveHandle = { n: 99 };
       __r.afterAssign = window.liveHandle.n;
       (function () {
         "use strict";
         try { window.liveHandle = { n: 99 }; __r.strictAssign = "no throw"; }
         catch (e) { __r.strictAssign = e.constructor.name; }
       })();
    </script>
    <script>
      // A separate, later-parsed script: issue 3 in the report.
      try { window.__r.bareFromNextScript = liveHandle.n; }
      catch (e) { window.__r.bareFromNextScript = "throw: " + e.message; }
    </script>`,
    { waitUntil: "domcontentloaded" },
  );

  expect(await page.evaluate(() => (globalThis as any).__r)).toEqual({
    viaWindow: 1,
    bare: 1,
    bareAfterSwap: 2,
    afterAssign: 2,
    strictAssign: "TypeError",
    bareFromNextScript: 2,
  });
});

test("install(window) publishes both accessors and values to bare scope", async ({ page }) => {
  await setContent(
    page,
    `<script>
      var lib = {
        document: document,
        window: window,
        Path: function Path() {},
        settings: { applyMatrix: true },
      };
      Object.defineProperty(lib, "view", {
        enumerable: true,
        get: function () { return { pixelRatio: 2 }; },
      });

      function install(scope) {
        ["view"].forEach(function (key) {
          Object.defineProperty(scope, key, {
            configurable: true,
            get: function () { return lib[key]; },
          });
        });
        for (var key in lib) if (lib[key]) scope[key] = lib[key];
      }

      window.__r = {};
      try { install(window); __r.install = "ok"; }
      catch (e) { __r.install = "throw: " + e.message; }
      __r.bareView = typeof view === "object" && view.pixelRatio;
      __r.barePath = typeof Path;
      __r.bareSettings = settings.applyMatrix;
      // The unforgeable names the copy loop walked over are untouched.
      __r.documentIntact = !!document.getElementById;
    </script>`,
    { waitUntil: "domcontentloaded" },
  );

  expect(await page.evaluate(() => (globalThis as any).__r)).toEqual({
    install: "ok",
    bareView: 2,
    barePath: "function",
    bareSettings: true,
    documentIntact: true,
  });
});

test("engine-synthesized events survive a page overwriting window.Event", async ({ page }) => {
  await setContent(
    page,
    `<script>
      window.__r = { fired: [] };
      document.addEventListener("DOMContentLoaded", function () { __r.fired.push("DOMContentLoaded"); });
      window.addEventListener("load", function () { __r.fired.push("load"); });
      function LibEvent(type) { this.type = type; }
      window.Event = LibEvent;
      __r.globalEventIsLibs = Event === LibEvent;
    </script>`,
    { waitUntil: "load" },
  );

  expect(await page.evaluate(() => (globalThis as any).__r)).toEqual({
    fired: ["DOMContentLoaded", "load"],
    globalEventIsLibs: true,
  });
});

test("CDP input and history survive a page overwriting the event globals", async ({ page }) => {
  await setContent(
    page,
    `<input id="t" type="text">
     <script>
       window.__r = { seen: [] };
       ["MouseEvent","PointerEvent","WheelEvent","InputEvent","KeyboardEvent","HashChangeEvent","PopStateEvent"]
         .forEach(function (n) { window[n] = function Hijacked() {}; });
       __r.hijacked = typeof MouseEvent === "function" && MouseEvent.name === "Hijacked";
       ["click","input","popstate","hashchange"].forEach(function (t) {
         (t === "popstate" || t === "hashchange" ? window : document)
           .addEventListener(t, function () { __r.seen.push(t); });
       });
     </script>`,
    { waitUntil: "load" },
  );

  await page.click("#t");
  await page.type("#t", "hi");
  await page.evaluate(() => {
    history.pushState({ a: 1 }, "", location.href + "#one");
    history.back();
  });
  await new Promise((r) => setTimeout(r, 300));

  const { out, value } = await page.evaluate(() => ({
    out: (globalThis as any).__r,
    value: (document.getElementById("t") as HTMLInputElement).value,
  }));
  expect(out.hijacked).toBe(true);
  expect(out.seen).toContain("click");
  expect(out.seen).toContain("input");
  expect(value).toBe("hi");
});

test("a write to a shim-owned window getter still lands", async ({ page }) => {
  await setContent(
    page,
    `<script>
      window.__r = {};
      var real = window.fetch;
      var calls = 0;
      window.fetch = function (input, init) { calls++; return real(input, init); };
      __r.replaced = window.fetch !== real;
      // The name resolves bare too, which is the store page code
      // actually reaches for.
      __r.bareReplaced = fetch !== real;
      fetch("data:text/plain,ok");
      __r.calls = calls;
    </script>`,
    { waitUntil: "domcontentloaded" },
  );

  expect(await page.evaluate(() => (globalThis as any).__r)).toEqual({
    replaced: true,
    bareReplaced: true,
    calls: 1,
  });
});
