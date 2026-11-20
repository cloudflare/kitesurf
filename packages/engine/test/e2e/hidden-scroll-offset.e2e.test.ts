// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Page } from "@cloudflare/puppeteer";

import { expect, test } from "./harness";
import { setContent } from "./set-content";

// A hidden subtree has no boxes, so the scroller reports no scroll range. A
// scroll write must not clamp the offset it keeps to zero.
const HTML = `<div id="tab"><div id="s" style="overflow:auto;height:50px">
  <div style="height:500px"></div></div></div>`;

const SCROLLED_TO = 30;

async function waitTwoFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

const readScrollTop = (page: Page) => page.evaluate(() => document.getElementById("s")!.scrollTop);

/** Scrolls the hidden scroller with `scroll` and checks its offset survived. */
async function assertHiddenScrollKeepsOffset(
  page: Page,
  scroll: () => Promise<unknown>,
): Promise<void> {
  await setContent(page, HTML, { waitUntil: "domcontentloaded" });
  await page.evaluate((top) => {
    document.getElementById("s")!.scrollTop = top;
  }, SCROLLED_TO);
  await waitTwoFrames(page);
  expect(await readScrollTop(page)).toBe(SCROLLED_TO);

  await page.evaluate(() => {
    document.getElementById("tab")!.style.display = "none";
  });
  await waitTwoFrames(page);
  await scroll();
  await waitTwoFrames(page);
  await page.evaluate(() => {
    document.getElementById("tab")!.style.display = "";
  });
  await waitTwoFrames(page);

  expect(await readScrollTop(page)).toBe(SCROLLED_TO);
}

test("scrollTo on a scroller inside a hidden subtree keeps its offset", async ({ page }) => {
  await assertHiddenScrollKeepsOffset(page, () =>
    page.evaluate(() => document.getElementById("s")!.scrollTo({ left: 0 })),
  );
});

test("scrollBy on a scroller inside a hidden subtree keeps its offset", async ({ page }) => {
  await assertHiddenScrollKeepsOffset(page, () =>
    page.evaluate(() => document.getElementById("s")!.scrollBy(0, 10)),
  );
});
