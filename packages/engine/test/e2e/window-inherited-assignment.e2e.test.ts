// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Fetch ponyfills build a private scope as `F.prototype = self; new F()` and install on it; an
// assignment through that object must shadow the window's members, as OrdinarySet does in Chrome.

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("an object inheriting from window keeps its assignments to itself", async ({ page }) => {
  await setContent(
    page,
    `<div id="namedEl"></div>
    <script>
      var r = (window.__r = {});
      var has = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
      var bare = function () { return [fetch, Headers, Request, Response]; };
      var viaWindow = function () {
        return [window.fetch, window.Headers, window.Request, window.Response];
      };
      var same = function (a, b) { return a.every(function (v, i) { return v === b[i]; }); };
      var bareBefore = bare(), windowBefore = viaWindow();
      function F() { this.fetch = false; this.DOMException = self.DOMException; }
      F.prototype = self;
      var scope = new F();
      r.own = Object.getOwnPropertyNames(scope);
      if (!scope.fetch) {
        scope.fetch = function polyfillFetch() {};
        scope.Headers = function PolyHeaders() {};
        scope.Request = function PolyRequest() {};
        scope.Response = function PolyResponse() {};
      }
      r.ownAfter = Object.getOwnPropertyNames(scope);
      r.globalsKept = [same(bare(), bareBefore), same(viaWindow(), windowBefore)];
      var created = Object.create(window);
      created.x = 1;
      r.created = [("x" in window), has(created, "x")];
      var userGlobal = "page";
      function G() { this.userGlobal = "heir"; }
      G.prototype = window;
      var heir = new G();
      r.userGlobal = [userGlobal, heir.userGlobal, has(heir, "userGlobal")];
      try { Object.create(window).onload = function () {}; r.onload = "no throw"; }
      catch (e) { r.onload = e.constructor.name; }
      r.onloadAfter = window.onload;
      var doc = Object.create(window);
      doc.document = 1;
      r.documentSloppy = has(doc, "document");
      (function () {
        "use strict";
        try { Object.create(window).document = 1; r.documentStrict = "no throw"; }
        catch (e) { r.documentStrict = e.constructor.name; }
      })();
      var nan = Object.create(window);
      nan.NaN = 1;
      r.nan = has(nan, "NaN");
      var named = Object.create(window);
      named.namedEl = 1;
      r.named = [has(named, "namedEl"), window.namedEl instanceof Element];
      var ops = Object.create(window);
      ops.addEventListener = 1;
      ops.setTimeout = 1;
      r.ops = [Object.getOwnPropertyNames(ops), typeof addEventListener, typeof setTimeout];
    </script>`,
    { waitUntil: "domcontentloaded" },
  );

  expect(await page.evaluate(() => Reflect.get(window, "__r"))).toEqual({
    own: ["fetch", "DOMException"],
    ownAfter: ["fetch", "DOMException", "Headers", "Request", "Response"],
    globalsKept: [true, true],
    created: [false, true],
    userGlobal: ["page", "heir", true],
    onload: "TypeError",
    onloadAfter: null,
    documentSloppy: false,
    documentStrict: "TypeError",
    nan: false,
    named: [true, true],
    ops: [["addEventListener", "setTimeout"], "function", "function"],
  });
});
