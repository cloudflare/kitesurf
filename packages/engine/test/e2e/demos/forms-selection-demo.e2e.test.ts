// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("forms-selection-demo", async ({ page }) => {
  await page.goto(
    "data:text/html," +
      encodeURIComponent(`<!doctype html><html><body>
        <input id="t" type="text" value="hello world">
        <input id="p" type="password" value="secret">
        <input id="cb" type="checkbox">
        <textarea id="ta">multi line text here</textarea>
      </body></html>`),
  );

  const r = await page.evaluate(async () => {
    const checks = [];
    const add = (l, ok, info = "") => checks.push({ l, ok, info });
    const el = <T extends HTMLElement = HTMLInputElement>(id: string) =>
      document.getElementById(id) as T;
    const flush = () => new Promise((r) => setTimeout(r, 0));

    const t = el("t");

    add("initial start = 0", t.selectionStart === 0);
    add("initial end = 0", t.selectionEnd === 0);
    add("initial direction none", t.selectionDirection === "none");

    t.setSelectionRange(0, 5);
    add("setSelectionRange start", t.selectionStart === 0);
    add("setSelectionRange end", t.selectionEnd === 5);
    add("selected slice = 'hello'", t.value.slice(t.selectionStart, t.selectionEnd) === "hello");

    t.setSelectionRange(0, 5, "backward");
    add("direction backward", t.selectionDirection === "backward");

    t.setSelectionRange(-5, 1000);
    add("wrap+clamp start = len", t.selectionStart === t.value.length);
    add("wrap+clamp end = len", t.selectionEnd === t.value.length);

    t.value = "rebuilt";
    add("value setter collapses to end", t.selectionStart === 7 && t.selectionEnd === 7);
    t.select();
    add("select() start = 0", t.selectionStart === 0);
    add("select() end = len", t.selectionEnd === 7);

    let selectFired = 0;
    t.addEventListener("select", () => selectFired++);
    t.setSelectionRange(0, 3);
    await flush();
    add("select event fires", selectFired === 1);
    t.setSelectionRange(0, 3);
    await flush();
    add("select dedupes on same range", selectFired === 1);
    t.select();
    await flush();
    add("select() fires too", selectFired === 2);

    t.value = "Hello World";
    t.setSelectionRange(6, 11);
    t.setRangeText("Earth");
    add("setRangeText replaces selection", t.value === "Hello Earth");

    t.value = "abcdef";
    t.setRangeText("XX", 2, 4);
    add("setRangeText with explicit range", t.value === "abXXef");

    t.value = "abcdef";
    t.setRangeText("XX", 0, 2, "select");
    add(
      "setRangeText select mode",
      t.value === "XXcdef" && t.selectionStart === 0 && t.selectionEnd === 2,
    );

    t.value = "abcdef";
    t.setRangeText("XXX", 0, 2, "end");
    add(
      "setRangeText end mode positions cursor after",
      t.selectionStart === 3 && t.selectionEnd === 3,
    );

    const ta = el<HTMLTextAreaElement>("ta");
    ta.setSelectionRange(0, 5);
    add("textarea selection start", ta.selectionStart === 0);
    add("textarea selection end", ta.selectionEnd === 5);
    add("textarea selected slice", ta.value.slice(0, 5) === "multi");

    el("p").setSelectionRange(0, 3);
    add("password supports selection", el("p").selectionEnd === 3);

    let threw = false;
    try {
      el("cb").setSelectionRange(0, 1);
    } catch {
      threw = true;
    }
    add("checkbox setSelectionRange throws", threw);
    add("checkbox selectionStart returns null", el("cb").selectionStart === null);

    return checks;
  });

  for (const c of r) {
    expect(c.ok, c.l + (c.info ? " (" + c.info + ")" : "")).toBeTruthy();
  }
});
