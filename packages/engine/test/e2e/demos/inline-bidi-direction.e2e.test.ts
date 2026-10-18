// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("inline-bidi-direction", async ({ page }) => {
  const style = "font-size:32px;width:300px;text-align:left;margin:0";
  await page.goto(
    "data:text/html," +
      encodeURIComponent(`<!doctype html><html><body>
        <div id="ltr" dir="ltr" style="${style}">!123@</div>
        <div id="rtl" dir="rtl" style="${style}">!123@</div>
        <pre id="auto" dir="auto" style="${style}">!123@
&#x200F;!123@</pre>
        <pre id="ctl" dir="ltr" style="${style}">!123@
&#x200F;!123@</pre>
        <div dir="rtl" id="wrapA" style="position:absolute;left:0;top:300px">
          <div id="scan" dir="auto" style="${style}"><span dir="rtl">&#x200F;</span>!123@</div>
        </div>
        <div dir="rtl" id="wrapB" style="position:absolute;left:0;top:300px;visibility:hidden">
          <div id="scanctl" dir="ltr" style="${style}"><span dir="rtl">&#x200F;</span>!123@</div>
        </div>
      </body></html>`),
  );

  const shots: Record<string, Buffer> = {};
  for (const id of ["ltr", "rtl", "auto", "ctl"]) {
    const box = await page.evaluate((sel) => {
      const r = (document.getElementById(sel) as any).getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }, id);
    shots[id] = (await page.screenshot({ type: "png", clip: box })) as Buffer;
  }

  expect(
    Buffer.compare(shots.ltr, shots.rtl),
    "block dir=rtl must force an RTL base direction",
  ).not.toBe(0);

  expect(
    Buffer.compare(shots.auto, shots.ctl),
    "pre dir=auto must resolve first-strong per paragraph",
  ).not.toBe(0);

  const shotScan = (await page.screenshot({ type: "png" })) as Buffer;
  await page.evaluate(() => {
    (document.getElementById("wrapA") as any).style.visibility = "hidden";
    (document.getElementById("wrapB") as any).style.visibility = "visible";
  });
  const shotCtl = (await page.screenshot({ type: "png" })) as Buffer;
  expect(
    Buffer.compare(shotScan, shotCtl),
    "dir=auto scan must exclude dir-attributed descendants",
  ).toBe(0);

  await page.evaluate(() => {
    const a = document.getElementById("wrapA") as any;
    a.style.visibility = "visible";
    (document.getElementById("wrapB") as any).style.visibility = "hidden";
    (document.getElementById("scan") as any).innerHTML = "\u200F!123@";
  });
  const shotRtl = (await page.screenshot({ type: "png" })) as Buffer;
  expect(
    Buffer.compare(shotScan, shotRtl),
    "a scannable RLM must flip dir=auto to an RTL base",
  ).not.toBe(0);
});
