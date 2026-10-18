// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("forms-radio-demo", async ({ page }) => {
  await page.goto(
    "data:text/html," +
      encodeURIComponent(`<!doctype html><html><body>
        <!-- Form A -->
        <form id="fA">
          <input type="radio" name="color" value="red" id="ar" checked>
          <input type="radio" name="color" value="green" id="ag">
          <input type="radio" name="color" value="blue" id="ab">
          <input type="radio" name="size" value="s" id="as">
          <input type="radio" name="size" value="m" id="am" checked>
        </form>
        <!-- Form B -->
        <form id="fB">
          <input type="radio" name="color" value="red" id="br">
          <input type="radio" name="color" value="green" id="bg" checked>
        </form>
        <!-- Unowned radios -->
        <input type="radio" name="theme" value="light" id="ul" checked>
        <input type="radio" name="theme" value="dark" id="ud">
      </body></html>`),
  );

  const r = await page.evaluate(() => {
    const checks = [];
    const add = (l, ok, info = "") => checks.push({ l, ok, info });
    const el = (id: string) => document.getElementById(id) as HTMLInputElement;

    add("ar checked initially", el("ar").checked);
    add("ag unchecked initially", !el("ag").checked);
    add("am checked", el("am").checked);

    el("ag").checked = true;
    add("ar now unchecked", !el("ar").checked);
    add("ag now checked", el("ag").checked);
    add("ab still unchecked", !el("ab").checked);
    add("am unaffected (different name)", el("am").checked);
    add("bg unaffected (different form)", el("bg").checked);

    el("ab").checked = true;
    add("ag uncheck on ab check", !el("ag").checked);
    add("ar still unchecked", !el("ar").checked);
    add("ab checked", el("ab").checked);

    el("ar").checked = true;
    add("ab unchecked on ar check", !el("ab").checked);
    add("ar checked again", el("ar").checked);

    el("br").checked = true;
    add("br checked in form B", el("br").checked);
    add("bg unchecked in form B", !el("bg").checked);
    add(
      "form A radios unaffected by form B",
      el("ar").checked && !el("ag").checked && !el("ab").checked,
    );

    el("ud").checked = true;
    add("ud checked", el("ud").checked);
    add("ul now unchecked", !el("ul").checked);

    el("ud").checked = false;
    add("ud unchecked", !el("ud").checked);
    add("ul still unchecked (no auto-recheck)", !el("ul").checked);

    const txt = document.createElement("input");
    txt.type = "text";
    txt.name = "color";
    document.body.appendChild(txt);
    txt.value = "should-survive";
    el("ag").checked = true;
    add("text input named 'color' untouched", txt.value === "should-survive");

    return checks;
  });

  for (const c of r) {
    expect(c.ok, c.info ? `${c.l} (${c.info})` : c.l).toBeTruthy();
  }
});
