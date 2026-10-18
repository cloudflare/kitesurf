// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("forms-value-repaint-demo", async ({ page }) => {
  await page.goto(
    "data:text/html," +
      encodeURIComponent(`<!doctype html><html><body>
        <input id="i" type="text" value="aa" style="font-size:32px;width:400px">
        <textarea id="t" style="font-size:32px;width:400px;height:100px">bb</textarea>
      </body></html>`),
  );

  const before = await page.screenshot({ type: "png" });

  const attrs = await page.evaluate(() => {
    const i = document.getElementById("i") as any;
    const t = document.getElementById("t") as any;
    i.value = "WWWWWWWWWW";
    t.value = "MMMMMMMMMM";
    return {
      inputAttr: i.getAttribute("value"),
      inputValue: i.value,
      textareaValue: t.value,
      textareaAttr: t.getAttribute("value"),
    };
  });

  expect(attrs.inputValue).toBe("WWWWWWWWWW");
  expect(attrs.inputAttr).toBe("aa");
  expect(attrs.textareaValue).toBe("MMMMMMMMMM");
  expect(attrs.textareaAttr).toBe(null);

  const after = await page.screenshot({ type: "png" });
  expect(
    Buffer.compare(before as Buffer, after as Buffer),
    "IDL value set must repaint the input/textarea glyphs",
  ).not.toBe(0);
});
