// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("importNode and createElementNS upgrade defined custom elements", async ({ page }) => {
  await setContent(
    page,
    `<script>
      customElements.define("x-adorner", class extends HTMLElement { show() { return "shown"; } });
      const t = document.createElement("template");
      t.innerHTML = "<div><x-adorner></x-adorner></div>";
      window.__ce = JSON.stringify({
        importNode: typeof document.importNode(t.content, true).querySelector("x-adorner").show,
        createElementNS: typeof document.createElementNS("http://www.w3.org/1999/xhtml", "x-adorner").show,
        inertClone: typeof t.content.cloneNode(true).querySelector("x-adorner").show,
        svgNamespace: typeof document.createElementNS("http://www.w3.org/2000/svg", "x-adorner").show,
      });
    </script>`,
  );
  expect(await page.evaluate("JSON.parse(window.__ce)")).toEqual({
    importNode: "function",
    createElementNS: "function",
    inertClone: "undefined",
    svgNamespace: "undefined",
  });
});
