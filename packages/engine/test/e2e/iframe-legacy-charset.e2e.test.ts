// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

test("a same-origin euc-kr iframe decodes per its Content-Type charset", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/iframe-euckr-host.html", {
    waitUntil: "load",
    timeout: 30000,
  });

  const text = await page.evaluate(() => {
    const f = document.querySelector('iframe[name="euckr"]') as HTMLIFrameElement;
    return f.contentDocument?.getElementById("k")?.textContent ?? null;
  });
  expect(text).toBe("한국어");
});
