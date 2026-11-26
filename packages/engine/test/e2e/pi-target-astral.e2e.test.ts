// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

// XML's NameStartChar includes U+10000 to U+EFFFF; U+F0000 and up stay invalid.
const MARKUP = `<script>
  const targets = ["\\u{10000}", "\\u{1F600}", "\\u{EFFFF}", "a\\u{1F600}", "\\u{F0000}", "\\u{10FFFF}"];
  window.__out = targets.map((target) => {
    try {
      return document.createProcessingInstruction(target, "x").target === target;
    } catch (e) {
      return e.name;
    }
  });
</script>`;

test("createProcessingInstruction accepts targets outside the BMP", async ({ page }) => {
  await setContent(page, MARKUP);
  const r = await page.evaluate(() => (window as typeof window & { __out: unknown[] }).__out);
  expect(r).toEqual([true, true, true, true, "InvalidCharacterError", "InvalidCharacterError"]);
});
