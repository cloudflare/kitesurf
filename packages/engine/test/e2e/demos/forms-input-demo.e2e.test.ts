// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("forms-input-demo", async ({ page }) => {
  await page.goto(
    "data:text/html," +
      encodeURIComponent(`<!doctype html><html><body>
        <input id="i" type="text" value="hello" required>
        <input id="c" type="checkbox" checked>
        <input id="r" type="radio" value="x">
        <input id="h" type="hidden" value="secret">
        <input id="weird" type="bogus" value="x">
        <textarea id="t">initial text</textarea>
        <form id="f"><input id="ifc" type="text"></form>
      </body></html>`),
  );

  const r = await page.evaluate(() => {
    const checks = [];
    const add = (label, ok, info = "") => checks.push({ label, ok, info });
    const el = <T extends HTMLElement = HTMLInputElement>(id: string) =>
      document.getElementById(id) as T;

    add("text type", el("i").type === "text");
    add("checkbox type", el("c").type === "checkbox");
    add("bogus type clamps to text", el("weird").type === "text");

    add("input.value from attr", el("i").value === "hello");
    add("checkbox.value defaults to 'on' when no value attr", el("c").value === "on");
    add("checkbox.value with value attr", el("r").value === "x");

    add("input.defaultValue", el("i").defaultValue === "hello");

    el("i").value = "typed";
    add("value setter goes dirty", el("i").value === "typed");
    add(
      "attribute NOT mirrored (spec decoupling)",
      el("i").getAttribute("value") === "hello",
      el("i").getAttribute("value"),
    );

    el("i").defaultValue = "new-default";
    add("defaultValue setter writes attr", el("i").getAttribute("value") === "new-default");
    add("dirty value still wins", el("i").value === "typed");

    add("checkbox.checked from attr", el("c").checked === true);
    add("checkbox.defaultChecked from attr", el("c").defaultChecked === true);
    el("c").checked = false;
    add("checked setter -> false", el("c").checked === false);
    add("defaultChecked unchanged after checked set", el("c").defaultChecked === true);
    add("hasAttribute('checked') unchanged", el("c").hasAttribute("checked") === true);

    add("radio.checked default false", el("r").checked === false);
    el("r").checked = true;
    add("radio.checked = true", el("r").checked === true);

    add("required reflects", el("i").required === true);
    el("i").required = false;
    add("required setter removes attr", el("i").required === false);
    add("required attribute removed", el("i").hasAttribute("required") === false);
    el("i").disabled = true;
    add("disabled setter adds attr", el("i").disabled === true);
    add("disabled attr present", el("i").hasAttribute("disabled") === true);

    add("hidden input value", el("h").value === "secret");

    add("textarea.value from text", el<HTMLTextAreaElement>("t").value === "initial text");
    add(
      "textarea.defaultValue from text",
      el<HTMLTextAreaElement>("t").defaultValue === "initial text",
    );
    el<HTMLTextAreaElement>("t").value = "modified";
    add("textarea value setter dirty", el<HTMLTextAreaElement>("t").value === "modified");
    add(
      "textarea defaultValue unchanged",
      el<HTMLTextAreaElement>("t").defaultValue === "initial text",
    );

    add("input.form = ancestor form", el("ifc").form === el<HTMLFormElement>("f"));
    add("input outside form has no .form", el("i").form === null);

    el<HTMLTextAreaElement>("t").value = "12345";
    add("textarea.textLength", el<HTMLTextAreaElement>("t").textLength === 5);

    add("text.valueAsNumber is NaN (spec: not applicable)", Number.isNaN(el("i").valueAsNumber));
    let textSetterThrew: any = false;
    try {
      el("i").valueAsNumber = 100;
    } catch (e: any) {
      textSetterThrew = { name: e?.name, ctor: e?.constructor?.name };
    }
    add("text.valueAsNumber setter throws", !!textSetterThrew, JSON.stringify(textSetterThrew));

    return checks;
  });

  for (const c of r) {
    expect(c.ok, c.info ? `${c.label} (${c.info})` : c.label).toBeTruthy();
  }
});
