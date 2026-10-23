// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const FORM = `<!doctype html><title>f</title>
<form id=f method=GET action="about:blank">
  <input name=query value="quantum computing">
  <select id=s name=searchtype><option value=all>All<option value=title>Title</select>
  <select name=skip><option disabled value=x>X<option value=y>Y</select>
  <button id=go>Search</button>
</form>`;

test("an unmarked single select submits its first enabled option", async ({ page }) => {
  await setContent(page, FORM);
  const state = await page.evaluate(() => {
    const s = document.getElementById("s") as HTMLSelectElement;
    return {
      value: s.value,
      index: s.selectedIndex,
      firstSelected: s.options[0]!.selected,
      entries: [...new FormData(document.getElementById("f") as HTMLFormElement)].map((e) =>
        e.join("="),
      ),
    };
  });
  expect(state).toEqual({
    value: "all",
    index: 0,
    firstSelected: true,
    entries: ["query=quantum computing", "searchtype=all", "skip=y"],
  });
}, 60_000);

test("a selected attribute added to an earlier option wins a single select", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html><title>t</title>
    <select id=a><option>A<option selected>B</select>
    <select id=d><option>A<option selected>B</select>
    <select id=k><option>A<option selected>B<option>C</select>`,
  );
  const state = await page.evaluate(() => {
    const areSelects = (
      values: (HTMLElement | null)[],
    ): values is [HTMLSelectElement, HTMLSelectElement, HTMLSelectElement] =>
      values.length === 3 && values.every((value) => value instanceof HTMLSelectElement);
    const setSelected = (option: HTMLOptionElement | undefined) => {
      option?.setAttribute("selected", "");
    };
    const moveSelected = (option: HTMLOptionElement | undefined) => {
      option?.removeAttribute("selected");
      option?.setAttribute("selected", "");
    };
    const pick = (id: string) => {
      const s = document.getElementById(id);
      return s instanceof HTMLSelectElement
        ? [s.value, s.selectedIndex, ...[...s.options].map((o) => o.selected)]
        : null;
    };
    const selects = ["a", "d", "k"].map((id) => document.getElementById(id));
    if (!areSelects(selects)) return null;
    const [a, d, k] = selects;
    setSelected(a.options[0]);
    const opt = d.options[0];
    if (opt) opt.defaultSelected = true;
    setSelected(k.options[0]);
    const afterFirst = pick("k");
    moveSelected(k.options[1]);
    return { a: pick("a"), d: pick("d"), kFirst: afterFirst, kBack: pick("k") };
  });
  expect(state).toEqual({
    a: ["A", 0, true, false],
    d: ["A", 0, true, false],
    kFirst: ["A", 0, true, false, false],
    kBack: ["B", 1, false, true, false],
  });
}, 60_000);

test("a script-emptied select re-picks its first option once its options change", async ({
  page,
}) => {
  await setContent(
    page,
    `<!doctype html><title>t</title>
    <select id=s><option>x<option>y</select><p id=p></p>`,
  );
  const state = await page.evaluate(() => {
    const s = document.getElementById("s");
    if (!(s instanceof HTMLSelectElement)) return null;
    const read = () => [s.value, s.selectedIndex];
    s.selectedIndex = -1;
    document.getElementById("p")?.append("unrelated");
    const cleared = read();
    s.remove(1);
    s.add(new Option("z"));
    const swapped = read();
    return { cleared, swapped };
  });
  expect(state).toEqual({ cleared: ["", -1], swapped: ["x", 0] });
}, 60_000);
