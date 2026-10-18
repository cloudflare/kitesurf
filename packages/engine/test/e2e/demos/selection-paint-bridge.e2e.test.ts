// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("selection-paint-bridge", async ({ page }) => {
  await page.goto(
    "data:text/html," +
      encodeURIComponent(`<!doctype html><body style="font-size:24px">
        <p id="p1">The quick brown fox jumps.</p>
        <p id="p2">Second paragraph <b>with bold</b> text.</p>
      </body>`),
  );

  const base = (await page.screenshot({ type: "png" })) as Buffer;

  await page.evaluate(() => {
    const sel = getSelection()!;
    sel.setBaseAndExtent(
      document.getElementById("p1")!.firstChild!,
      4,
      document.getElementById("p2")!.querySelector("b")!.firstChild!,
      6,
    );
  });
  const highlighted = (await page.screenshot({ type: "png" })) as Buffer;
  expect(Buffer.compare(base, highlighted), "script selection must paint a highlight").not.toBe(0);

  await page.evaluate(() => {
    getSelection()!.collapse(document.getElementById("p1")!.firstChild!, 2);
  });
  const collapsed = (await page.screenshot({ type: "png" })) as Buffer;
  expect(Buffer.compare(base, collapsed), "collapsed selection paints nothing").toBe(0);

  await page.evaluate(() => {
    getSelection()!.selectAllChildren(document.getElementById("p2")!);
  });
  const selectAll = (await page.screenshot({ type: "png" })) as Buffer;
  expect(Buffer.compare(base, selectAll), "selectAllChildren must paint a highlight").not.toBe(0);

  await page.evaluate(() => getSelection()!.removeAllRanges());
  const cleared = (await page.screenshot({ type: "png" })) as Buffer;
  expect(
    Buffer.compare(base, cleared),
    "removeAllRanges must restore the unhighlighted paint",
  ).toBe(0);

  await page.evaluate(() => {
    const sel = getSelection()!;
    sel.setBaseAndExtent(document.getElementById("p2")!, 1, document.getElementById("p1")!, 0);
  });
  const backward = (await page.screenshot({ type: "png" })) as Buffer;
  await page.evaluate(() => {
    const sel = getSelection()!;
    sel.setBaseAndExtent(document.getElementById("p1")!, 0, document.getElementById("p2")!, 1);
  });
  const forward = (await page.screenshot({ type: "png" })) as Buffer;
  expect(
    Buffer.compare(backward, forward),
    "backward element-boundary selection paints like its forward twin",
  ).toBe(0);
  expect(
    Buffer.compare(forward, base),
    "sanity: the twin selections actually painted something",
  ).not.toBe(0);

  await page.evaluate(() => {
    const p1 = document.getElementById("p1")!;
    getSelection()!.getRangeAt(0).setEnd(p1.firstChild!, 8);
  });
  const shrunk = (await page.screenshot({ type: "png" })) as Buffer;
  expect(
    Buffer.compare(shrunk, forward),
    "live Range mutation must repaint the highlight",
  ).not.toBe(0);

  await page.evaluate(() => getSelection()!.removeAllRanges());
  const cleared2 = (await page.screenshot({ type: "png" })) as Buffer;
  expect(Buffer.compare(base, cleared2), "clear after live mutation restores the base paint").toBe(
    0,
  );
});
