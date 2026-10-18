// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("forms-selection-paint-demo", async ({ page }) => {
  await page.goto(
    "data:text/html," +
      encodeURIComponent(`<!doctype html><html><body style="margin:0">
        <input id="i" type="text" value="select this text"
               style="font-size:28px;width:400px;display:block;margin:30px">
      </body></html>`),
  );

  await page.click("#i");
  const focused = await page.screenshot({ type: "png" });

  await page.evaluate(() => {
    (document.getElementById("i") as any).select();
  });
  const selected = await page.screenshot({ type: "png" });
  expect(
    Buffer.compare(focused as Buffer, selected as Buffer),
    "select() must paint the selection highlight",
  ).not.toBe(0);

  await page.evaluate(() => {
    (document.getElementById("i") as any).setSelectionRange(3, 3);
  });
  const collapsed = await page.screenshot({ type: "png" });
  expect(
    Buffer.compare(selected as Buffer, collapsed as Buffer),
    "collapsing the selection must clear the highlight",
  ).not.toBe(0);

  const state = await page.evaluate(() => {
    const el = document.getElementById("i") as any;
    return { start: el.selectionStart, end: el.selectionEnd };
  });
  expect(state).toEqual({ start: 3, end: 3 });
});
