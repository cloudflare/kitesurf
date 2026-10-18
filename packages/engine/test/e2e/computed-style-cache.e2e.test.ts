// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const MARKUP = `<style>
  #t { width: 10px; color: rgb(1, 2, 3); }
  #t::before { content: "x"; width: 90px; color: rgb(9, 9, 9); }
  #t.go { width: 70px; }
</style>
<div id="t">x</div>`;

test("computed style cache: same-turn writes, pseudo keys, cross-task cascade", async ({
  page,
}) => {
  await setContent(page, MARKUP);

  const r = await page.evaluate(() => {
    const t = document.getElementById("t");
    if (!t) throw new Error("#t missing from the fixture page");

    const before = getComputedStyle(t).width;
    t.style.width = "50px";
    const afterInline = getComputedStyle(t).width;
    t.style.width = "60px";
    const afterSecond = getComputedStyle(t).width;

    const colorAfterWrites = getComputedStyle(t).color;

    t.style.width = "";
    const elemWidth = getComputedStyle(t).width;
    const pseudoWidth = getComputedStyle(t, "::before").width;
    const elemWidthAgain = getComputedStyle(t).width;
    const pseudoColor = getComputedStyle(t, "::before").color;

    return {
      before,
      afterInline,
      afterSecond,
      colorAfterWrites,
      elemWidth,
      pseudoWidth,
      elemWidthAgain,
      pseudoColor,
    };
  });

  expect(r.before).toBe("10px");
  expect(r.afterInline).toBe("50px");
  expect(r.afterSecond).toBe("60px");
  expect(r.colorAfterWrites).toBe("rgb(1, 2, 3)");
  expect(r.elemWidth).toBe("10px");
  expect(r.pseudoWidth).toBe("90px");
  expect(r.elemWidthAgain).toBe("10px");
  expect(r.pseudoColor).toBe("rgb(9, 9, 9)");

  const crossTask = await page.evaluate(async () => {
    const t = document.getElementById("t");
    if (!t) throw new Error("#t missing");
    const seed = getComputedStyle(t).width;
    t.classList.add("go");
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { seed, after: getComputedStyle(t).width };
  });
  expect(crossTask.seed).toBe("10px");
  expect(crossTask.after).toBe("70px");
});
