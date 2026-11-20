// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<div id="a" class="one two one"></div><div id="b" class="other"></div>
<link id="link" rel="stylesheet alternate">
<script>
  (function () {
    var a = document.getElementById("a"), b = document.getElementById("b");
    var left = a.classList, right = b.classList, rel = document.getElementById("link").relList;
    var initial = [left === a.classList, left !== right, left.length, left["01"],
      "01" in left, "2" in left, left.item(2), right[0]];
    var descriptor = Object.getOwnPropertyDescriptor(left, "1");
    var reflection = [Reflect.ownKeys(left), descriptor.value, descriptor.writable,
      descriptor.enumerable, descriptor.configurable,
      Object.getOwnPropertyDescriptor(left, "length").enumerable];
    var methods = [left.values === Array.prototype.values, left.keys === Array.prototype.keys,
      left.entries === Array.prototype.entries, left.forEach === Array.prototype.forEach];
    var rejected = (function () {
      "use strict";
      try { left[0] = "changed"; return false; }
      catch (error) { return error instanceof TypeError; }
    })();
    a.setAttribute("class", "fresh last");
    var refreshed = [left.length, left[0], left[1], right.value];
    left.value = "written token";
    right.add("second");
    var unsupported;
    try { left.supports("stylesheet"); }
    catch (error) { unsupported = error instanceof TypeError; }
    globalThis.__tokenListReport = JSON.stringify({ initial: initial, reflection: reflection,
      methods: methods, rejected: rejected, refreshed: refreshed,
      written: [a.getAttribute("class"), right.value, left[0]],
      supported: [rel.supports("stylesheet"), unsupported, rel[0], rel.length] });
  })();
</script>`;

test("live token lists keep independent backing state through proxy operations", async ({
  page,
  cdpSession,
}) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__tokenListReport")).toEqual({
    initial: [true, true, 2, "two", true, false, null, "other"],
    reflection: [["0", "1", "length"], "two", false, true, true, false],
    methods: [true, true, true, true],
    rejected: true,
    refreshed: [2, "fresh", "last", "other"],
    written: ["written token", "other second", "written"],
    supported: [true, true, "stylesheet", 2],
  });
});
