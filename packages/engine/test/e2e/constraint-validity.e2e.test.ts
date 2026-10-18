// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("disabled controls retain custom-error validity but skip checkValidity", async ({ page }) => {
  await setContent(page, '<input id="custom" disabled>');

  const state = await page.evaluate(() => {
    const custom = document.querySelector("#custom") as HTMLInputElement;
    custom.setCustomValidity("custom error");
    return {
      willValidate: custom.willValidate,
      customError: custom.validity.customError,
      valid: custom.validity.valid,
      checkValidity: custom.checkValidity(),
    };
  });

  expect(state).toEqual({
    willValidate: false,
    customError: true,
    valid: false,
    checkValidity: true,
  });
});

test("willValidate updates as a control enters and leaves a datalist ancestor", async ({
  page,
}) => {
  await setContent(
    page,
    '<datalist id="list"></datalist><div id="wrapper"></div><input id="control">',
  );

  const states = await page.evaluate(() => {
    const control = document.querySelector("#control") as HTMLInputElement;
    const list = document.querySelector("#list")!;
    const wrapper = document.querySelector("#wrapper")!;
    const result = [control.willValidate];
    list.appendChild(control);
    result.push(control.willValidate);
    control.remove();
    result.push(control.willValidate);
    wrapper.appendChild(control);
    list.appendChild(wrapper);
    result.push(control.willValidate);
    wrapper.remove();
    result.push(control.willValidate);
    return result;
  });

  expect(states).toEqual([true, false, true, false, true]);
});
