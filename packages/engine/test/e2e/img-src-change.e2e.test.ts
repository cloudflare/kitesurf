// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

test("a stale 404 does not swallow the next src's load event", async ({ page }) => {
  await page.goto("http://127.0.0.1:8787/__fixtures/xhr-boot.html", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  const got = await page.evaluate(`new Promise((resolve) => {
    const img = document.createElement("img");
    document.body.appendChild(img);
    const events = [];
    const done = () => resolve({ events, complete: img.complete, width: img.naturalWidth });
    img.onload = () => { events.push("load"); done(); };
    img.onerror = () => { events.push("error"); };
    // The 404 answers at once; the image behind it answers 300 ms later.
    img.src = "/__fixtures/no-such-image.png";
    img.src = "/__fixtures/slow-headers-red.png?ms=300";
    setTimeout(done, 5000);
  })`);
  expect(got).toMatchObject({ events: ["load"], complete: true });
  expect((got as { width: number }).width).toBeGreaterThan(0);
});
