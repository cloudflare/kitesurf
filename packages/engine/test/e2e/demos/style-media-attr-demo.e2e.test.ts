// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { setContent } from "../set-content";

test("style-media-attr-demo", async ({ page }) => {
  await setContent(
    page,
    `<style media="(max-width:767px)">#t{background-color:rgb(255,0,0);transform:translate3d(-100%,0,0)}</style>
     <style media="(min-width:768px)">#t{color:rgb(0,128,0)}</style>
     <style media="all">#t{font-weight:700}</style>
     <style>#t{letter-spacing:2px}</style>
     <div id="t">probe</div>`,
  );

  const probe = await page.evaluate(() => {
    const cs = getComputedStyle(document.getElementById("t"));
    return {
      bg: cs.backgroundColor,
      transform: cs.transform,
      color: cs.color,
      fontWeight: cs.fontWeight,
      letterSpacing: cs.letterSpacing,
      vw: window.innerWidth,
    };
  });

  expect(probe.vw, "viewport is in the desktop bucket").toBeGreaterThan(767);
  expect(probe.bg, "non-matching media rule (bg) stays inert").not.toBe("rgb(255, 0, 0)");
  expect(probe.transform, "non-matching media rule (transform) stays inert").toBe("none");
  expect(probe.color, "matching media rule applies").toBe("rgb(0, 128, 0)");
  expect(probe.fontWeight, 'media="all" applies').toBe("700");
  expect(probe.letterSpacing, "attribute-less style applies").toBe("2px");
});
