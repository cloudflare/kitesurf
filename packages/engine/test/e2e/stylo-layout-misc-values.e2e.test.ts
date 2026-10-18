// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

// Limitation: these values round-trip through computed style but have no layout/paint consumer.
test("newly-enabled servo values round-trip through getComputedStyle", async ({ page }) => {
  await setContent(
    page,
    `<div id="target" style="
        clip-rule: evenodd;
        image-rendering: high-quality;
        transform-box: stroke-box;
        column-fill: balance-all;
        break-before: recto;
        break-inside: avoid-region;
        flood-color: rgb(1, 2, 3);
        lighting-color: currentcolor;
        shape-outside: path('M 10 10 h 80 v 80 h -80 Z');
      ">target</div>`,
  );

  const computed = await page.$eval("#target", (element) => {
    const style = getComputedStyle(element);
    return {
      clipRule: style.getPropertyValue("clip-rule"),
      imageRendering: style.getPropertyValue("image-rendering"),
      transformBox: style.getPropertyValue("transform-box"),
      columnFill: style.getPropertyValue("column-fill"),
      breakBefore: style.getPropertyValue("break-before"),
      breakInside: style.getPropertyValue("break-inside"),
      floodColor: style.getPropertyValue("flood-color"),
      lightingColor: style.getPropertyValue("lighting-color"),
      // Gap: path() preserves relative lowercase serialization rather than Chrome's form.
      shapeOutside: style.getPropertyValue("shape-outside"),
    };
  });

  expect(computed).toEqual({
    clipRule: "evenodd",
    imageRendering: "high-quality",
    transformBox: "stroke-box",
    columnFill: "balance-all",
    breakBefore: "recto",
    breakInside: "avoid-region",
    floodColor: "rgb(1, 2, 3)",
    lightingColor: "rgb(0, 0, 0)",
    shapeOutside: 'path("M 10 10 h 80 v 80 h -80 Z")',
  });
});
