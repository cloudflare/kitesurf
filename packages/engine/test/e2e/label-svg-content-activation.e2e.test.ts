// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// SVG icons created with createElementNS must not stop the ancestor walk to their HTML label.
import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("a click on an svg icon inside a label ticks its control", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html>
    <input type="checkbox" id="c">
    <label for="c" id="l"></label>
    <script>
      const ns = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(ns, "svg");
      svg.id = "icon";
      svg.setAttribute("width", "40");
      svg.setAttribute("height", "40");
      const rect = document.createElementNS(ns, "rect");
      rect.setAttribute("width", "40");
      rect.setAttribute("height", "40");
      rect.setAttribute("fill", "red");
      svg.appendChild(rect);
      document.getElementById("l").appendChild(svg);
    </script>`,
  );
  const hit = await page.evaluate(`(() => {
    const b = document.getElementById("icon").getBoundingClientRect();
    const e = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
    return e && e.namespaceURI;
  })()`);
  expect(hit).toBe("http://www.w3.org/2000/svg");
  await page.click("#icon");
  expect(await page.evaluate("document.getElementById('c').checked")).toBe(true);
}, 60_000);
