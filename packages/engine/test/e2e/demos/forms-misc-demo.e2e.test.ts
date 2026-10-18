// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("forms-misc-demo", async ({ page }) => {
  await page.goto(
    "data:text/html," +
      encodeURIComponent(`<!doctype html><html><body>
        <form id="f">
          <fieldset disabled>
            <input name="hidden-in-disabled" value="x">
            <select name="select-in-disabled"><option value="y" selected>Y</option></select>
          </fieldset>
          <input name="normal" value="z">
          <input list="cities" name="city">
          <datalist id="cities">
            <option value="London">
            <option value="Tokyo">
          </datalist>
        </form>
      </body></html>`),
  );

  const r = await page.evaluate(() => {
    const checks = [];
    const add = (l, ok, info = "") => checks.push({ l, ok, info });

    const f = document.getElementById("f") as HTMLFormElement;

    const fd = new FormData(f);
    add("normal field included", fd.has("normal"));
    add("hidden-in-disabled skipped", !fd.has("hidden-in-disabled"));
    add("select-in-disabled skipped", !fd.has("select-in-disabled"));

    const cityInput = document.querySelector<HTMLInputElement>('input[name="city"]');
    add("input.list returns datalist", cityInput.list instanceof HTMLDataListElement);
    add("datalist has 2 options", cityInput.list.children.length === 2);

    add(
      "non-listed input.list null",
      document.querySelector<HTMLInputElement>('input[name="normal"]').list === null,
    );

    let formdataFired = 0;
    let lastEvent = null;
    f.addEventListener("formdata", (e) => {
      formdataFired++;
      lastEvent = e;
      e.formData.append("injected", "from-formdata-handler");
    });
    const fd2 = new FormData(f);
    add("formdata fired on FormData construction", formdataFired === 1);
    add("event has formData property", lastEvent && lastEvent.formData instanceof FormData);
    add("injected entry visible after dispatch", fd2.has("injected"));
    add("injected value correct", fd2.get("injected") === "from-formdata-handler");

    return checks;
  });

  for (const c of r) {
    expect(c.ok, c.info ? `${c.l} (${c.info})` : c.l).toBeTruthy();
  }
});
