// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("forms-form-demo", async ({ page }) => {
  await page.goto(
    "data:text/html," +
      encodeURIComponent(`<!doctype html><html><body>
        <form id="f" action="/x" method="post" enctype="multipart/form-data">
          <label id="lab" for="i">Name</label>
          <input id="i" name="username" value="alice">
          <input id="i2" name="age" type="number">
          <input id="i3" type="hidden" value="t">
          <input id="i4" type="image" name="pic">
          <textarea id="ta" name="bio">Hi</textarea>
          <select id="s" name="color">
            <option value="r">Red</option>
            <option value="g" selected>Green</option>
          </select>
          <fieldset id="fs">
            <legend>Group</legend>
            <input id="i5" name="g1" type="checkbox" checked>
          </fieldset>
          <button id="b1">Submit</button>
          <button id="b2" type="button">Cancel</button>
          <button id="b3" type="reset">Reset</button>
        </form>
        <label id="lab2"><input id="ic" type="text" value="contained"></label>
        <input id="external" form="f" name="external">
      </body></html>`),
  );

  const r = await page.evaluate(() => {
    const checks = [];
    const add = (l, ok, info = "") => checks.push({ l, ok, info });
    const el = <T extends HTMLElement = HTMLInputElement>(id: string) =>
      document.getElementById(id) as T;
    const hasOneLabel = (labels) => labels && labels.length === 1;
    const isLabelFor = (labels, label) => labels && labels[0] === label;

    const f = el<HTMLFormElement>("f");

    const els = Array.from(f.elements);
    add("elements has 11 (incl image, fieldset, external)", els.length >= 11, "got " + els.length);
    add("elements includes external (form=f)", els.includes(el("external")));

    add(
      "length excludes image input",
      f.length === f.elements.length - 1,
      "len=" + f.length + " elements=" + f.elements.length,
    );

    add("action attr", f.action === "/x");
    add("method post", f.method === "post");
    add("enctype multipart", f.enctype === "multipart/form-data");

    add("namedItem username", f.namedItem("username") === el("i"));
    add("namedItem missing", f.namedItem("nope") === null);

    add("default button type submit", el<HTMLButtonElement>("b1").type === "submit");
    add("button type=button", el<HTMLButtonElement>("b2").type === "button");
    add("button type=reset", el<HTMLButtonElement>("b3").type === "reset");

    add("button.form via ancestor", el<HTMLButtonElement>("b1").form === f);

    const labelsForI = el("i").labels;
    add("input.labels NodeList truthy", hasOneLabel(labelsForI));
    add("input.labels[0] = explicit label", isLabelFor(labelsForI, el<HTMLLabelElement>("lab")));

    const labelsForIc = el("ic").labels;
    add(
      "ancestor label found",
      hasOneLabel(labelsForIc) && isLabelFor(labelsForIc, el<HTMLLabelElement>("lab2")),
    );

    add("hidden.labels null", el("i3").labels === null);

    add("label.htmlFor", el<HTMLLabelElement>("lab").htmlFor === "i");
    add("label.control resolves to input", el<HTMLLabelElement>("lab").control === el("i"));
    add(
      "ancestor label.control walks descendants",
      el<HTMLLabelElement>("lab2").control === el("ic"),
    );

    add("external input.form by id ref", el("external").form === f);

    let submitFired = 0;
    let lastSubmitter = "MISSING";
    f.addEventListener("submit", (e) => {
      submitFired++;
      lastSubmitter = e.submitter?.id ?? "null";
      e.preventDefault();
    });
    f.submit();
    add("submit() fires submit event", submitFired === 1);
    add("submit() submitter is null", lastSubmitter === "null");

    f.requestSubmit(el<HTMLButtonElement>("b1"));
    add("requestSubmit fires", submitFired === 2);
    add("requestSubmit submitter wired", lastSubmitter === "b1");

    let threw = false;
    try {
      f.requestSubmit(el("i"));
    } catch {
      threw = true;
    }
    add("requestSubmit(non-button) throws", threw);

    el("i").value = "modified";
    let resetFired = 0;
    f.addEventListener("reset", () => {
      resetFired++;
    });
    f.reset();
    add("reset event fires", resetFired === 1);
    add("input value reset to attr", el("i").value === "alice");

    add("fieldset.type", el<HTMLFieldSetElement>("fs").type === "fieldset");
    add(
      "fieldset.elements has input",
      Array.from(el<HTMLFieldSetElement>("fs").elements).includes(el("i5")),
    );

    return checks;
  });

  for (const c of r) {
    expect(c.ok, c.info ? `${c.l} (${c.info})` : c.l).toBeTruthy();
  }
});
