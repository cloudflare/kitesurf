// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("a transition on an innerHTML-built node in a reused slot finishes", async ({ page }) => {
  await setContent(
    page,
    `<style>span { transition: opacity 0.2s } p span { opacity: 0 }</style>
    <p>abc</p><p>xyz</p>
    <script>
      for (const p of document.querySelectorAll("p"))
        p.innerHTML = p.textContent.replace(/./g, "<span>$&</span>");
    </script>`,
  );
  await page.evaluate(() => {
    for (const s of document.querySelectorAll("span")) s.style.opacity = "1";
  });

  const opacities = () =>
    page.evaluate(() =>
      [...document.querySelectorAll("span")].map((s) => getComputedStyle(s).opacity),
    );
  let last: string[] = [];
  for (let i = 0; i < 20; i++) {
    last = await opacities();
    if (last.every((o) => o === "1")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(last).toEqual(["1", "1", "1", "1", "1", "1"]);
});
