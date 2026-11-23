// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("outerHTML writes a control's attributes, not the state a script or a click set", async ({
  page,
}) => {
  await setContent(page, "<!doctype html><body></body>");
  const serialized = await page.evaluate(() => {
    const host = (html: string) => {
      const div = document.createElement("div");
      div.innerHTML = html;
      document.body.append(div);
      return div;
    };
    const input = (div: HTMLElement, index = 0) => {
      const found = div.querySelectorAll("input")[index];
      if (!found) throw new Error("no input");
      return found;
    };

    const scripted = host('<input type="checkbox">');
    input(scripted).checked = true;
    const clicked = host('<input type="checkbox">');
    input(clicked).click();
    const unchecked = host('<input type="checkbox" checked="checked">');
    input(unchecked).checked = false;
    const unclicked = host('<input type="checkbox" checked>');
    input(unclicked).click();
    const radios = host('<input type="radio" name="g" checked><input type="radio" name="g">');
    input(radios, 1).checked = true;

    return {
      scripted: [scripted.innerHTML, input(scripted).checked],
      clicked: [clicked.innerHTML, input(clicked).checked],
      unchecked: [unchecked.innerHTML, input(unchecked).checked],
      unclicked: [unclicked.innerHTML, input(unclicked).checked],
      radios: [radios.innerHTML, input(radios).checked, input(radios, 1).checked],
    };
  });

  // Chrome's results for the same steps: the property moves and the markup stays as written,
  // which is what a client reading page.content() gets from a browser.
  expect(serialized).toEqual({
    scripted: ['<input type="checkbox">', true],
    clicked: ['<input type="checkbox">', true],
    unchecked: ['<input type="checkbox" checked="checked">', false],
    unclicked: ['<input type="checkbox" checked="">', false],
    radios: ['<input type="radio" name="g" checked=""><input type="radio" name="g">', false, true],
  });
});
