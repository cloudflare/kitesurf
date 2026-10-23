// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { setContent } from "../set-content";

function isNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

function startsWithHeading(value: unknown): boolean {
  return typeof value === "string" && value.startsWith("<h1");
}

function hasParagraphTexts(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

test("evaluates DOM state and accepts title writes", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html><html><head><title>Local Document</title></head><body>
      <h1>DOM evaluation</h1>
      <p>The document exposes parsed text for collection and mapping checks.</p>
      <p>Additional content ensures the body exceeds the expected minimum length.</p>
      <a href="/local-target">local link</a>
    </body></html>`,
  );

  const values = await page.evaluate(() => {
    const title = document.title;
    const heading = document.querySelector("h1");
    let titleWriteResult: string;
    try {
      document.title = "changed";
      titleWriteResult = "returned";
    } catch (error) {
      titleWriteResult = String(error);
    }
    return {
      title,
      rootTagName: document.documentElement.tagName,
      headingText: heading?.textContent,
      headingOuterHTML: heading?.outerHTML,
      linkCount: document.querySelectorAll("a").length,
      paragraphTexts: Array.from(document.querySelectorAll("p")).map((p) =>
        p.textContent!.trim().slice(0, 40),
      ),
      href: document.querySelector("a")?.getAttribute("href"),
      bodyHtmlLong: document.body.innerHTML.length > 100,
      titleWriteResult,
    };
  });

  expect(isNonEmptyString(values.title), "document.title is non-empty").toBe(true);
  expect(values.rootTagName, "document element tag name").toBe("HTML");
  expect(isNonEmptyString(values.headingText), "heading text is non-empty").toBe(true);
  expect(startsWithHeading(values.headingOuterHTML), "heading outerHTML starts with h1").toBe(true);
  expect(values.linkCount >= 1, "document contains a link").toBe(true);
  expect(hasParagraphTexts(values.paragraphTexts), "paragraph mapping is non-empty").toBe(true);
  expect(isNonEmptyString(values.href), "link href is non-empty").toBe(true);
  expect(values.bodyHtmlLong, "body HTML exceeds 100 characters").toBe(true);
  expect(values.titleWriteResult, "title setter accepts the write").toBe("returned");
});
