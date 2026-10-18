// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("a page-wrapped createElement does not leak into the engine's own clones", async ({
  page,
}) => {
  await setContent(
    page,
    `<!doctype html><title>t</title><p id="p">x</p><script>
    const B = document.createElement;
    document.createElement = function (tag) {
      const a = B.bind(document).apply(void 0, arguments);
      if (String(tag).toLowerCase() === "script") {
        Object.defineProperty(a, "src", { get() { try { return a.cloneNode().src; } catch (e) { return a.getAttribute("src") || ""; } } });
      }
      return a;
    };
    new MutationObserver((recs) => { for (const r of recs) for (const n of r.addedNodes) if (n.nodeName === "SCRIPT") window.__seen = String(n.src); })
      .observe(document.documentElement, { childList: true, subtree: true });
    const s = document.createElement("script"); s.textContent = "window.__ran = 1"; document.head.appendChild(s);
  </script>`,
  );
  await new Promise((r) => setTimeout(r, 300));
  const state = await page.evaluate(`JSON.stringify({
    ran: window.__ran, seen: window.__seen,
    created: document.createElementNS("http://www.w3.org/1999/xhtml", "i").nodeType,
    setAttr: (() => { const p = document.getElementById("p"); p.setAttribute("data-z", "7"); return p.getAttribute("data-z"); })(),
    width: Math.round(document.getElementById("p").getBoundingClientRect().width) > 0,
  })`);
  expect(JSON.parse(state as string)).toEqual({
    ran: 1,
    seen: "",
    created: 1,
    setAttr: "7",
    width: true,
  });
}, 60_000);

test("engine-built scratch and skeleton nodes skip a page-wrapped document factory", async ({
  page,
}) => {
  await setContent(page, `<!doctype html><title>t</title><p id="p">x</p>`);
  const state = await page.evaluate(`JSON.stringify((() => {
    const calls = [];
    for (const m of ["createElement", "createElementNS", "createTextNode", "createComment", "createDocumentFragment"]) {
      const orig = document[m];
      document[m] = function () { calls.push(m); return orig.apply(this, arguments); };
    }
    document.getElementById("p").outerHTML = "<b id=b>y</b>";
    document.adoptedStyleSheets = [new CSSStyleSheet()];
    const d = document.implementation.createHTMLDocument("t");
    const made = [d.createElement("i"), d.createElementNS("http://www.w3.org/1999/xhtml", "u"),
      d.createTextNode("x"), d.createComment("c"), d.createDocumentFragment().cloneNode(true)].map((n) => n.nodeType);
    const xml = document.implementation.createDocument(null, "root", null);
    return { calls, b: document.getElementById("b").textContent, title: d.title, made, root: xml.documentElement.localName };
  })())`);
  expect(JSON.parse(String(state))).toEqual({
    calls: [],
    b: "y",
    title: "t",
    made: [1, 1, 3, 8, 11],
    root: "root",
  });
}, 60_000);
