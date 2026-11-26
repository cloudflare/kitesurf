// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

// A button in the Auto state is a submit button only outside a <select> parent.
const MARKUP = `<script>
  const select = document.createElement("select");
  const button = document.createElement("button");
  const before = button.type;
  select.appendChild(button);
  const inSelect = button.type;
  const explicit = document.createElement("button");
  explicit.type = "reset";
  select.appendChild(explicit);
  const grandchild = document.createElement("button");
  const div = document.createElement("div");
  div.appendChild(grandchild);
  select.appendChild(div);
  window.__out = {
    before,
    inSelect,
    explicit: explicit.type,
    grandchild: grandchild.type,
    removed: (button.remove(), button.type),
  };
</script>`;

test("a button whose parent is a select returns type button", async ({ page }) => {
  await setContent(page, MARKUP);
  const r = await page.evaluate(
    () => (window as typeof window & { __out: Record<string, unknown> }).__out,
  );
  expect(r).toEqual({
    before: "submit",
    inSelect: "button",
    explicit: "reset",
    grandchild: "submit",
    removed: "submit",
  });
});
