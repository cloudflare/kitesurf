// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const LIME = "rgb(0, 255, 0)";

const MARKUP = `<style>
  #rtl:dir(rtl) + span, #ltr:dir(ltr) + span,
  #self:dir(rtl) + span, #fr:lang(fr) + span { background: lime; }
</style>
<div id="a"><div><div id="rtl"></div><span id="rtl-s">x</span></div></div>
<div id="b" dir="rtl"><div><div id="ltr"></div><span id="auto-s">x</span></div></div>
<div><div id="self"></div><span id="self-s">x</span></div>
<div id="c" lang="en"><div><div id="fr"></div><span id="fr-s">x</span></div></div>`;

test("dir and lang writes restyle inherited and sibling selector matches", async ({ page }) => {
  await setContent(page, MARKUP);

  const readBackgrounds = () => {
    const bg = (id: string) => {
      const el = document.getElementById(id);
      if (!el) throw new Error(`#${id} missing from the fixture page`);
      return getComputedStyle(el).backgroundColor;
    };
    return {
      rtl: bg("rtl-s"),
      auto: bg("auto-s"),
      self: bg("self-s"),
      fr: bg("fr-s"),
    };
  };

  const before = await page.evaluate(readBackgrounds);
  expect(Object.values(before)).not.toContain(LIME);

  await page.evaluate(() => {
    document.getElementById("a")?.setAttribute("dir", "rtl");
    document.getElementById("b")?.setAttribute("dir", "auto");
    document.getElementById("self")?.setAttribute("dir", "rtl");
    document.getElementById("c")?.setAttribute("lang", "fr");
  });

  const after = await page.evaluate(readBackgrounds);
  expect(after).toEqual({ rtl: LIME, auto: LIME, self: LIME, fr: LIME });
});
