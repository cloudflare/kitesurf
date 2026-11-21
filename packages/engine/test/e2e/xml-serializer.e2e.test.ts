// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// XMLSerializer.serializeToString must exist and produce XML that an SVG data URL can carry:
// pages feature-detect XMLSerializer and call it to rasterize inline SVG.
import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("XMLSerializer serializes HTML, SVG and XML nodes", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html>
<svg id="mark" viewBox="0 0 10 10"><path d="M0 0L10 10"/><use href="#x"/></svg>
<p id="para">a &amp; b<br><!--note--></p>
<template id="tpl"><i>inside</i></template>`,
    { waitUntil: "domcontentloaded" },
  );
  const got = await page.evaluate(() => {
    const s = new XMLSerializer();
    // An element with no namespace, as an XML document holds; DOMParser here parses
    // application/xml as HTML, so the document is built directly.
    const xml = document.implementation.createDocument(null, "root");
    const leaf = xml.createElementNS(null, "leaf");
    leaf.setAttribute("a", "1");
    xml.documentElement!.appendChild(leaf);
    let noArg = "";
    try {
      (s as any).serializeToString();
    } catch (e) {
      noArg = (e as Error).name;
    }
    return {
      svg: s.serializeToString(document.getElementById("mark")!),
      para: s.serializeToString(document.getElementById("para")!),
      tpl: s.serializeToString(document.getElementById("tpl")!),
      text: s.serializeToString(document.createTextNode("<x>")),
      xmlLeaf: s.serializeToString(leaf),
      noArg,
    };
  });
  expect(got).toEqual({
    svg: '<svg xmlns="http://www.w3.org/2000/svg" id="mark" viewBox="0 0 10 10"><path d="M0 0L10 10"/><use href="#x"/></svg>',
    para: '<p xmlns="http://www.w3.org/1999/xhtml" id="para">a &amp; b<br /><!--note--></p>',
    tpl: '<template xmlns="http://www.w3.org/1999/xhtml" id="tpl"><i>inside</i></template>',
    text: "&lt;x&gt;",
    xmlLeaf: '<leaf a="1"/>',
    noArg: "TypeError",
  });
});
