// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

const PAGE = "data:text/html,<!doctype html><div id='t'>x</div>";

test("inline style flush: none colors, shorthand overlap, no-op clears", async ({ page }) => {
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });

  const r = await page.evaluate(() => {
    const t = document.getElementById("t");
    if (!t) throw new Error("#t missing from the fixture page");
    const out: Record<string, string> = {};

    t.style.color = "rgb(none none none)";
    out.specifiedNone = t.style.getPropertyValue("color");
    out.computedNone = getComputedStyle(t).color;

    t.style.setProperty("margin", "10px");
    t.style.setProperty("margin-left", "5px");
    t.style.setProperty("margin", "20px");
    out.marginLeft = getComputedStyle(t).marginLeft;

    t.style.removeProperty("margin-top");
    out.removedTop = getComputedStyle(t).marginTop;
    out.survivingRight = getComputedStyle(t).marginRight;
    out.noneAfterRemoval = getComputedStyle(t).color;

    t.style.color = "rgb(102, 51, 153)";
    t.style.backgroundColor = "";
    t.style.backgroundColor = "rgb(from currentColor r g b)";
    out.currentcolorBg = getComputedStyle(t).backgroundColor;

    return out;
  });

  expect(r.specifiedNone).toBe("rgb(0, 0, 0)");
  expect(r.computedNone).toBe("color(srgb none none none)");
  expect(r.marginLeft).toBe("20px");
  expect(r.removedTop).toBe("0px");
  expect(r.survivingRight).toBe("20px");
  expect(r.noneAfterRemoval).toBe("color(srgb none none none)");
  expect(r.currentcolorBg).toBe("color(srgb 0.4 0.2 0.6)");
});

test("inline style removal expands shorthands and legacy aliases", async ({ page }) => {
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });

  const r = await page.evaluate(() => {
    const t = document.getElementById("t");
    if (!t) throw new Error("#t missing from the fixture page");
    const out: Record<string, number | string> = {};

    t.style.background = "none";
    out.afterBackground = t.style.length;
    for (const p of [
      "background-image",
      "background-position",
      "background-size",
      "background-repeat",
      "background-attachment",
      "background-origin",
      "background-clip",
      "background-color",
    ])
      t.style.setProperty(p, "");
    out.afterLonghandClears = t.style.length;
    out.backgroundRead = t.style.getPropertyValue("background");
    out.attrAfterClears = t.getAttribute("style") ?? "";

    t.style.gap = "10px 20%";
    out.afterGap = t.style.length;
    t.style.setProperty("grid-row-gap", "");
    out.afterRowAlias = t.style.length;
    out.columnGapSurvives = t.style.getPropertyValue("column-gap");
    t.style.setProperty("grid-column-gap", "");
    out.afterColumnAlias = t.style.length;

    t.style.margin = "1px 2px";
    out.afterMargin = t.style.length;
    t.style.removeProperty("margin");
    out.afterMarginRemove = t.style.length;
    out.marginTop = t.style.marginTop;

    return out;
  });

  expect(r.afterBackground).toBeGreaterThan(0);
  expect(r.afterLonghandClears).toBe(0);
  expect(r.backgroundRead).toBe("");
  expect(r.attrAfterClears).toBe("");
  expect(r.afterGap).toBe(2);
  expect(r.afterRowAlias).toBe(1);
  expect(r.columnGapSurvives).toBe("20%");
  expect(r.afterColumnAlias).toBe(0);
  expect(r.afterMargin).toBe(4);
  expect(r.afterMarginRemove).toBe(0);
  expect(r.marginTop).toBe("");
});
