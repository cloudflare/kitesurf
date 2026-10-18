// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("forms-dir-auto-value", async ({ page }) => {
  await page.goto(
    "data:text/html," +
      encodeURIComponent(`<!doctype html><body>
        <input id="i" dir="auto">
        <input id="attr" dir="auto" value="&#x5D0;&#x5D1;">
        <textarea id="t" dir="auto"></textarea>
        <input id="up" type="TEXT" style="font-size:32px;width:300px">
        <input id="empty" type="" style="font-size:32px;width:300px">
        <input id="unk" type="bogus" style="font-size:32px;width:300px">
        <script>
          document.getElementById("up").value = "upper";
          document.getElementById("empty").value = "empty";
          document.getElementById("unk").value = "unknown";
        </script>
      </body>`),
  );

  const r = await page.evaluate(() => {
    const out: any = {};
    const i = document.getElementById("i") as any;
    const t = document.getElementById("t") as any;

    out.emptyLtr = i.matches(":dir(ltr)");
    i.value = "\u05D0\u05D1\u05D2";
    out.rtlAfterValue = i.matches(":dir(rtl)");
    out.rtlComputed = getComputedStyle(i).direction;
    i.value = "abc";
    out.ltrAgain = i.matches(":dir(ltr)");

    out.attrRtl = (document.getElementById("attr") as any).matches(":dir(rtl)");

    t.value = "\u05D0\u05D1";
    out.textareaRtl = t.matches(":dir(rtl)");
    return out;
  });

  expect(r.emptyLtr, "valueless input dir=auto defaults ltr").toBe(true);
  expect(r.rtlAfterValue, "script-set RTL value flips :dir(rtl)").toBe(true);
  expect(r.rtlComputed, "cascade hint follows the live value").toBe("rtl");
  expect(r.ltrAgain, "LTR value flips back").toBe(true);
  expect(r.attrRtl, "value attribute drives pre-dirty dir=auto").toBe(true);
  expect(r.textareaRtl, "textarea dirty value drives dir=auto").toBe(true);

  const shot0 = await page.screenshot({ type: "png" });
  await page.evaluate(() => {
    for (const id of ["up", "empty", "unk"]) {
      (document.getElementById(id) as any).value = "";
    }
  });
  const shot1 = await page.screenshot({ type: "png" });
  expect(
    Buffer.compare(shot0 as Buffer, shot1 as Buffer),
    "TEXT/empty/unknown input types must build editors and paint",
  ).not.toBe(0);
});
