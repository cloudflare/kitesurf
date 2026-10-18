// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("forms-select-demo", async ({ page }) => {
  await page.goto(
    "data:text/html," +
      encodeURIComponent(`<!doctype html><html><body>
        <select id="s">
          <option value="a">Apple</option>
          <option value="b" selected>Banana</option>
          <option value="c">Cherry</option>
        </select>
        <select id="m" multiple>
          <option value="x" selected>X</option>
          <option value="y" selected>Y</option>
          <option value="z">Z</option>
        </select>
        <select id="g">
          <optgroup label="Fruits">
            <option value="apple">Apple</option>
            <option value="banana">Banana</option>
          </optgroup>
          <optgroup label="Veg" disabled>
            <option value="carrot">Carrot</option>
          </optgroup>
        </select>
      </body></html>`),
  );

  const r = await page.evaluate(() => {
    const checks = [];
    const add = (label, ok, info = "") => checks.push({ label, ok, info });
    const el = <T extends HTMLElement = HTMLSelectElement>(id) => document.getElementById(id) as T;

    const s = el("s");

    add("single select.type", s.type === "select-one");
    add("multiple select.type", el("m").type === "select-multiple");

    add("options length", s.options.length === 3);
    add("options[0] is HTMLOptionElement", s.options[0] instanceof HTMLOptionElement);
    add("select.length", s.length === 3);

    add("selectedIndex initial", s.selectedIndex === 1);

    add("value initial", s.value === "b");

    s.value = "c";
    add("value setter selects", s.value === "c");
    add("selectedIndex updated", s.selectedIndex === 2);
    add("previous deselected", s.options[1].selected === false);

    s.selectedIndex = 0;
    add("selectedIndex setter", s.selectedIndex === 0);
    add("value matches first option", s.value === "a");

    const newOpt = document.createElement("option");
    newOpt.text = "  Plum  ";
    add("option.text trims/collapses", newOpt.text === "Plum");
    add("option.value falls back to text", newOpt.value === "Plum");

    newOpt.text = "Grape";
    add("text setter", newOpt.textContent === "Grape");

    add("defaultSelected from attr", s.options[1].defaultSelected === true);

    s.options[1].selected = false;
    add("option.selected setter", s.options[1].selected === false);
    add("attribute unchanged", s.options[1].hasAttribute("selected") === true);

    const m = el("m");
    add("multi: 2 selected initially", m.selectedOptions.length === 2);
    m.options[2].selected = true;
    add("multi: 3 selected", m.selectedOptions.length === 3);

    s.options[2].selected = true;
    add("single: only one selected", s.selectedOptions.length === 1);

    const g = el("g");
    add("nested options counted", g.options.length === 3);
    add("optgroup disabled propagates", g.options[2].disabled === true);
    add("non-disabled option", g.options[0].disabled === false);

    add("option index 0", g.options[0].index === 0);
    add("option index 2", g.options[2].index === 2);

    s.options[0].id = "first-opt";
    add("namedItem by id", s.namedItem("first-opt") === s.options[0]);

    const newer = document.createElement("option");
    newer.value = "z";
    newer.text = "Zucchini";
    s.add(newer);
    add("add appended", s.options[s.options.length - 1] === newer);
    s.remove(s.options.length - 1);
    add("remove last", s.options[s.options.length - 1] !== newer);

    return checks;
  });

  for (const c of r) {
    expect(c.ok, c.label + (c.info ? " (" + c.info + ")" : "")).toBeTruthy();
  }
});
