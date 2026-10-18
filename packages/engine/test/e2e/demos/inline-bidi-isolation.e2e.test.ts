// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("inline-bidi-isolation", async ({ page }) => {
  const style = "font-size:32px;width:300px;text-align:left;margin:0";
  await page.goto(
    "data:text/html," +
      encodeURIComponent(`<!doctype html><html><body>
        <div id="wrapA" style="position:absolute;left:0;top:0">
          <div style="${style}"><span dir="rtl">&#x200F;</span>!123@</div>
        </div>
        <div id="wrapB" style="position:absolute;left:0;top:0;visibility:hidden">
          <div style="${style}">!123@</div>
        </div>
        <div id="wrapC" style="position:absolute;left:0;top:0;visibility:hidden">
          <div style="${style}"><span>&#x200F;</span>!123@</div>
        </div>
        <div id="bdo" style="position:absolute;left:0;top:100px">
          <div style="${style}"><bdo dir="rtl">abc</bdo></div>
        </div>
        <div id="plain" style="position:absolute;left:0;top:200px">
          <div style="${style}">abc</div>
        </div>
      </body></html>`),
  );

  const show = (id: string) =>
    page.evaluate((sel) => {
      for (const w of ["wrapA", "wrapB", "wrapC"]) {
        (document.getElementById(w) as any).style.visibility = w === sel ? "visible" : "hidden";
      }
    }, id);

  const shotIsolated = (await page.screenshot({ type: "png" })) as Buffer;
  await show("wrapB");
  const shotBare = (await page.screenshot({ type: "png" })) as Buffer;
  await show("wrapC");
  const shotLeaky = (await page.screenshot({ type: "png" })) as Buffer;

  expect(
    Buffer.compare(shotIsolated, shotBare),
    "dir-span content must be bidi-isolated from sibling text",
  ).toBe(0);

  expect(
    Buffer.compare(shotLeaky, shotBare),
    "plain-span RLM must still leak (proves the equality is earned)",
  ).not.toBe(0);

  const crop = async (id: string) => {
    const box = await page.evaluate((sel) => {
      const r = (document.getElementById(sel) as any).getBoundingClientRect();
      return { x: r.x, y: r.y, width: 300, height: r.height };
    }, id);
    return (await page.screenshot({ type: "png", clip: box })) as Buffer;
  };
  const bdoShot = await crop("bdo");
  const plainShot = await crop("plain");
  expect(Buffer.compare(bdoShot, plainShot), "bdo dir=rtl must force-reverse its content").not.toBe(
    0,
  );
});
