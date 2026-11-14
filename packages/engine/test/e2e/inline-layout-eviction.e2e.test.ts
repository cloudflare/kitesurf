// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

// Text far from the viewport drops its shaped layout and rebuilds it when read. The
// paragraphs are identical, so a far one, rebuilt, must match one in the first viewport,
// which the first layout keeps shaped and nothing has evicted yet.
const paragraph =
  "shaped words that wrap across lines ".repeat(6) + `<span>span</span> ${"more text ".repeat(8)}`;
const paragraphs = Array.from({ length: 400 }, (_, i) => `<p id="p${i}">${paragraph}</p>`).join("");

const BODY_RULE = "margin: 8px; font: 16px/1.25 serif;";

const content = (bodyRule: string) => `<style>body { ${bodyRule} }</style>${paragraphs}`;

// Line and span boxes as offsets from the paragraph's own top.
const geometry = (id: string) => `(() => {
  const p = document.getElementById("${id}");
  const top = p.getBoundingClientRect().top;
  const range = document.createRange();
  range.selectNodeContents(p.firstChild);
  const boxes = [...range.getClientRects(), p.querySelector("span").getClientRects()[0]];
  return boxes.flatMap((r) => [r.left, r.top - top, r.width, r.height]);
})()`;

// f32 positions 40,000px down the page are only good to about 0.004px.
function expectSameGeometry(actual: number[], expected: number[]) {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, i) => expect(actual[i]).toBeCloseTo(value, 1));
}

const scrollToParagraph = (id: string) =>
  `window.scrollTo(0, document.getElementById("${id}").getBoundingClientRect().top + scrollY)`;

test("text rebuilt after eviction matches text that was never evicted", async ({ page }) => {
  await setContent(page, content(`${BODY_RULE} width: 640px;`));
  const neverEvicted = await page.evaluate<[], () => number[]>(geometry("p1"));
  expect(neverEvicted.length, "p1 reports its line and span boxes").toBeGreaterThan(4);
  expect(await page.evaluate("document.documentElement.scrollHeight")).toBeGreaterThan(20_000);
  expectSameGeometry(await page.evaluate<[], () => number[]>(geometry("p200")), neverEvicted);
  expectSameGeometry(await page.evaluate<[], () => number[]>(geometry("p399")), neverEvicted);

  const beforeScroll = await page.screenshot({ encoding: "base64" });
  await page.evaluate(scrollToParagraph("p1"));
  const paintOfP1 = await page.screenshot({ encoding: "base64" });
  expect(paintOfP1, "screenshots show the text").not.toBe(beforeScroll);
  await page.evaluate(scrollToParagraph("p380"));
  expect(await page.screenshot({ encoding: "base64" })).toBe(paintOfP1);

  // Stability: p1 was evicted while the viewport was at the bottom.
  await page.evaluate(scrollToParagraph("p1"));
  expect(await page.screenshot({ encoding: "base64" })).toBe(paintOfP1);
  expect(await page.evaluate(geometry("p1"))).toEqual(neverEvicted);
});

// A width change sizes evicted paragraphs without their shaped text; reading one later
// must rebuild it with the lines of the new width.
test("text evicted across a width change matches text that was never evicted", async ({ page }) => {
  await page.setViewport({ width: 800, height: 600 });
  await setContent(page, content(BODY_RULE));
  const wide = await page.evaluate<[], () => number[]>(geometry("p1"));
  await page.setViewport({ width: 570, height: 600 });
  const neverEvicted = await page.evaluate<[], () => number[]>(geometry("p1"));
  expect(neverEvicted, "the narrower viewport re-breaks the lines").not.toEqual(wide);
  expectSameGeometry(await page.evaluate<[], () => number[]>(geometry("p399")), neverEvicted);

  await page.evaluate(scrollToParagraph("p1"));
  const paintOfP1 = await page.screenshot({ encoding: "base64" });
  await page.evaluate(scrollToParagraph("p300"));
  expect(await page.screenshot({ encoding: "base64" })).toBe(paintOfP1);
});
