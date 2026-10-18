// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("eval and Function code update the document", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/dynamic-app.html", {
    waitUntil: "load",
    timeout: 15_000,
  });

  const output = await page.evaluate(() => ({
    eval: document.getElementById("a")?.textContent ?? null,
    renderer: document.getElementById("b")?.textContent ?? null,
  }));

  expect(output.eval, "eval() built content present").toBe("eval-total:42");
  expect(output.renderer, "new Function template output present").toBe("items:apple,banana,cherry");
});
