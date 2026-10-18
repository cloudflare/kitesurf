// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("forms-select-dropdown-demo", async ({ page }) => {
  await page.goto(
    "data:text/html," +
      encodeURIComponent(`<!doctype html><html><body style="margin:0">
        <select id="s" style="width:200px;height:24px;display:block;margin:20px">
          <option value="a">Alpha</option>
          <option value="b">Beta</option>
          <option value="c" disabled>Gamma (disabled)</option>
        </select>
        <div id="spacer" style="height:400px"></div>
        <script>
          window.events = [];
          const s = document.getElementById("s");
          s.addEventListener("input",  () => window.events.push("input:" + s.value));
          s.addEventListener("change", () => window.events.push("change:" + s.value));
        </script>
      </body></html>`),
  );

  await page.click("#s");
  const open = await page.evaluate(() => {
    const overlay = document.querySelector('[data-kitesurf-ua="select-dropdown"]');
    return {
      present: !!overlay,
      rows: overlay ? overlay.children.length : 0,
      firstRowText: overlay?.children[0]?.textContent ?? "",
    };
  });
  expect(open.present).toBe(true);
  expect(open.rows).toBe(3);
  expect(open.firstRowText).toBe("Alpha");

  const rowBox = await page.evaluate(() => {
    const overlay = document.querySelector('[data-kitesurf-ua="select-dropdown"]')!;
    const row = overlay.children[1] as any;
    const r = row.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(rowBox.x, rowBox.y);

  const after = await page.evaluate(() => ({
    value: (document.getElementById("s") as any).value,
    events: (window as any).events as string[],
    overlayGone: !document.querySelector('[data-kitesurf-ua="select-dropdown"]'),
  }));
  expect(after.value).toBe("b");
  expect(after.events).toEqual(["input:b", "change:b"]);
  expect(after.overlayGone).toBe(true);

  await page.click("#s");
  const reopened = await page.evaluate(
    () => !!document.querySelector('[data-kitesurf-ua="select-dropdown"]'),
  );
  expect(reopened).toBe(true);
  await page.mouse.click(300, 350);
  const closed = await page.evaluate(() => ({
    overlayGone: !document.querySelector('[data-kitesurf-ua="select-dropdown"]'),
    events: (window as any).events as string[],
  }));
  expect(closed.overlayGone).toBe(true);
  expect(closed.events).toEqual(["input:b", "change:b"]);
});
