// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("forms-textarea-default-paint", async ({ page }) => {
  await page.goto(
    "data:text/html," +
      encodeURIComponent(`<!doctype html><html><body>
        <textarea id="s" style="font-size:32px;width:400px;height:100px">static seed</textarea>
        <textarea id="p" style="font-size:32px;width:400px;height:100px"></textarea>
        <script>document.getElementById("p").value = "parse-time value";</script>
      </body></html>`),
  );

  const idl = await page.evaluate(() => {
    const s = document.getElementById("s") as any;
    const p = document.getElementById("p") as any;
    return {
      staticValue: s.value,
      staticDefault: s.defaultValue,
      parseTimeValue: p.value,
      parseTimeAttr: p.getAttribute("value"),
    };
  });
  expect(idl.staticValue).toBe("static seed");
  expect(idl.staticDefault).toBe("static seed");
  expect(idl.parseTimeValue).toBe("parse-time value");
  expect(idl.parseTimeAttr).toBe(null);

  const shot0 = await page.screenshot({ type: "png" });
  await page.evaluate(() => {
    (document.getElementById("s") as any).value = "";
  });
  const shot1 = await page.screenshot({ type: "png" });
  expect(
    Buffer.compare(shot0 as Buffer, shot1 as Buffer),
    "static markup default value must paint",
  ).not.toBe(0);

  await page.evaluate(() => {
    (document.getElementById("p") as any).value = "";
  });
  const shot2 = await page.screenshot({ type: "png" });
  expect(
    Buffer.compare(shot1 as Buffer, shot2 as Buffer),
    "parse-time .value write must survive to first paint",
  ).not.toBe(0);
});
