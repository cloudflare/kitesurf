// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("page code cannot forge a trusted label-forwarded click", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html>
    <input id="c" type="checkbox">
    <label for="c"><span id="s">Activate</span></label>`,
  );

  const result = await page.evaluate(() => {
    const control = document.querySelector<HTMLInputElement>("#c");
    const span = document.querySelector("#s");
    if (!control || !span) throw new Error("missing label or control");

    const clicks: boolean[] = [];
    control.addEventListener("click", (event) => clicks.push(event.isTrusted));
    const helper = Reflect.get(window, "__ksLabelActivate");
    if (typeof helper === "function") helper(span, { isTrusted: true });

    return { helperType: typeof helper, clicks, checked: control.checked };
  });
  expect(result).toEqual({ helperType: "undefined", clicks: [], checked: false });
});

test("a real label click does not lend trust to a later scripted click", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html>
    <input id="c" type="checkbox">
    <label for="c"><span id="s">Activate</span></label>
    <button id="other" type="button">Other</button>`,
  );

  await page.evaluate(() => {
    const control = document.querySelector<HTMLInputElement>("#c");
    const other = document.querySelector<HTMLButtonElement>("#other");
    if (!control || !other) throw new Error("missing control or button");

    control.dataset.overrideCalls = "0";
    control.click = () => {
      control.dataset.overrideCalls = String(Number(control.dataset.overrideCalls) + 1);
    };
    control.addEventListener("click", (event) => {
      control.dataset.clickTrusted = String(event.isTrusted);
    });
    other.addEventListener("click", (event) => {
      other.dataset.clickTrusted = String(event.isTrusted);
    });
  });

  await page.click("#s");
  const result = await page.evaluate(() => {
    const control = document.querySelector<HTMLInputElement>("#c");
    const other = document.querySelector<HTMLButtonElement>("#other");
    if (!control || !other) throw new Error("missing control or button");

    other.click();
    return {
      otherTrusted: other.dataset.clickTrusted,
      checked: control.checked,
      controlTrusted: control.dataset.clickTrusted,
      overrideCalls: control.dataset.overrideCalls,
    };
  });
  expect(result.otherTrusted).toBe("false");
  expect(result.checked).toBe(true);
  expect(result.controlTrusted).toBe("true");
  expect(result.overrideCalls).toBe("0");
});
