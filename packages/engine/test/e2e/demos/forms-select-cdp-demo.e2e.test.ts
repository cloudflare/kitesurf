// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("forms-select-cdp-demo", async ({ page }) => {
  async function readLabel(page, id) {
    return page.evaluate((id) => {
      const sel = document.getElementById(id);
      const last = sel.childNodes[sel.childNodes.length - 1];
      return last && last.nodeType === 3 ? last.nodeValue : null;
    }, id);
  }

  await page.goto(
    "data:text/html," +
      encodeURIComponent(`<!doctype html><html><body>
        <select id="a"><option value="a">Apple</option><option value="b" selected>Banana</option><option value="c">Cherry</option></select>
        <select id="b"><option>OnlyOne</option></select>
      </body></html>`),
    { waitUntil: "load" },
  );

  expect(
    (await readLabel(page, "a")) === "Banana",
    "parse-time label = selected option",
  ).toBeTruthy();
  expect(
    (await readLabel(page, "b")) === "OnlyOne",
    "single-option label = that option",
  ).toBeTruthy();

  await page.select("#a", "c");
  expect((await readLabel(page, "a")) === "Cherry", "page.select() refreshed label").toBeTruthy();

  await page.evaluate(() => {
    (document.getElementById("a") as HTMLSelectElement).value = "a";
  });
  expect(
    (await readLabel(page, "a")) === "Apple",
    "select.value setter refreshed label",
  ).toBeTruthy();

  await page.evaluate(() => {
    (document.getElementById("a") as HTMLSelectElement).selectedIndex = 1;
  });
  expect(
    (await readLabel(page, "a")) === "Banana",
    "select.selectedIndex setter refreshed label",
  ).toBeTruthy();

  await page.evaluate(() => {
    (document.getElementById("a") as HTMLSelectElement).options[2].selected = true;
  });
  expect(
    (await readLabel(page, "a")) === "Cherry",
    "option.selected=true refreshed label",
  ).toBeTruthy();

  await page.evaluate(() => {
    (document.getElementById("a") as HTMLSelectElement).options[2].selected = false;
  });
  expect(
    (await readLabel(page, "a")) === "Apple",
    "option.selected=false falls back to first option",
  ).toBeTruthy();

  await page.evaluate(() => {
    (document.getElementById("a") as HTMLSelectElement).value = "no-such-value";
  });
  expect(
    (await readLabel(page, "a")) === "Apple",
    "select.value = miss falls back to first option",
  ).toBeTruthy();

  await page.evaluate(() => {
    const sel = document.getElementById("a") as HTMLSelectElement;
    const opt = document.createElement("option");
    opt.value = "d";
    opt.textContent = "Date";
    sel.add(opt);
    sel.value = "d";
  });
  expect(
    (await readLabel(page, "a")) === "Date",
    "select.add + select.value refreshed label",
  ).toBeTruthy();

  await page.evaluate(() => {
    const sel = document.getElementById("a") as HTMLSelectElement;
    const idx = sel.selectedIndex;
    sel.remove(idx);
  });
  const after = await readLabel(page, "a");
  expect(
    after === "Apple" || after === "Banana" || after === "Cherry",
    `select.remove falls back to a remaining option (got ${JSON.stringify(after)})`,
  ).toBeTruthy();
});
