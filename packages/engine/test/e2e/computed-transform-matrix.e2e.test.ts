// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// getComputedStyle(el).transform is CSSOM's resolved matrix, compared with Chrome 155's
// strings (chrome-devtools MCP). Pages parse the numbers back out, so close is not enough.

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const CASES = {
  r30: "rotate(30deg)",
  r90: "rotate(90deg)",
  r180: "rotate(180deg)",
  r0: "rotate(0deg)",
  big: "scale(1234567.5)",
  pct: "translateX(50%) translateY(10%)",
  skew: "skewX(10deg)",
  td: "translateZ(10px)",
  rx: "rotateX(45deg)",
  rx360: "rotateX(360deg)",
  rx720: "rotateX(720deg)",
  axis360: "rotate3d(1, 1, 0, 360deg)",
  rx180: "rotateX(180deg)",
  none: "none",
  tiny: "matrix(0.0000123456, 0, 0, 1, 0, 0)",
  neg0: "matrix(-0, 0, 0, 1, 0, 0)",
};

test("transform reads back as the matrix Chrome prints", async ({ page }) => {
  await setContent(page, "<div id=host></div>");
  const got = await page.evaluate((cases) => {
    const out: Record<string, string> = {};
    for (const [key, transform] of Object.entries(cases)) {
      const el = document.createElement("div");
      el.style.cssText = `width:200px;height:100px;transform:${transform}`;
      document.body.appendChild(el);
      out[key] = getComputedStyle(el).transform;
      el.remove();
    }
    const hidden = document.createElement("div");
    hidden.style.cssText = "display:none;transform:translateX(50%) rotate(30deg)";
    document.body.appendChild(hidden);
    out.displayNone = getComputedStyle(hidden).transform;
    return out;
  }, CASES);
  expect(got).toEqual({
    r30: "matrix(0.866025, 0.5, -0.5, 0.866025, 0, 0)",
    r90: "matrix(0, 1, -1, 0, 0, 0)",
    r180: "matrix(-1, 0, 0, -1, 0, 0)",
    r0: "matrix(1, 0, 0, 1, 0, 0)",
    big: "matrix(1.23457e+06, 0, 0, 1.23457e+06, 0, 0)",
    pct: "matrix(1, 0, 0, 1, 100, 10)",
    skew: "matrix(1, 0, 0.176327, 1, 0, 0)",
    td: "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 10, 1)",
    rx: "matrix3d(1, 0, 0, 0, 0, 0.707107, 0.707107, 0, 0, -0.707107, 0.707107, 0, 0, 0, 0, 1)",
    rx360: "matrix(1, 0, 0, 1, 0, 0)",
    rx720: "matrix(1, 0, 0, 1, 0, 0)",
    axis360: "matrix(1, 0, 0, 1, 0, 0)",
    rx180: "matrix3d(1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1)",
    none: "none",
    tiny: "matrix(1.23456e-05, 0, 0, 1, 0, 0)",
    neg0: "matrix(0, 0, 0, 1, 0, 0)",
    displayNone: "none",
  });
});

test("an animated rotation reads back as Chrome's matrix", async ({ page }) => {
  await setContent(page, "<div id=t>x</div>");
  const got = await page.evaluate(() => {
    const el = document.getElementById("t");
    if (!el) throw new Error("missing #t");
    const a = el.animate(
      {
        color: ["#205080", "#d0a040"],
        transform: ["rotate(0deg)", "rotate(143deg)"],
        easing: "cubic-bezier(0.3,0.15,0.55,0.85)",
      },
      3000,
    );
    a.pause();
    a.currentTime = 1370;
    const cs = getComputedStyle(el);
    return cs.color + cs.transform;
  });
  expect(got).toBe("rgb(123, 121, 95)matrix(0.275583, 0.961277, -0.961277, 0.275583, 0, 0)");
});
