// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<div id=a><span></span>text</div><script>
  (function () {
    var a = document.getElementById("a");
    var make = {
      treeWalker: function () { return document.createTreeWalker(a, NodeFilter.SHOW_ELEMENT); },
      nodeIterator: function () { return document.createNodeIterator(a); },
      validity: function () { return document.createElement("input").validity; },
      xpathResult: function () { return document.evaluate("//span", document, null, 0, null); },
      xpathExpression: function () { return document.createExpression("//span"); },
      range: function () { var r = document.createRange(); r.selectNodeContents(a); return r; },
      staticRange: function () { return new StaticRange({ startContainer: a, startOffset: 0, endContainer: a, endOffset: 1 }); },
      selection: function () { var s = getSelection(); s.selectAllChildren(a); return s; },
      formData: function () { var f = new FormData(); f.append("k", "v"); return f; },
      mutationObserver: function () { return new MutationObserver(function () {}); },
      implementation: function () { return document.implementation; },
      dataTransfer: function () { return new DataTransfer(); },
      dataTransferItems: function () { return new DataTransfer().items; },
      dataTransferItem: function () { return new DataTransfer().items.add("x", "text/plain"); },
      mutationRecord: function () {
        var observer = new MutationObserver(function () {});
        observer.observe(a, { attributes: true });
        a.setAttribute("data-x", "1");
        return observer.takeRecords()[0];
      },
    };
    var ownKeys = {};
    for (var k in make) ownKeys[k] = Object.getOwnPropertyNames(make[k]());
    var walker = make.treeWalker();
    var iterator = make.nodeIterator();
    var span = a.firstChild;
    var walked = walker.firstChild() === span;
    var xpathFirst = make.xpathResult().iterateNext() === span;
    iterator.nextNode();
    iterator.nextNode();
    a.removeChild(span);
    globalThis.__ownReport = JSON.stringify({
      ownKeys: ownKeys,
      walker: [walker.root === a, walker.whatToShow, walker.filter, walked,
        Object.prototype.hasOwnProperty.call(TreeWalker.prototype, "root")],
      // The removed span was the reference node; pre-removal moves it back.
      iterator: [iterator.referenceNode === a, iterator.pointerBeforeReferenceNode],
      validity: [make.validity().valid, make.validity() instanceof ValidityState],
      range: [make.range() instanceof AbstractRange, make.staticRange() instanceof AbstractRange,
        make.range().endOffset, make.staticRange().collapsed,
        (function () { try { new AbstractRange(); return "none"; } catch (e) { return e.constructor.name; } })()],
      record: [make.mutationRecord().type, make.mutationRecord().attributeName,
        (function () { try { new MutationRecord(); return "none"; } catch (e) { return e.constructor.name; } })()],
      internals: [Selection, DOMParser].map(function (C) {
        return Object.getOwnPropertyNames(C.prototype).filter(function (k) { return k[0] === "_"; });
      }),
      implementation: [make.implementation().createHTMLDocument("t").title,
        make.implementation().createDocumentType("html", "", "").ownerDocument === document],
      selection: [make.selection().focusOffset, make.selection().getRangeAt(0).endOffset],
      formData: [make.formData().get("k"), Array.from(make.formData().keys()),
        (function () { try { FormData.prototype.get.call({}, "k"); return "none"; } catch (e) { return e.constructor.name; } })(),
        FormData.length, FormData.prototype.append.length],
      xpath: [xpathFirst, typeof XPathResult._make, typeof XPathExpression._make],
      styleDeclaration: (function () {
        var el = document.createElement("div");
        el.style.color = "red";
        el.style.setProperty("margin-top", "1px");
        var sheet = new CSSStyleSheet();
        sheet.insertRule("p { color: blue }");
        var decls = [el.style, sheet.cssRules[0].style, getComputedStyle(a)];
        return [decls.map(function (d) { return Object.getPrototypeOf(d) === CSSStyleDeclaration.prototype; }),
          el.style.setProperty === el.style.setProperty,
          CSSStyleDeclaration.prototype.getPropertyValue.call(el.style, "color"),
          sheet.cssRules[0].style.parentRule === sheet.cssRules[0],
          Object.keys(el.style), el.style.length, el.style.cssText];
      })(),
      styleSheet: (function () {
        var st = document.createElement("style");
        st.textContent = "p { color: red }";
        document.head.appendChild(st);
        var constructed = new CSSStyleSheet({ disabled: true });
        constructed.replaceSync("a { color: blue } b { color: green }");
        var sheets = [st.sheet, constructed];
        var result = [Object.getPrototypeOf(CSSStyleSheet.prototype) === StyleSheet.prototype,
          sheets.map(function (s) { return Object.getOwnPropertyNames(s); }),
          sheets.map(function (s) { return s.cssRules === s.cssRules && s.media instanceof MediaList; }),
          st.sheet.ownerNode === st, st.sheet.cssRules.length, constructed.cssRules.length,
          constructed.disabled, constructed.ownerNode,
          (function () { try { new StyleSheet(); return "none"; } catch (e) { return e.constructor.name; } })()];
        st.remove();
        return result;
      })(),
      mediaList: (function () {
        var m = new CSSStyleSheet().media;
        m.appendMedium("screen");
        m.appendMedium("print");
        m.deleteMedium("screen");
        m.appendMedium("tv");
        return [m instanceof MediaList, Array.isArray(m), m.length, m[1], String(m),
          Object.getOwnPropertyNames(m), typeof MediaList.prototype.appendMedium,
          (function () { try { return [...m].join(); } catch (e) { return e.constructor.name; } })(),
          m[Symbol.iterator] === Array.prototype.values];
      })(),
      tokenList: (function () {
        var list = document.createElement("div").classList;
        list.add("a", "b");
        return [typeof DOMTokenList.prototype.add, list.add === list.add, list.value,
          list.toggle("a"), String(list), list.replace("b", "c"), list[0],
          list.forEach === Array.prototype.forEach,
          list[Symbol.iterator] === Array.prototype[Symbol.iterator]];
      })(),
      dataTransfer: (function () {
        var dt = make.dataTransfer();
        dt.dropEffect = "copy";
        var item = dt.items.add("x", "text/plain");
        return [dt.dropEffect, dt.effectAllowed, dt.items.length, item.kind, item.type,
          (function () {
            try { Object.getOwnPropertyDescriptor(DataTransfer.prototype, "dropEffect").get.call({}); return "none"; }
            catch (e) { return e.constructor.name; }
          })(),
          DataTransferItem.length, DataTransferItemList.prototype.add.length,
          [DataTransferItem, DataTransferItemList].map(function (C) {
            try { new C(); return "none"; } catch (e) { return e.constructor.name; }
          })];
      })(),
    });
  })();
</script>`;

test("platform objects have no own properties", async ({ page, cdpSession }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__ownReport")).toEqual({
    ownKeys: {
      treeWalker: [],
      nodeIterator: [],
      validity: [],
      xpathResult: [],
      xpathExpression: [],
      mutationObserver: [],
      mutationRecord: [],
      range: [],
      staticRange: [],
      selection: [],
      formData: [],
      implementation: [],
      dataTransfer: [],
      dataTransferItems: [],
      dataTransferItem: [],
    },
    // Inline, rule and computed declarations share CSSStyleDeclaration's
    // prototype members; the CSS properties stay the inline style's own keys.
    styleDeclaration: [
      [true, true, true],
      true,
      "red",
      true,
      ["color", "marginTop"],
      2,
      "color: red; margin-top: 1px;",
    ],
    // Both kinds of sheet keep their state off the instance, behind
    // CSSStyleSheet and StyleSheet prototype members.
    styleSheet: [true, [[], []], [true, true], true, 1, 2, true, null, "TypeError"],
    // MediaList is a platform object, not an array: its members sit on the
    // prototype and its only own properties are the indexes. It still
    // iterates, with Array.prototype.values as WebIDL specifies.
    mediaList: [true, false, 2, "tv", "print, tv", ["0", "1"], "function", "print,tv", true],
    // DOMTokenList's operations are prototype methods, not per-read closures.
    tokenList: ["function", true, "a b", false, "b", true, "c", true, true],
    // DataTransfer attributes are prototype getters that check their receiver.
    // Only DataTransfer itself is constructible.
    dataTransfer: [
      "copy",
      "uninitialized",
      1,
      "string",
      "text/plain",
      "TypeError",
      0,
      1,
      ["TypeError", "TypeError"],
    ],
    // Internal methods are private too, not prototype members.
    internals: [[], []],
    selection: [1, 1],
    implementation: ["t", true],
    // FormData operations check their receiver and have the IDL lengths.
    formData: ["v", ["k"], "TypeError", 0, 2],
    range: [true, true, 1, false, "TypeError"],
    record: ["attributes", "data-x", "TypeError"],
    walker: [true, 1, null, true, true],
    iterator: [true, false],
    validity: [true, true],
    xpath: [true, "undefined", "undefined"],
  });
}, 60_000);
