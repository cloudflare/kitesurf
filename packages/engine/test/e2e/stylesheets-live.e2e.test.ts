// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("document.styleSheets is one live list that sees later sheets", async ({ page }) => {
  await setContent(page, "<style>p{}</style><p>live sheets</p>");

  const result = await page.evaluate(() => {
    const sheets = document.styleSheets;
    const before = sheets.length;
    const style = document.createElement("style");
    style.textContent = "b{}";
    document.head.appendChild(style);
    const afterInsert = sheets.length;
    const lastOwner = sheets[sheets.length - 1]?.ownerNode === style;
    style.remove();
    return {
      same: sheets === document.styleSheets,
      before,
      afterInsert,
      lastOwner,
      afterRemove: sheets.length,
      item: sheets.item(0) === sheets[0],
      spread: [...sheets].length,
    };
  });

  expect(result).toEqual({
    same: true,
    before: 1,
    afterInsert: 2,
    lastOwner: true,
    afterRemove: 1,
    item: true,
    spread: 1,
  });
});
