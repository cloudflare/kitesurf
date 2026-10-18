// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A style declaration inherits Object.prototype like any platform object:
// toString, valueOf and hasOwnProperty come from the prototype chain, not
// from the CSS property lookup, which would answer "" for them.
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<style>p { color: red }</style><p id="p" style="color: blue">x</p><script>
  (function () {
    function members(style) {
      try {
        return [String(style), typeof style.valueOf, typeof style.hasOwnProperty("color"), style.isPrototypeOf(style)];
      } catch (e) {
        return e.name;
      }
    }
    var p = document.getElementById("p");
    globalThis.__membersReport = JSON.stringify({
      computed: members(getComputedStyle(p)),
      inline: members(p.style),
      rule: members(document.styleSheets[0].cssRules[0].style),
    });
  })();
</script>`;

// A property the page defines on a declaration lives beside the CSS data,
// so reflection must list it and leave it alone. Object.defineProperty's
// defaults make it non-configurable, which Proxy invariants enforce.
const ownPropsHtml = `<style>p { color: red }</style><p id="p" style="color: blue">x</p><script>
  (function () {
    function run(f) {
      try { return f(); } catch (e) { return e.name; }
    }
    function reflect(style) {
      Object.defineProperty(style, "pageProp", { value: 1 });
      return [
        run(function () { return Object.getOwnPropertyNames(style).indexOf("pageProp") >= 0; }),
        run(function () { return Object.getOwnPropertyDescriptor(style, "pageProp").value; }),
        run(function () { return Object.keys(style).indexOf("pageProp") < 0; }),
        run(function () { return delete style.pageProp; }),
        run(function () { return style.pageProp; }),
      ];
    }
    var p = document.getElementById("p");
    var frozen = p.style;
    globalThis.__ownPropsReport = JSON.stringify({
      computed: reflect(getComputedStyle(p)),
      inline: reflect(p.style),
      rule: reflect(document.styleSheets[0].cssRules[0].style),
      freeze: run(function () { Object.freeze(frozen); return "frozen"; }),
      afterFreeze: run(function () {
        frozen.color = "green";
        return [Object.isExtensible(frozen), frozen.color, Object.keys(frozen).indexOf("color") >= 0];
      }),
    });
  })();
</script>`;

test("style declarations reflect properties the page defines on them", async ({
  page,
  cdpSession,
}) => {
  await setContent(page, ownPropsHtml, { waitUntil: "domcontentloaded" });
  const expected = [true, 1, true, false, 1];
  expect(await readJsonReport(cdpSession, "globalThis.__ownPropsReport")).toEqual({
    computed: expected,
    inline: expected,
    rule: expected,
    freeze: "TypeError",
    afterFreeze: [true, "green", true],
  });
}, 60_000);

test("style declarations keep Object.prototype's members", async ({ page, cdpSession }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  const expected = ["[object CSSStyleDeclaration]", "function", "boolean", false];
  expect(await readJsonReport(cdpSession, "globalThis.__membersReport")).toEqual({
    computed: expected,
    inline: expected,
    rule: expected,
  });
}, 60_000);

// item() takes an unsigned long, so every kind of declaration converts the
// index the same way: "1" and 1.5 read index 1, a non-number reads index 0.
const itemHtml = `<style>p { color: red; margin-top: 1px }</style>
<p id="p" style="color: blue; margin-top: 2px">x</p><script>
  (function () {
    function items(style) {
      return [style.item("1"), style.item(1.5), style.item("x"), style.item(-1)];
    }
    var p = document.getElementById("p");
    var computed = getComputedStyle(p);
    globalThis.__itemReport = JSON.stringify({
      inline: items(p.style),
      rule: items(document.styleSheets[0].cssRules[0].style),
      computed: [computed.item("1") === computed.item(1), computed.item(1.5) === computed.item(1),
        computed.item("x") === computed.item(0), computed.item(-1)],
    });
  })();
</script>`;

test("style declarations convert item()'s index the same way", async ({ page, cdpSession }) => {
  await setContent(page, itemHtml, { waitUntil: "domcontentloaded" });
  const expected = ["margin-top", "margin-top", "color", ""];
  expect(await readJsonReport(cdpSession, "globalThis.__itemReport")).toEqual({
    inline: expected,
    rule: expected,
    computed: [true, true, true, ""],
  });
}, 60_000);
