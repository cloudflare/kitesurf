// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("shadow-dir-directionality", async ({ page }) => {
  await page.goto(
    "data:text/html," +
      encodeURIComponent(`<!doctype html><html><body>
        <div id="hostRtlSlot"><p>paragraph.</p></div>
        <div id="hostAutoSlot"><p>&#x5D0;&#x5D1;&#x5D2;.</p></div>
        <span id="hostAuto" dir="auto"></span>
        <bdi id="bdi">&#x5D0;&#x5D1;</bdi>
      </body></html>`),
  );

  const r = await page.evaluate(() => {
    const out: any = {};

    const h1 = document.getElementById("hostRtlSlot") as any;
    h1.attachShadow({ mode: "open" }).innerHTML = '<slot dir="rtl"></slot>';
    const p1 = h1.querySelector("p");
    out.slottedDirLtr = p1.matches(":dir(ltr)");
    out.slottedComputed = getComputedStyle(p1).direction;

    const h2 = document.getElementById("hostAutoSlot") as any;
    h2.attachShadow({ mode: "open" }).innerHTML = '<slot dir="auto"></slot>';
    const p2 = h2.querySelector("p");
    out.autoSlotDirLtr = p2.matches(":dir(ltr)");
    out.autoSlotComputed = getComputedStyle(p2).direction;

    const h3 = document.getElementById("hostAuto") as any;
    h3.attachShadow({ mode: "open" }).innerHTML = "\u05D0\u05D1\u05D2.";
    out.hostAutoDirLtr = h3.matches(":dir(ltr)");
    out.hostAutoComputed = getComputedStyle(h3).direction;

    const bdi = document.getElementById("bdi") as any;
    out.bdiDirRtl = bdi.matches(":dir(rtl)");
    out.bdiComputed = getComputedStyle(bdi).direction;

    // Unknown :dir() idents parse but never match (Selectors 4).
    out.unknownIdent = bdi.matches(":dir(sideways)");
    return out;
  });

  expect(r.slottedDirLtr, "slotted :dir follows the light tree").toBe(true);
  expect(r.slottedComputed, "slotted computed direction follows the flat tree").toBe("rtl");
  expect(r.autoSlotDirLtr, "slotted :dir ignores the auto slot").toBe(true);
  expect(r.autoSlotComputed, "slot dir=auto scans its assigned nodes").toBe("rtl");
  expect(r.hostAutoDirLtr, "host dir=auto scan must not see shadow text").toBe(true);
  expect(r.hostAutoComputed, "host dir=auto computed stays ltr").toBe("ltr");
  expect(r.bdiDirRtl, "bdi defaults to dir=auto (first-strong rtl)").toBe(true);
  expect(r.bdiComputed, "bdi computed direction from its own scan").toBe("rtl");
  expect(r.unknownIdent, "unknown :dir() idents never match").toBe(false);
});
