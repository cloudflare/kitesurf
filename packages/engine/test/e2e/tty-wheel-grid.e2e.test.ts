// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

test("tty wheel input scrolls by whole cells", async ({ page }) => {
  const html = `<!doctype html><html><body style="margin:0;width:2000px;height:3000px">
    <div id="scroller" style="width:200px;height:200px;overflow:scroll">
      <div style="width:600px;height:600px"></div>
    </div>
  </body></html>`;
  await page.goto(`data:text/html,${encodeURIComponent(html)}?ks_tty_css=1&ks_tty_cell=8x17`, {
    waitUntil: "load",
  });

  const rect = await page.evaluate(() => {
    const value = document.getElementById("scroller")!.getBoundingClientRect();
    return { left: value.left, top: value.top };
  });
  await page.evaluate(() => {
    const scroller = document.getElementById("scroller")!;
    scroller.scrollLeft = 3;
    scroller.scrollTop = 5;
  });
  await page.mouse.move(rect.left + 50, rect.top + 50);
  await page.mouse.wheel({ deltaX: 16, deltaY: 34 });

  const nested = await page.evaluate(() => {
    const scroller = document.getElementById("scroller")!;
    return { left: scroller.scrollLeft, top: scroller.scrollTop };
  });
  expect(nested.left - 3).toBe(16);
  expect(nested.top - 5).toBe(34);

  const nearEnd = await page.evaluate(() => {
    const scroller = document.getElementById("scroller")!;
    scroller.scrollTop = scroller.scrollHeight;
    scroller.scrollTop -= 10;
    window.scrollTo(0, 0);
    return scroller.scrollTop;
  });
  await page.mouse.wheel({ deltaY: 17 });
  expect(await page.evaluate(() => document.getElementById("scroller")!.scrollTop)).toBe(nearEnd);
  expect(await page.evaluate(() => window.scrollY)).toBe(17);

  await page.mouse.move(rect.left + 500, rect.top + 500);
  await page.mouse.wheel({ deltaX: 16 });
  expect(await page.evaluate(() => window.scrollX)).toBe(16);
});
