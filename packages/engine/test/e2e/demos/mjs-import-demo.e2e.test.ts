// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("mjs-import-demo", async ({ page }) => {
  await page.goto("http://127.0.0.1:8787/__fixtures/mjs-import/index.html", {
    waitUntil: "domcontentloaded",
    timeout: 15000,
  });
  await page
    .waitForFunction(
      () =>
        document.getElementById("out")?.textContent === "loaded:mjs-import-ok" &&
        globalThis.__mjsImportChildRan === true,
      { timeout: 15_000 },
    )
    .catch(() => {});
  const info = await page.evaluate(() => {
    const el = document.getElementById("out");
    return {
      text: el ? el.textContent : null,
      childRan: globalThis.__mjsImportChildRan === true,
    };
  });
  expect(info.text, "inline module imported the .mjs child and updated the DOM").toBe(
    "loaded:mjs-import-ok",
  );
  expect(info.childRan, "the imported .mjs module's top-level body executed").toBe(true);
});
