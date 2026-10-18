// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("vertical-scroll-demo", async ({ page }) => {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>vertical-scroll</title>
<style>
  body { margin: 0; font-family: sans-serif; }
  section { height: 700px; padding: 24px; box-sizing: border-box; font-size: 32px; }
  #top { background: #f6d365; }
  #middle { background: #96e6a1; }
  #bottom { background: #84fab0; }
</style></head>
<body>
  <section id="top">top</section>
  <section id="middle">middle</section>
  <section id="bottom">bottom</section>
</body></html>`;

  await page.goto(`data:text/html,${encodeURIComponent(html)}`, { timeout: 15000 });

  const before = await page.evaluate(() => ({
    scrollY: window.scrollY,
    hit: document.elementFromPoint(20, 20)?.id || "",
  }));
  expect(before, "initial scroll state").toStrictEqual({ scrollY: 0, hit: "top" });

  const afterScrollTo = await page.evaluate(() => {
    window.scrollTo(0, 720);
    return {
      scrollY: window.scrollY,
      pageYOffset: window.pageYOffset,
      hit: document.elementFromPoint(20, 20)?.id || "",
    };
  });
  expect(afterScrollTo.scrollY, "scrollTo updates scrollY").toBeGreaterThanOrEqual(700);
  expect(afterScrollTo.pageYOffset, "pageYOffset === scrollY").toBe(afterScrollTo.scrollY);
  expect(afterScrollTo.hit, "scrollTo hit-test lands on middle").toBe("middle");

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.mouse.move(20, 20);
  await page.mouse.wheel({ deltaY: 760 });
  const afterWheel = await page.evaluate(() => ({
    scrollY: window.scrollY,
    hit: document.elementFromPoint(20, 20)?.id || "",
  }));
  expect(afterWheel.scrollY, "wheel scroll updates scrollY").toBeGreaterThanOrEqual(700);
  expect(afterWheel.hit, "wheel scroll hit-test lands on middle").toBe("middle");

  const wikiHtml = `<!doctype html>
<html><head><style>
  html, body { height: 100%; margin: 0; }
  body { overflow: visible; }
  #tall { height: 5000px; background: linear-gradient(#f6d365, #84fab0); }
</style></head><body><div id="tall">tall</div></body></html>`;
  await page.goto(`data:text/html,${encodeURIComponent(wikiHtml)}`, { timeout: 15000 });
  const wikiScroll = await page.evaluate(() => {
    window.scrollTo(0, 1500);
    return {
      scrollY: window.scrollY,
      bodyRectH: document.body.getBoundingClientRect().height,
      bodyScrollH: document.body.scrollHeight,
    };
  });
  expect(wikiScroll.bodyRectH, "body layout rect stays viewport-sized").toBeLessThan(
    wikiScroll.bodyScrollH,
  );
  expect(
    wikiScroll.scrollY,
    "scrollTo clears viewport-clamp on overflowing child",
  ).toBeGreaterThanOrEqual(1400);
});
