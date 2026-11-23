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

test("XMLSerializer declares and prefixes namespaces as Chrome does", async ({ page }) => {
  await setContent(page, "<!doctype html><body></body>");
  const serialized = await page.evaluate(() => {
    const SVG = "http://www.w3.org/2000/svg";
    const XLINK = "http://www.w3.org/1999/xlink";
    const XMLNS = "http://www.w3.org/2000/xmlns/";
    const XML = "http://www.w3.org/XML/1998/namespace";
    const serialize = (node: Node) => new XMLSerializer().serializeToString(node);
    const element = (ns: string, name: string) => document.createElementNS(ns, name);
    const parsed = (html: string) => {
      const div = document.createElement("div");
      div.innerHTML = html;
      return div.firstChild as Element;
    };

    const twoPrefixes = element(SVG, "use");
    twoPrefixes.setAttributeNS(XLINK, "p:a", "1");
    twoPrefixes.setAttributeNS("urn:z", "p:b", "2");
    const siblings = element("uri1", "r");
    for (const name of ["a", "b"]) {
      const child = element("uri1", name);
      child.setAttributeNS("urn:x", "foo", name);
      siblings.append(child);
    }
    const bound = element("uri1", "r");
    bound.setAttributeNS(XMLNS, "xmlns:q", "urn:q");
    const boundChild = element("uri1", "e");
    boundChild.setAttributeNS("urn:q", "a", "1");
    bound.append(boundChild);
    const plain = element("uri1", "r");
    plain.setAttribute("xmlns:q", "urn:q");
    const plainChild = element("uri1", "e");
    plainChild.setAttributeNS("urn:q", "a", "1");
    plain.append(plainChild);
    const defaults = element(SVG, "svg");
    const same = element(SVG, "g");
    const other = element(SVG, "g");
    same.setAttributeNS(XMLNS, "xmlns", SVG);
    other.setAttributeNS(XMLNS, "xmlns", "urn:y");
    defaults.append(same, other);
    const xmlElement = element(XML, "foo");
    xmlElement.append(element(XML, "bar"), "t");
    const xmlAttribute = element(SVG, "svg");
    xmlAttribute.setAttributeNS(XML, "abc:foo", "test");

    return {
      carriedOther: serialize(parsed('<svg id="s" xmlns="urn:x"><g></g></svg>')),
      carriedWrong: serialize(parsed('<svg xmlns:xlink="urn:wrong"><use xlink:href="#a"/></svg>')),
      twoPrefixes: serialize(twoPrefixes),
      siblings: serialize(siblings),
      bound: serialize(bound),
      plain: serialize(plain),
      defaults: serialize(defaults),
      xmlElement: serialize(xmlElement),
      xmlAttribute: serialize(xmlAttribute),
    };
  });

  expect(serialized).toEqual({
    carriedOther: '<svg xmlns="http://www.w3.org/2000/svg" id="s"><g/></svg>',
    carriedWrong:
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="urn:wrong">' +
      '<use xmlns:ns1="http://www.w3.org/1999/xlink" ns1:href="#a"/></svg>',
    twoPrefixes:
      '<use xmlns="http://www.w3.org/2000/svg" xmlns:p="http://www.w3.org/1999/xlink" ' +
      'p:a="1" xmlns:ns1="urn:z" ns1:b="2"/>',
    siblings:
      '<r xmlns="uri1"><a xmlns:ns1="urn:x" ns1:foo="a"/><b xmlns:ns2="urn:x" ns2:foo="b"/></r>',
    bound: '<r xmlns="uri1" xmlns:q="urn:q"><e q:a="1"/></r>',
    plain: '<r xmlns="uri1" xmlns:q="urn:q"><e xmlns:ns1="urn:q" ns1:a="1"/></r>',
    defaults:
      '<svg xmlns="http://www.w3.org/2000/svg"><g xmlns="http://www.w3.org/2000/svg"/><g/></svg>',
    xmlElement: "<xml:foo><xml:bar/>t</xml:foo>",
    xmlAttribute: '<svg xmlns="http://www.w3.org/2000/svg" xml:foo="test"/>',
  });
});
