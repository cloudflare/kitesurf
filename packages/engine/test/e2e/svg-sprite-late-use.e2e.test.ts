// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

test("a <use> inserted after load still resolves its external sprite", async ({ page }) => {
  await page.goto("http://127.0.0.1:8787/__fixtures/sprite-icons.html", {
    waitUntil: "load",
    timeout: 30000,
  });
  // Let a few sweep passes run over an unchanged tree first.
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await page.evaluate(() => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.id = "late";
    use.setAttribute("href", "/__fixtures/icon-sprite.svg#dot");
    svg.appendChild(use);
    document.body.appendChild(svg);
  });
  await expect
    .poll(() => page.evaluate(() => document.getElementById("late")?.getAttribute("href")), {
      timeout: 5000,
    })
    .toBe("#dot");
});
