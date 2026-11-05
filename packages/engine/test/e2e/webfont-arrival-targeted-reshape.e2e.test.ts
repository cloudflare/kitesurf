// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

// The fixture styles every span as inline-block and delays the KsDeferMono face.
const FIXTURE = (probe: string) =>
  `https://ks.invalid/__fixtures/font-defer.html?probe=${probe}&ms=1500`;

const MARKUP = `<div class="case" data-case="inline">aa <em style="font-family:KsDeferMono">WiWi</em> <b>z</b></div>
<div class="case" data-case="inline-block">aa <span style="font-family:KsDeferMono">WiWi</span> <b>z</b></div>
<div class="case" data-case="anonymous-block">lead<p>x</p><em style="font-family:KsDeferMono">WiWi</em><b>z</b></div>
<div class="case" data-case="case-insensitive" style="font-family:ksdefermono">WiWi <b>z</b></div>
<div class="case" data-case="unrelated">WiWi <b>z</b></div>
<span id="control" style="font:24px KsDeferMono">WiWi</span>`;

test("a late webfont reflows the lines that use it and the lines around them", async ({ page }) => {
  await page.goto(FIXTURE(`targeted-${Date.now()}`), { waitUntil: "domcontentloaded" });
  const fallback = await page.evaluate((markup) => {
    document.body.insertAdjacentHTML("beforeend", markup);
    const control = document.getElementById("control");
    if (!control) throw new Error("missing element #control");
    return control.getBoundingClientRect().width;
  }, MARKUP);

  await page.waitForFunction(
    (fb) => document.getElementById("control")?.getBoundingClientRect().width !== fb,
    { timeout: 15_000, polling: 100 },
    fallback,
  );

  const offsets = await page.evaluate(() => {
    const after = (root: Element) => {
      const b = root.querySelector("b");
      if (!b) throw new Error(`missing <b> in ${root.getAttribute("data-case")}`);
      return Math.round((b.getBoundingClientRect().left - root.getBoundingClientRect().left) * 10);
    };
    const out: Record<string, [number, number]> = {};
    for (const root of Array.from(document.querySelectorAll(".case"))) {
      const fresh = root.cloneNode(true);
      if (!(fresh instanceof Element)) throw new TypeError("clone is not an Element");
      root.after(fresh);
      out[root.getAttribute("data-case") ?? "?"] = [after(root), after(fresh)];
    }
    return out;
  });

  expect(Object.keys(offsets)).toHaveLength(5);
  for (const [name, [shaped, fresh]] of Object.entries(offsets)) {
    expect(shaped, `${name} kept its pre-font line layout`).toBe(fresh);
  }
}, 60_000);
