// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("iframe-content-document-demo", async ({ page }) => {
  const BASE = process.env.KITESURF_FIXTURE_BASE ?? "http://127.0.0.1:8787";

  await page.goto(`${BASE}/__fixtures/iframe-host.html`, { timeout: 15000 });

  const probe = await page.evaluate(() => {
    const f = document.querySelector('iframe[name="child-a"]') as HTMLIFrameElement;
    const b = document.querySelector('iframe[name="child-b"]') as HTMLIFrameElement;
    const cd = f && f.contentDocument;
    const h1 = cd ? cd.querySelector("h1") : null;
    return {
      sameOrigin: {
        hasContentDoc: !!cd,
        hasContentWin: !!(f && f.contentWindow),
        tagName: f && f.tagName,
      },
      docUrl: cd && cd.URL,
      heading: h1 && { tag: h1.tagName, id: h1.id, text: h1.textContent },
      bodyText: cd && cd.body && cd.body.textContent.trim(),
      blank: {
        hasContentDoc: !!(b && b.contentDocument),
        bodyChildren:
          b && b.contentDocument && b.contentDocument.body
            ? b.contentDocument.body.children.length
            : -1,
      },
      winDocMatch: !!(f && f.contentWindow && f.contentWindow.document === cd),
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
