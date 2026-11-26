// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const MARKUP = `<input id="on" type="checkbox" switch><input id="off" type="checkbox">
<script>
  const on = document.getElementById("on");
  const off = document.getElementById("off");
  const out = { parsedOn: on.switch, parsedOff: off.switch };
  off.switch = true;
  out.setTrue = off.getAttribute("switch");
  on.switch = 0;
  out.setFalsy = on.hasAttribute("switch");
  out.own = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "switch") !== undefined;
  window.__out = out;
</script>`;

test("input.switch reflects the switch content attribute", async ({ page }) => {
  await setContent(page, MARKUP);
  const r = await page.evaluate(
    () => (window as typeof window & { __out: Record<string, unknown> }).__out,
  );
  expect(r).toEqual({ parsedOn: true, parsedOff: false, setTrue: "", setFalsy: false, own: true });
});
