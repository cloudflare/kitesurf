// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const TEXT = "aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll";

test("a content-sized flex row shrinks to fit-content in a narrow box", async ({ page }) => {
  await setContent(
    page,
    `<style>
      body { margin: 0; font: 16px sans-serif; }
      .box { width: 157px; }
      .column { display: flex; flex-direction: column; align-items: flex-start; }
      .fill { width: 100%; }
      input { padding: 0; border: 0; font: inherit; }
    </style>
    <div class="box">
      <div id="text" style="display: inline-flex"><div>${TEXT}</div></div>
    </div>
    <div class="box">
      <div id="filled-text" style="display: inline-flex"><div class="fill">${TEXT}</div></div>
    </div>
    <div class="box">
      <div id="filled-input" style="display: inline-flex"><input class="fill"></div>
    </div>
    <div class="box column">
      <div id="flex-item" style="display: flex"><div class="fill">${TEXT}</div></div>
    </div>
    <div class="box">
      <div id="form-control" style="display: inline-flex; flex-direction: column; min-width: 0">
        <div style="display: flex">
          <input class="fill" style="min-width: 0; box-sizing: content-box">
        </div>
      </div>
    </div>
    <div class="box">
      <div id="fixed" style="display: inline-flex"><div style="width: 300px">x</div></div>
    </div>
    <div class="box">
      <div id="clipped" style="display: inline-flex">
        <div style="overflow: hidden">${TEXT}</div>
      </div>
    </div>
    <div class="box">
      <div id="based" style="display: inline-flex"><div style="flex: 0 1 300px">x</div></div>
    </div>
    <div id="line" style="display: inline-flex"><div>x</div></div>`,
  );

  await expect(
    page.evaluate(() =>
      Object.fromEntries(
        [
          "text",
          "filled-text",
          "filled-input",
          "flex-item",
          "form-control",
          "fixed",
          "clipped",
        ].map((id) => [id, document.getElementById(id)!.getBoundingClientRect().width]),
      ),
    ),
  ).resolves.toEqual({
    text: 157,
    "filled-text": 157,
    "filled-input": 157,
    "flex-item": 157,
    "form-control": 157,
    fixed: 300,
    clipped: 157,
  });

  // The narrowed rows lay their text out again, onto more lines than the one it had: a row
  // that only reported a smaller width would leave the text running out of it.
  const lines = await page.evaluate(() => {
    const height = (id: string): number =>
      document.getElementById(id)!.getBoundingClientRect().height;
    const line = height("line");
    return ["text", "filled-text", "flex-item"].map((id) => Math.round(height(id) / line));
  });
  expect(lines).toEqual([3, 3, 3]);

  // A flex basis wider than the item's content does not stretch the row to the box: the row
  // is as wide as the same item with no basis.
  const based = await page.evaluate(() => {
    const width = (id: string): number =>
      document.getElementById(id)!.getBoundingClientRect().width;
    return width("based") === width("line");
  });
  expect(based).toBe(true);
}, 120_000);
