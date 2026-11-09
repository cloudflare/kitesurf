// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

const PAGE = "https://ks.invalid/__fixtures/echo-headers.html";
const ECHO = "https://ks.invalid/__fixtures/echo-headers.json";

test("page fetch cannot set headers the browser owns", async ({ page }) => {
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  const raw = (await page.evaluate(`
    fetch(${JSON.stringify(ECHO)}, {
      headers: {
        Origin: "https://victim.example",
        Referer: "https://victim.example/account",
        Cookie: "sid=forged",
        "Sec-Fetch-Site": "same-origin",
        "X-Custom": "kept",
      },
    }).then((r) => r.text())
  `)) as string;
  const seen = JSON.parse(raw) as Record<string, string>;
  expect(seen.origin).not.toBe("https://victim.example");
  expect(seen.referer).not.toContain("victim.example");
  expect(seen.cookie).toBeUndefined();
  expect(seen["sec-fetch-site"]).toBeUndefined();
  expect(seen["x-custom"]).toBe("kept");
});
