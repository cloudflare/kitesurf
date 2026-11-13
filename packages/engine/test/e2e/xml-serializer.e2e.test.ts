// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

// Every expected string in this file is what Chrome returns for the same code, recorded
// from Chrome rather than derived from the specification.

test("XMLSerializer writes each kind of node as Chrome does", async ({ page }) => {
  await setContent(page, "<!doctype html><body></body>");
  const serialized = await page.evaluate(() => {
    const SVG = "http://www.w3.org/2000/svg";
    const XLINK = "http://www.w3.org/1999/xlink";
    const serialize = (node: Node) => new XMLSerializer().serializeToString(node);
    const host = document.createElement("div");
    host.innerHTML =
      '<p id="a" data-q="q &amp; &lt;l&gt;">text &amp; more<br><input disabled></p>' +
      '<svg width="10"><circle r="4"/><a xlink:href="#x">l</a></svg>' +
      "<template><b>in</b></template><style>p > b {}</style>";
    document.body.append(host);
    const fragment = document.createDocumentFragment();
    fragment.append(document.createElement("i"), "x");
    const namespaced = document.createElementNS(SVG, "use");
    namespaced.setAttributeNS(XLINK, "xlink:href", "#a");
    const plain = document.createElementNS(SVG, "use");
    plain.setAttribute("xlink:href", "#a");
    const strict = document.implementation.createDocumentType(
      "html",
      "-//W3C//DTD XHTML 1.0 Strict//EN",
      "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd",
    );
    let refused = "no error";
    try {
      serialize(JSON.parse("{}"));
    } catch (error) {
      refused = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    return {
      doctype: document.doctype ? serialize(document.doctype) : null,
      strict: serialize(strict),
      comment: serialize(document.createComment(" a -- b ")),
      text: serialize(document.createTextNode('a < b & c > d "q"')),
      host: serialize(host),
      fragment: serialize(fragment),
      namespaced: serialize(namespaced),
      plain: serialize(plain),
      refused,
    };
  });

  expect(serialized).toEqual({
    doctype: "<!DOCTYPE html>",
    strict:
      '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" ' +
      '"http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">',
    comment: "<!-- a -- b -->",
    text: 'a &lt; b &amp; c &gt; d "q"',
    host:
      '<div xmlns="http://www.w3.org/1999/xhtml">' +
      '<p id="a" data-q="q &amp; &lt;l&gt;">text &amp; more<br /><input disabled="" /></p>' +
      '<svg xmlns="http://www.w3.org/2000/svg" width="10"><circle r="4"/>' +
      '<a xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#x">l</a></svg>' +
      "<template><b>in</b></template><style>p &gt; b {}</style></div>",
    fragment: '<i xmlns="http://www.w3.org/1999/xhtml"></i>x',
    namespaced:
      '<use xmlns="http://www.w3.org/2000/svg" ' +
      'xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#a"/>',
    plain: '<use xmlns="http://www.w3.org/2000/svg" xlink:href="#a"/>',
    refused:
      "TypeError: Failed to execute 'serializeToString' on 'XMLSerializer': " +
      "parameter 1 is not of type 'Node'.",
  });
});

test("page.content() returns the doctype and the document", async ({ page }) => {
  const html =
    '<!DOCTYPE html><!-- c --><html lang="en"><head><title>t</title></head>' +
    '<body><p title="a&lt;b">x</p><template><b>in</b></template></body></html>';
  await setContent(page, html);

  // Puppeteer serializes the doctype and the comment with XMLSerializer, and the document
  // element with outerHTML, so this needs both; it threw before the first existed.
  expect(await page.content()).toBe(html);
  await page.evaluate(() => void document.querySelector("template")?.content.firstChild);
  expect(await page.content()).toBe(html);
});
