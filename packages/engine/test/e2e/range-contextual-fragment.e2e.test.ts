// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<table><tbody id=tb></tbody></table><div id=d>text</div><template id=tpl></template><svg id=sv></svg><script>
  (function () {
    function fragmentAt(node, markup) {
      var r = document.createRange();
      r.setStart(node, 0);
      return r.createContextualFragment(markup);
    }
    function firstName(fragment) {
      return fragment.firstChild ? fragment.firstChild.nodeName : null;
    }
    var out = {};
    // A <template> start parses in template context and keeps its nodes,
    // including the row a <div> context would drop.
    var tpl = document.getElementById("tpl");
    var tplFrag = fragmentAt(tpl, "<b>x</b>");
    out.template = [tplFrag.childNodes.length, firstName(tplFrag),
      firstName(fragmentAt(tpl, "<tr><td>x</td></tr>"))];
    // A custom element start must not construct a second instance.
    var constructed = 0;
    customElements.define("x-probe", class extends HTMLElement {
      constructor() { super(); constructed++; }
    });
    var probe = document.body.appendChild(document.createElement("x-probe"));
    var created = constructed;
    var ceFrag = fragmentAt(probe, "<i>c</i>");
    out.customElement = [created, constructed, firstName(ceFrag)];
    // Page replacements of the document factories, the innerHTML setter and
    // the methods innerHTML uses to stamp IDs must not see the
    // engine-internal parse.
    var tb = document.getElementById("tb");
    var hooked = [];
    function hookMethod(obj, name) {
      var owner = obj;
      while (owner && !Object.prototype.hasOwnProperty.call(owner, name)) {
        owner = Object.getPrototypeOf(owner);
      }
      var orig = owner[name];
      owner[name] = function () {
        hooked.push(name);
        return orig.apply(this, arguments);
      };
      return function () { owner[name] = orig; };
    }
    var unhooks = [
      hookMethod(document.createDocumentFragment(), "querySelectorAll"),
      hookMethod(document.body, "getAttribute"),
      hookMethod(document, "getElementById"),
    ];
    var origCreateElementNS = document.createElementNS;
    var origCreateFragment = document.createDocumentFragment;
    var innerHTMLDesc = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
    document.createElementNS = function () {
      hooked.push("createElementNS");
      return origCreateElementNS.apply(this, arguments);
    };
    document.createDocumentFragment = function () {
      hooked.push("createDocumentFragment");
      return origCreateFragment.apply(this, arguments);
    };
    Object.defineProperty(Element.prototype, "innerHTML", {
      configurable: true,
      get: innerHTMLDesc.get,
      set: function (v) { hooked.push("innerHTML"); innerHTMLDesc.set.call(this, v); },
    });
    try {
      out.hooks = [hooked, firstName(fragmentAt(tb, "<tr id=hk><td>h</td></tr>"))];
    } finally {
      unhooks.forEach(function (unhook) { unhook(); });
      document.createElementNS = origCreateElementNS;
      document.createDocumentFragment = origCreateFragment;
      Object.defineProperty(Element.prototype, "innerHTML", innerHTMLDesc);
    }
    // An ID in the parsed markup names the element once it is inserted.
    var idFrag = fragmentAt(document.body, "<p id=cfp>x</p>");
    var idTarget = idFrag.firstChild;
    document.body.appendChild(idFrag);
    out.namedGlobal = window.cfp === idTarget;
    // usvg turns svg <text> into outlines, so a parse that can create one
    // asks for the full fonts, as innerHTML does.
    var demands = 0;
    var origDemand = globalThis.__ksFontOutlineDemand;
    globalThis.__ksFontOutlineDemand = function () {
      demands++;
      return origDemand ? origDemand.apply(this, arguments) : undefined;
    };
    try {
      fragmentAt(document.body, "<svg><text x=0 y=10>Hi</text></svg>");
      fragmentAt(document.getElementById("sv"), "<text x=0 y=10>Hi</text>");
      fragmentAt(document.body, "<p>no svg text</p>");
    } finally {
      globalThis.__ksFontOutlineDemand = origDemand;
    }
    out.fontDemand = demands;
    // A <tbody> context keeps the <tr>; a <div> context drops the row
    // and cell tags and keeps only their text.
    out.tbody = fragmentAt(document.getElementById("tb"), "<tr><td>x</td></tr>").firstChild.nodeName;
    out.div = fragmentAt(document.getElementById("d"), "<tr><td>x</td></tr>").firstChild.nodeName;
    // Text starts use their parent; the document and <html> use <body>.
    out.text = fragmentAt(document.getElementById("d").firstChild, "<b>t</b>").firstChild.nodeName;
    out.documentStart = fragmentAt(document, "<p>a</p>").firstChild.nodeName;
    out.htmlStart = fragmentAt(document.documentElement, "<p>a</p>").firstChild.nodeName;
    var frag = fragmentAt(document.body, "<i>1</i>2");
    out.shape = [frag instanceof DocumentFragment, frag.ownerDocument === document,
      frag.childNodes.length, Range.prototype.createContextualFragment.length];
    out.nullMarkup = fragmentAt(document.body, null).textContent;
    document.body.appendChild(fragmentAt(document.body, "<script>window.__fragRan = 1<\\/script>"));
    var div = document.createElement("div");
    div.innerHTML = "<script>window.__innerRan = 1<\\/script>";
    document.body.appendChild(div);
    setTimeout(function () {
      out.scripts = [window.__fragRan === 1, window.__innerRan === undefined];
      globalThis.__cfReport = JSON.stringify(out);
    }, 50);
  })();
</script>`;

test("Range.createContextualFragment parses in context", async ({ page, cdpSession }) => {
  await setContent(page, html, { waitUntil: "load" });
  await page.waitForFunction("typeof globalThis.__cfReport === 'string'");
  expect(await readJsonReport(cdpSession, "globalThis.__cfReport")).toEqual({
    template: [1, "B", "TR"],
    customElement: [1, 1, "I"],
    hooks: [[], "TR"],
    namedGlobal: true,
    fontDemand: 2,
    tbody: "TR",
    div: "#text",
    text: "B",
    documentStart: "P",
    htmlStart: "P",
    shape: [true, true, 2, 1],
    nullMarkup: "null",
    scripts: [true, true],
  });
}, 60_000);
