// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("writes and removals by name update the parsed xlink:href in place", async ({ page }) => {
  await setContent(
    page,
    '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><use id="u" xlink:href="#a"></use><use id="v" xlink:href="#v"></use></svg>',
  );

  const seen = await page.evaluate(() => {
    const XLINK = "http://www.w3.org/1999/xlink";
    const byId = (id: string): Element => {
      const el = document.getElementById(id);
      if (!el) throw new Error("missing #" + id);
      return el;
    };
    const xlinkCount = (el: Element) =>
      el.getAttributeNames().filter((name) => name === "xlink:href").length;
    const u = byId("u");
    const v = byId("v");
    const out: unknown[] = [];
    u.setAttribute("xlink:href", "#b");
    out.push(u.getAttribute("xlink:href"), u.getAttributeNS(XLINK, "href"));
    u.setAttributeNS(XLINK, "xlink:href", "#c");
    out.push(u.getAttributeNS(XLINK, "href"), u.getAttribute("xlink:href"), xlinkCount(u));
    u.removeAttribute("xlink:href");
    out.push(u.hasAttribute("xlink:href"), xlinkCount(u));
    v.removeAttributeNS(XLINK, "href");
    out.push(v.hasAttribute("xlink:href"), xlinkCount(v));
    return out;
  });

  expect(seen).toEqual(["#b", "#b", "#c", "#c", 1, false, 0, false, 0]);
});

test("setAttributeNS in another namespace adds a second xlink:href", async ({ page }) => {
  await setContent(
    page,
    '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><use id="u" xlink:href="#a"></use></svg>',
  );

  const seen = await page.evaluate(() => {
    const XLINK = "http://www.w3.org/1999/xlink";
    const u = document.getElementById("u");
    if (!u) throw new Error("missing #u");
    u.setAttributeNS("urn:other", "xlink:href", "#z");
    return [
      u.getAttributeNS(XLINK, "href"),
      u.getAttributeNS("urn:other", "href"),
      u.getAttributeNames().filter((name) => name === "xlink:href").length,
    ];
  });

  expect(seen).toEqual(["#a", "#z", 2]);
});
