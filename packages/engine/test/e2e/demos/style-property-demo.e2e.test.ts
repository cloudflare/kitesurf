// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

function expectStyleMatch(
  value: string | null,
  pattern: RegExp,
  message: string,
  expected = true,
): void {
  expect(pattern.test(value || ""), message).toBe(expected);
}

test("style-property-demo", async ({ page }) => {
  const PAGE =
    "data:text/html;charset=utf-8," +
    encodeURIComponent(`<!doctype html>
<html><body>
<div id="bootstrap" style="color: red; background-color: yellow;">bootstrap</div>
<div id="target" style="width: 200px; height: 100px; background: lime;">target</div>
<div id="hide-me" style="width: 50px; height: 50px; background: blue;">hide-me</div>
</body></html>`);

  await page.goto(PAGE, { timeout: 10000 });

  const boot = await page.evaluate(() => {
    const el = document.getElementById("bootstrap");
    return {
      color: el.style.color,
      bg: el.style.backgroundColor,
      bgHyphen: el.style["background-color"],
      attr: el.getAttribute("style"),
    };
  });
  console.log("[style] bootstrap:", boot);
  expect(boot.color, "bootstrap-color-red").toBe("red");
  expect(boot.bg, "bootstrap-bg-yellow").toBe("yellow");
  expect(boot.bgHyphen, "bootstrap-hyphen-read").toBe("yellow");

  const writeProp = await page.evaluate(() => {
    const el = document.getElementById("target");
    el.style.color = "purple";
    el.style.fontSize = "32px";
    return {
      attr: el.getAttribute("style"),
      readBack: { color: el.style.color, fontSize: el.style.fontSize },
    };
  });
  console.log("[style] writeProp attr:", writeProp.attr);
  expectStyleMatch(writeProp.attr, /color:\s*purple/, "writeProp-attr-has-color");
  expectStyleMatch(writeProp.attr, /font-size:\s*32px/, "writeProp-attr-has-fontSize");
  expect(writeProp.readBack.color, "writeProp-readBack-color").toBe("purple");
  expect(writeProp.readBack.fontSize, "writeProp-readBack-fontSize").toBe("32px");

  const hiddenInfo = await page.evaluate(() => {
    const el = document.getElementById("hide-me");
    const before = el.getBoundingClientRect();
    el.style.display = "none";
    const after = el.getBoundingClientRect();
    const cx = Math.round((before.left + before.right) / 2);
    const cy = Math.round((before.top + before.bottom) / 2);
    const hit = document.elementFromPoint(cx, cy);
    return {
      before: { x: before.left, y: before.top, w: before.width, h: before.height },
      after: { x: after.left, y: after.top, w: after.width, h: after.height },
      hitTagAtOriginalCenter: hit && hit.tagName,
      hitIdAtOriginalCenter: hit && hit.id,
      attr: el.getAttribute("style"),
    };
  });
  console.log("[style] hidden:", hiddenInfo);
  expectStyleMatch(hiddenInfo.attr, /display:\s*none/, "hide-attr-has-display-none");
  expect(hiddenInfo.after.w, "hide-after-rect-zero-width").toBe(0);
  expect(hiddenInfo.after.h, "hide-after-rect-zero-height").toBe(0);
  expect(hiddenInfo.hitIdAtOriginalCenter !== "hide-me", "hide-no-longer-hit").toBeTruthy();

  const cssTextInfo = await page.evaluate(() => {
    const el = document.getElementById("target");
    el.style.cssText = "border: 1px solid red; padding: 4px";
    return {
      attr: el.getAttribute("style"),
      colorGone: el.style.color === "",
      hasBorder: el.style.border,
      hasPadding: el.style.padding,
      cssText: el.style.cssText,
    };
  });
  console.log("[style] cssText:", cssTextInfo);
  expectStyleMatch(cssTextInfo.attr, /color/, "cssText-removes-color", false);
  expectStyleMatch(cssTextInfo.attr, /border/, "cssText-keeps-border");
  expectStyleMatch(cssTextInfo.attr, /padding/, "cssText-keeps-padding");
  expect(cssTextInfo.colorGone, "cssText-color-cleared").toBeTruthy();
  expectStyleMatch(cssTextInfo.cssText, /border/, "cssText-readback");

  const removeInfo = await page.evaluate(() => {
    const el = document.getElementById("target");
    el.style.setProperty("opacity", "0.5");
    const had = el.style.opacity === "0.5";
    const removed = el.style.removeProperty("opacity");
    return { had, removed, after: el.style.opacity, attr: el.getAttribute("style") };
  });
  console.log("[style] remove:", removeInfo);
  expect(removeInfo.had, "setProperty-set").toBeTruthy();
  expect(removeInfo.removed, "removeProperty-returns-prev").toBe("0.5");
  expect(removeInfo.after, "removeProperty-cleared").toBe("");
});
