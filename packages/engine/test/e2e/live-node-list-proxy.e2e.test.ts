// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<div id="a"><i id="a1"></i><i id="a2"></i></div>
<div id="b"><i id="b1"></i></div>
<script>
  (function () {
    var a = document.getElementById("a");
    var b = document.getElementById("b");
    var left = a.childNodes;
    var right = b.childNodes;
    var initial = [left === a.childNodes, right === b.childNodes, left !== right,
      left.length, left[0].id, left[1].id, right.length, right[0].id];
    var methods = [left.forEach === Array.prototype.forEach,
      left.values === Array.prototype.values, left[Symbol.iterator] === Array.prototype[Symbol.iterator]];
    var indexes = [left["01"].id, "01" in left, "2" in left, "length" in left,
      left[2] === undefined, left.item(2), left.item.call({}, 0)];
    var strictWrites = (function () {
      "use strict";
      var indexError, lengthError;
      try { left[0] = null; } catch (e) { indexError = e.constructor.name; }
      try { left.length = 0; } catch (e) { lengthError = e.constructor.name; }
      return [indexError, lengthError];
    })();
    left.extra = "ordinary";
    Object.defineProperty(left, "fixed", { value: "string" });
    var symbol = Symbol("fixed");
    Object.defineProperty(left, symbol, { value: "symbol" });
    Object.defineProperty(left, "receiverKey", { get: function () { return this.marker; } });
    var keys = Reflect.ownKeys(left).map(function (key) {
      return key === symbol ? "symbol" : key;
    });
    var lengthDesc = Object.getOwnPropertyDescriptor(left, "length");
    var indexDesc = Object.getOwnPropertyDescriptor(left, "0");
    var reflection = {
      keys: keys,
      values: [left.extra, left.fixed, left[symbol],
        Reflect.get(left, "receiverKey", { marker: "receiver" })],
      length: [lengthDesc.value, lengthDesc.writable, lengthDesc.enumerable, lengthDesc.configurable],
      index: [indexDesc.value.id, indexDesc.writable, indexDesc.enumerable, indexDesc.configurable],
    };
    var addedA = document.createElement("i");
    addedA.id = "a3";
    a.appendChild(addedA);
    var afterA = [left.length, left[2].id, right.length, right[0].id];
    b.removeChild(b.firstChild);
    var afterB = [left.length, left[2].id, right.length, right[0] === undefined, right.item(0)];
    globalThis.__liveNodeListReport = JSON.stringify({
      initial: initial, methods: methods, indexes: indexes, strictWrites: strictWrites,
      reflection: reflection, afterA: afterA, afterB: afterB,
    });
  })();
</script>`;

test("live child NodeLists keep independent contents and proxy behavior", async ({
  page,
  cdpSession,
}) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__liveNodeListReport")).toEqual({
    initial: [true, true, true, 2, "a1", "a2", 1, "b1"],
    methods: [true, true, true],
    indexes: ["a2", true, false, true, true, null, null],
    strictWrites: ["TypeError", "TypeError"],
    reflection: {
      keys: ["0", "1", "length", "extra", "fixed", "receiverKey", "symbol"],
      values: ["ordinary", "string", "symbol", "receiver"],
      length: [2, false, false, true],
      index: ["a1", false, true, true],
    },
    afterA: [3, "a3", 1, "b1"],
    afterB: [3, "a3", 0, true, null],
  });
}, 60_000);
