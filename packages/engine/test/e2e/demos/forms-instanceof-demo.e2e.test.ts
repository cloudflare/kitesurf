// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("forms-instanceof-demo", async ({ page }) => {
  await page.goto(
    "data:text/html," +
      encodeURIComponent(`<!doctype html><html><body>
        <form id="f"><input id="i" type="text"><textarea id="t"></textarea>
        <select id="s"><option>a</option></select>
        <button id="b">x</button><label id="l" for="i">L</label>
        </form>
        <a href="/" id="a">link</a><img src="x" id="img"><div id="d"></div>
      </body></html>`),
  );

  const results = await page.evaluate(() => {
    const checks = [];
    const add = (label, ok, info = "") => checks.push({ label, ok, info });
    const el = (id) => document.getElementById(id);

    add("input instanceof HTMLInputElement", el("i") instanceof HTMLInputElement);
    add("input instanceof HTMLElement", el("i") instanceof HTMLElement);
    add("input instanceof Element", el("i") instanceof Element);
    add("textarea instanceof HTMLTextAreaElement", el("t") instanceof HTMLTextAreaElement);
    add("select instanceof HTMLSelectElement", el("s") instanceof HTMLSelectElement);
    add(
      "option instanceof HTMLOptionElement",
      el("s").firstElementChild instanceof HTMLOptionElement,
    );
    add("button instanceof HTMLButtonElement", el("b") instanceof HTMLButtonElement);
    add("label instanceof HTMLLabelElement", el("l") instanceof HTMLLabelElement);
    add("form instanceof HTMLFormElement", el("f") instanceof HTMLFormElement);
    add("a instanceof HTMLAnchorElement", el("a") instanceof HTMLAnchorElement);
    add("img instanceof HTMLImageElement", el("img") instanceof HTMLImageElement);
    add("div instanceof HTMLDivElement", el("d") instanceof HTMLDivElement);

    add("input NOT instanceof HTMLTextAreaElement", !(el("i") instanceof HTMLTextAreaElement));

    add(
      "toString input",
      Object.prototype.toString.call(el("i")) === "[object HTMLInputElement]",
      Object.prototype.toString.call(el("i")),
    );
    add(
      "toString textarea",
      Object.prototype.toString.call(el("t")) === "[object HTMLTextAreaElement]",
      Object.prototype.toString.call(el("t")),
    );

    const newInput = document.createElement("input");
    add("createElement('input') is HTMLInputElement", newInput instanceof HTMLInputElement);
    const newForm = document.createElement("form");
    add("createElement('form') is HTMLFormElement", newForm instanceof HTMLFormElement);

    const h1 = document.createElement("h1");
    const h3 = document.createElement("h3");
    add(
      "h1 + h3 both HTMLHeadingElement",
      h1 instanceof HTMLHeadingElement && h3 instanceof HTMLHeadingElement,
    );

    return checks;
  });

  for (const c of results) {
    expect(c.ok, c.info ? `${c.label} (${c.info})` : c.label).toBeTruthy();
  }
});
