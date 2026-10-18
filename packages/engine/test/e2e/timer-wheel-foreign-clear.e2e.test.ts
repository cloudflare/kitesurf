// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("clearTimeout of never-issued ids does not freeze the timer wheel", async ({ page }) => {
  await setContent(
    page,
    `<div id="n">0</div><script>
      // Stray clears across the whole small-integer range the shim
      // will mint its next wakes from.
      for (let i = 1; i < 500; i++) { clearTimeout(i); clearInterval(i); }
      let n = 0;
      const el = document.getElementById("n");
      setInterval(() => { n++; el.textContent = String(n); }, 20);
      setTimeout(() => { el.setAttribute("data-timeout", "fired"); }, 50);
    <\/script>`,
  );
  await page.waitForFunction(
    () =>
      Number(document.getElementById("n")!.textContent) >= 5 &&
      document.getElementById("n")!.getAttribute("data-timeout") === "fired",
    { timeout: 10_000 },
  );
  const before = await page.evaluate(() => {
    for (let i = 1; i < 5000; i++) clearTimeout(i);
    return Number(document.getElementById("n")!.textContent);
  });
  await page.waitForFunction(
    (b: number) => Number(document.getElementById("n")!.textContent) >= b + 5,
    { timeout: 10_000 },
    before,
  );
  expect(true).toBe(true);
});
