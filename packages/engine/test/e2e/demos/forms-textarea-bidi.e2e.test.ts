// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("forms-textarea-bidi", async ({ page }) => {
  const style = "font-size:32px;width:300px;height:80px;text-align:left";
  await page.goto(
    "data:text/html," +
      encodeURIComponent(`<!doctype html><html><body>
        <textarea id="ltr" dir="ltr" style="${style}"></textarea>
        <textarea id="rtl" dir="rtl" style="${style}"></textarea>
        <textarea id="auto" dir="auto" style="${style}"></textarea>
        <textarea id="ctl" dir="ltr" style="${style}"></textarea>
        <script>
          const oneLine = "!123@";
          const twoLines = "!123@\\n\\u200F!123@";
          document.getElementById("ltr").value = oneLine;
          document.getElementById("rtl").value = oneLine;
          document.getElementById("auto").value = twoLines;
          document.getElementById("ctl").value = twoLines;
        </script>
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
    "dir=rtl must force an RTL base direction (reordered paint)",
  ).not.toBe(0);

  expect(
    Buffer.compare(shots.auto, shots.ctl),
    "dir=auto must resolve first-strong per paragraph (plaintext)",
  ).not.toBe(0);
});
