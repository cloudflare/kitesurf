// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { setContent } from "../set-content";

test("evaluates values and reads the active document", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html><html><head><title>Example Domain</title></head><body>
      <h1>Example Domain</h1>
      <a href="#local">More information</a>
    </body></html>`,
  );

  const sum = await page.evaluate(() => 1 + 1);
  expect(sum, "1 + 1").toBe(2);

  const uppercase = await page.evaluate(() => "hello".toUpperCase());
  expect(uppercase, "uppercase string result").toBe("HELLO");

  const product = await page.evaluate((x, y) => x * y, 6, 7);
  expect(product, "parameterized multiplication").toBe(42);

  const asyncResult = await page.evaluate(async () => {
    await Promise.resolve();
    return { ok: true };
  });
  expect(asyncResult.ok, "async page evaluation succeeds").toBeTruthy();

  const title = await page.evaluate(() => document.title);
  expect(title, "document.title").toBe("Example Domain");

  const heading = await page.evaluate(() => document.querySelector("h1")!.outerHTML);
  expect(heading, "h1 outerHTML").toMatch(/^<h1.*>.*<\/h1>$/);

  const linkCount = await page.evaluate(() => document.querySelectorAll("a").length);
  expect(linkCount >= 1, "document contains at least one link").toBe(true);
});
