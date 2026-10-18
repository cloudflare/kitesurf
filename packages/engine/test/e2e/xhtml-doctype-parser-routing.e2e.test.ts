// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const XHTML = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
 <head>
  <title>CSS Reftest Reference</title>
  <style type="text/css"><![CDATA[
  div
  {
  background-color: green;
  height: 100px;
  width: 100px;
  }
  ]]></style>
 </head>
 <body>
  <p>Test passes if there is a filled green square and <strong>no red</strong>.</p>
  <div></div>
 </body>
</html>`;

test("DOCTYPE-first XHTML keeps the XML parser and its CDATA stylesheet", async ({ page }) => {
  await setContent(page, XHTML);
  const r = await page.evaluate(() => {
    const div = document.querySelector("div")!;
    const rect = div.getBoundingClientRect();
    const cs = getComputedStyle(div);
    return {
      width: rect.width,
      height: rect.height,
      background: cs.backgroundColor,
      styleText: document.querySelector("style")!.textContent ?? "",
      firstChildIsDoctype: document.firstChild === document.doctype,
      childTypes: [...document.childNodes].map((n) => n.nodeType),
    };
  });

  expect(r.width).toBe(100);
  expect(r.height).toBe(100);
  expect(r.background).toBe("rgb(0, 128, 0)");
  expect(r.styleText).not.toContain("CDATA");
  expect(r.firstChildIsDoctype).toBe(true);
  expect(r.childTypes).toEqual([10, 1]);
});

const MINIFIED_HTML =
  `<!DOCTYPE html><html><head><link rel="preconnect" href="https://a.example/">` +
  `<link rel="preconnect" href="https://b.example/"><title>Maps-like</title>` +
  `<script>window.__isXml = document.contentType === "application/xhtml+xml";</script>` +
  `</head><body><p>body text</p></body></html>`;

test("an HTML doctype stays HTML when its line mentions xhtml later on", async ({ page }) => {
  await setContent(page, MINIFIED_HTML);
  const r = await page.evaluate(() => ({
    titleParent: document.querySelector("title")!.parentNode!.nodeName,
    head: [...document.head.children].map((e) => e.nodeName),
    linkChildren: document.querySelector("link")!.childNodes.length,
    ranScript: (window as typeof window & { __isXml?: boolean }).__isXml,
    bodyText: document.body.innerText.trim(),
  }));
  expect(r).toEqual({
    titleParent: "HEAD",
    head: ["LINK", "LINK", "TITLE", "SCRIPT"],
    linkChildren: 0,
    ranScript: false,
    bodyText: "body text",
  });
});

const COMMENTED_XHTML =
  `<!DOCTYPE html><!-- <svg> --><html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title>` +
  `<style><![CDATA[ div { width: 100px; height: 10px; } ]]></style></head><body><div></div></body></html>`;

test("a tag inside a prolog comment does not end the XHTML sniff", async ({ page }) => {
  await setContent(page, COMMENTED_XHTML);
  const r = await page.evaluate(() => ({
    styleText: document.querySelector("style")?.textContent ?? "",
    width: document.querySelector("div")?.getBoundingClientRect().width,
  }));
  expect(r.styleText).not.toContain("CDATA");
  expect(r.width).toBe(100);
});
