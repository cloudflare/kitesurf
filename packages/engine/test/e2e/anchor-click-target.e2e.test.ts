// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

// The link fills the top half of its wrapper. A click follows a link only from inside it; the
// engine once also followed one near the click, measuring every link under up to eight ancestors.
const MARKUP =
  '<div id="wrap" style="width:200px;height:80px;margin:0">' +
  '<a id="link" href="#target" style="display:block;width:200px;height:40px">link</a></div>' +
  '<p id="target">target</p>';

test("a click beside a link inside its wrapper does not follow the link", async ({ page }) => {
  await setContent(page, MARKUP);
  await page.evaluate(() => {
    const wrap = document.getElementById("wrap")!;
    wrap.addEventListener(
      "click",
      () => (wrap.dataset.clicks = String(Number(wrap.dataset.clicks ?? 0) + 1)),
    );
  });
  const box = await (await page.$("#wrap"))?.boundingBox();
  if (!box) throw new Error("#wrap has no layout box");

  await page.mouse.click(box.x + 100, box.y + 60);

  expect(await page.evaluate(() => document.getElementById("wrap")!.dataset.clicks)).toBe("1");
  expect(await page.evaluate(() => location.hash)).toBe("");
});

test("a click inside an SVG but off its link's shape does not follow the link", async ({
  page,
}) => {
  await setContent(
    page,
    '<svg id="pic" width="300" height="200" style="display:block"><a href="#target">' +
      '<rect width="100" height="100" fill="red"></rect></a></svg><p id="target">target</p>',
  );
  const box = await (await page.$("#pic"))?.boundingBox();
  if (!box) throw new Error("#pic has no layout box");

  await page.mouse.click(box.x + 250, box.y + 150);
  expect(await page.evaluate(() => location.hash)).toBe("");

  await page.mouse.click(box.x + 50, box.y + 50);
  await page.waitForFunction(() => location.hash === "#target", { timeout: 5_000 });
});

test("a click on the link follows it", async ({ page }) => {
  await setContent(page, MARKUP);
  const box = await (await page.$("#link"))?.boundingBox();
  if (!box) throw new Error("#link has no layout box");

  await page.mouse.click(box.x + 100, box.y + 20);
  await page.waitForFunction(() => location.hash === "#target", { timeout: 5_000 });

  expect(await page.evaluate(() => location.hash)).toBe("#target");
});

// A link that wraps spans the paragraph's full width, so the bounding rect's
// centre lands on the paragraph's own text. One quad per line fragment puts the
// click on the link's first line.
test("ElementHandle.click follows a link that wraps across two lines", async ({ page }) => {
  await setContent(
    page,
    '<p style="width:300px;font:16px monospace;margin:0">aaaaaaaaaaaaaaaaaaaa' +
      '<a id="l" href="#t">link link link link link link</a> bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb</p>' +
      '<p id="t">t</p>',
  );
  const handle = await page.$("#l");
  if (!handle) throw new Error("#l not found");
  await handle.click();
  await page.waitForFunction(() => location.hash === "#t", { timeout: 5_000 });
  expect(await page.evaluate(() => location.hash)).toBe("#t");
});
