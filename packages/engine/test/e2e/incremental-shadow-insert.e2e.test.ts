// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const HTML = `<!doctype html>
<meta charset="utf-8">
<div id="host"></div>
<script>
  const host = document.getElementById("host");
  const sr = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = ".card{height:40px;margin:4px}";
  sr.appendChild(style);
  const nested = document.createElement("div");
  sr.appendChild(nested);
  const mk = (i) => { const d = document.createElement("div"); d.className = "card"; d.textContent = "card " + i; return d; };
  window.insertShadow = (n) => { for (let i = 0; i < n; i++) sr.appendChild(mk(i)); };
  window.insertNested = (n) => { for (let i = 0; i < n; i++) nested.appendChild(mk(i)); };
  window.cardHeights = (root) => {
    const el = root === "nested" ? nested : sr;
    return [...el.querySelectorAll(".card")].map((c) => Math.round(c.getBoundingClientRect().height));
  };
</script>`;

test("rows inserted into a shadow tree after first paint get boxes", async ({ page }) => {
  await setContent(page, HTML, { waitUntil: "domcontentloaded", timeout: 30000 });

  await page.evaluate(() => document.getElementById("host")!.getBoundingClientRect());

  await page.evaluate(() =>
    (window as typeof window & { insertShadow(n: number): void }).insertShadow(5),
  );
  const shadow = await page.evaluate(() =>
    (window as typeof window & { cardHeights(r: string): number[] }).cardHeights("shadow"),
  );
  expect(shadow, "direct shadow-root insert").toEqual([40, 40, 40, 40, 40]);

  await page.evaluate(() =>
    (window as typeof window & { insertNested(n: number): void }).insertNested(5),
  );
  const nested = await page.evaluate(() =>
    (window as typeof window & { cardHeights(r: string): number[] }).cardHeights("nested"),
  );
  expect(nested, "insert into a light div nested in the shadow").toEqual([40, 40, 40, 40, 40]);
});
