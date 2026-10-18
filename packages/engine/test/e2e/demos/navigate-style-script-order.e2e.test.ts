// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("css-blocks-scripts", async ({ page }) => {
  await page.goto("http://127.0.0.1:8787/__fixtures/css-block.html", {
    waitUntil: "load",
  });
  const measured = await page.evaluate(() => (window as any).measuredAtScriptTime);
  expect(measured).toBe(111);
});

test("viewport-seeded-before-scripts", async ({ page }) => {
  await page.setViewport({ width: 1777, height: 900 });
  await page.goto("http://127.0.0.1:8787/__fixtures/css-block.html", {
    waitUntil: "load",
  });
  const w = await page.evaluate(() => (window as any).innerWidthAtScriptTime);
  expect(w).toBe(1777);
});

test("nested-inline-pseudo-elements", async ({ page }) => {
  const doc = (content: string) =>
    "data:text/html," +
    encodeURIComponent(`<!doctype html><html><head><style>
      .icon:before { content: ${content}; font-size: 40px; color: red; }
    </style></head><body>
      <div><span><i class="icon"></i></span>tail</div>
    </body></html>`);

  await page.goto(doc('"XY"'));
  const withContent = await page.screenshot({ type: "png" });
  await page.goto(doc('""'));
  const blank = await page.screenshot({ type: "png" });
  expect(
    Buffer.compare(withContent as Buffer, blank as Buffer),
    "::before on an inline nested in an inline must paint",
  ).not.toBe(0);
});
