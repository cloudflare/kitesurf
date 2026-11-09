// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

// A hidden subtree has no boxes, so the scroller reports no scroll range. A
// scroll write must not clamp the offset it keeps to zero.
const HTML = `<div id="tab"><div id="s" style="overflow:auto;height:50px">
  <div style="height:500px"></div></div></div>`;

async function frames(page: { evaluate: (fn: () => Promise<void>) => Promise<unknown> }) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

test("scrollTo on a scroller inside a hidden subtree keeps its offset", async ({ page }) => {
  await setContent(page, HTML, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    const scroller = document.getElementById("s")!;
    scroller.scrollTop = 30;
  });
  await frames(page);
  expect(await page.evaluate(() => document.getElementById("s")!.scrollTop)).toBe(30);

  await page.evaluate(() => {
    document.getElementById("tab")!.style.display = "none";
  });
  await frames(page);
  await page.evaluate(() => document.getElementById("s")!.scrollTo({ left: 0 }));
  await frames(page);
  await page.evaluate(() => {
    document.getElementById("tab")!.style.display = "";
  });
  await frames(page);

  expect(await page.evaluate(() => document.getElementById("s")!.scrollTop)).toBe(30);
});

test("scrollBy on a scroller inside a hidden subtree keeps its offset", async ({ page }) => {
  await setContent(page, HTML, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    const scroller = document.getElementById("s")!;
    scroller.scrollTop = 30;
  });
  await frames(page);

  await page.evaluate(() => {
    document.getElementById("tab")!.style.display = "none";
  });
  await frames(page);
  await page.evaluate(() => document.getElementById("s")!.scrollBy(0, 10));
  await frames(page);
  await page.evaluate(() => {
    document.getElementById("tab")!.style.display = "";
  });
  await frames(page);

  expect(await page.evaluate(() => document.getElementById("s")!.scrollTop)).toBe(30);
});
