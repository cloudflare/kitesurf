// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

const FIXTURE = (probe: string) =>
  `https://ks.invalid/__fixtures/font-defer.html?probe=${probe}&ms=1500`;

const MARKUP = `<style>
  .ic { font-family: KsDeferMono; font-size: 24px; }
  .ic::before { content: "WiWi"; }
</style>
<i id="block" class="ic" style="display:block;width:max-content"></i>
<i id="inline-block" class="ic" style="display:inline-block"></i>
<div style="display:flex"><i id="flex-item" class="ic"></i></div>
<button><i id="button" class="ic"></i></button>
<span id="control" style="display:inline-block;font:24px KsDeferMono">WiWi</span>`;

test("an element's own ::before text re-shapes when its webfont arrives", async ({ page }) => {
  await page.goto(FIXTURE(`pseudo-${Date.now()}`), { waitUntil: "domcontentloaded" });
  const fallback = await page.evaluate((markup) => {
    document.body.insertAdjacentHTML("beforeend", markup);
    const control = document.getElementById("control");
    if (!control) throw new Error("missing element #control");
    return control.getBoundingClientRect().width;
  }, MARKUP);

  await page.waitForFunction(
    (fb) => {
      const control = document.getElementById("control");
      if (!control) throw new Error("missing element #control");
      return control.getBoundingClientRect().width !== fb;
    },
    { timeout: 15_000, polling: 100 },
    fallback,
  );

  const widths = await page.evaluate(() => {
    const width = (el: Element) => Math.round(el.getBoundingClientRect().width * 10) / 10;
    const out: Record<string, [number, number]> = {};
    for (const id of ["block", "inline-block", "flex-item", "button"]) {
      const el = document.getElementById(id);
      if (!el) throw new Error(`missing element #${id}`);
      const fresh = el.cloneNode(true);
      if (!(fresh instanceof Element)) throw new TypeError(`clone of #${id} is not an Element`);
      fresh.removeAttribute("id");
      el.after(fresh);
      out[id] = [width(el), width(fresh)];
    }
    return out;
  });

  for (const [id, [shaped, fresh]] of Object.entries(widths)) {
    expect(shaped, `${id} kept its fallback shaping`).toBe(fresh);
    expect(fresh, `${id} never used the webfont`).not.toBe(fallback);
  }
}, 60_000);
