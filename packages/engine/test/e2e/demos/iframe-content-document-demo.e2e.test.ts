// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("iframe-content-document-demo", async ({ page }) => {
  const BASE = process.env.KITESURF_FIXTURE_BASE ?? "http://127.0.0.1:8787";

  await page.goto(`${BASE}/__fixtures/iframe-host.html`, { timeout: 15000 });

  const probe = await page.evaluate(() => {
    const f = document.querySelector('iframe[name="child-a"]') as HTMLIFrameElement | null;
    const b = document.querySelector('iframe[name="child-b"]') as HTMLIFrameElement | null;

    function getContentDocument(frame: HTMLIFrameElement | null) {
      return frame && frame.contentDocument;
    }

    function inspectFrame(frame: HTMLIFrameElement | null) {
      const contentDocument = getContentDocument(frame);
      return {
        contentDocument,
        hasContentDoc: !!contentDocument,
        hasContentWin: !!(frame && frame.contentWindow),
        tagName: frame && frame.tagName,
      };
    }

    function describeHeading(contentDocument: Document | null) {
      const heading = contentDocument && contentDocument.querySelector("h1");
      return heading && { tag: heading.tagName, id: heading.id, text: heading.textContent };
    }

    function readBodyText(contentDocument: Document | null) {
      const body = contentDocument && contentDocument.body;
      return body && body.textContent.trim();
    }

    function inspectBlankFrame(frame: HTMLIFrameElement | null) {
      const contentDocument = getContentDocument(frame);
      const body = contentDocument && contentDocument.body;
      return {
        hasContentDoc: !!(frame && frame.contentDocument),
        bodyChildren: body ? body.children.length : -1,
      };
    }

    function windowsShareDocument(
      frame: HTMLIFrameElement | null,
      contentDocument: Document | null,
    ) {
      return !!(frame && frame.contentWindow && frame.contentWindow.document === contentDocument);
    }

    const sameOrigin = inspectFrame(f);
    const contentDocument = sameOrigin.contentDocument;
    return {
      sameOrigin: {
        hasContentDoc: sameOrigin.hasContentDoc,
        hasContentWin: sameOrigin.hasContentWin,
        tagName: sameOrigin.tagName,
      },
      docUrl: contentDocument && contentDocument.URL,
      heading: describeHeading(contentDocument),
      bodyText: readBodyText(contentDocument),
      blank: inspectBlankFrame(b),
      winDocMatch: windowsShareDocument(f, contentDocument),
    };
  });

  const sameOrigin = probe.sameOrigin;
  console.log("[iframe-cd] same-origin frame =", sameOrigin);
  expect(sameOrigin.tagName).toBe("IFRAME");
  expect(sameOrigin.hasContentDoc, "contentDocument should be non-null").toBe(true);
  expect(sameOrigin.hasContentWin, "contentWindow should be non-null").toBe(true);

  const docUrl = probe.docUrl;
  console.log("[iframe-cd] contentDocument.URL =", docUrl);
  expect(docUrl, "contentDocument.URL matches src").toMatch(/iframe-child\.html/);

  const heading = probe.heading;
  console.log("[iframe-cd] child h1 =", heading);
  expect(heading, "querySelector returned an element").toBeTruthy();
  expect(heading.tag).toBe("H1");

  const bodyText = probe.bodyText;
  console.log("[iframe-cd] body text =", JSON.stringify(bodyText));
  expect(bodyText, "body text visible").toMatch(/child body/);

  const blank = probe.blank;
  console.log("[iframe-cd] about:blank frame =", blank);
  expect(blank.hasContentDoc, "about:blank contentDocument non-null").toBe(true);
  expect(blank.bodyChildren, "about:blank body has no children").toBe(0);

  const winDocMatch = probe.winDocMatch;
  expect(winDocMatch, "contentWindow.document === contentDocument").toBe(true);
});
