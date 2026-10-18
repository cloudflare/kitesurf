// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const MARKUP = `<div id="t">x</div>
<script>
  const el = document.getElementById("t");
  const cs = (p) => getComputedStyle(el)[p];
  const out = {};

  // 1. String setter drops the scratch: cssText and reads follow the attribute.
  el.style["transition-delay"] = "1ms";
  el.style = "";
  out.cssTextAfterStringSetter = el.style.cssText;
  out.attrAfterStringSetter = el.getAttribute("style");
  // A property write after the reset must not bring transition-delay back.
  el.style.rotate = "1deg";
  out.attrAfterWrite = el.getAttribute("style");
  out.rotateAfterWrite = cs("rotate");
  el.style.rotate = "hypot(1grad)";
  out.rotateAfterSecondWrite = cs("rotate");

  // 2. setAttribute("style", …) replaces the block; reads see the new text.
  el.setAttribute("style", "color: rgb(1, 2, 3); margin-left: 7px");
  out.colorAfterSetAttribute = el.style.color;
  out.marginAfterSetAttribute = el.style.marginLeft;
  out.rotateAfterSetAttribute = el.style.rotate;
  el.style.marginLeft = "9px";
  out.attrAfterSetAttributeWrite = el.getAttribute("style");

  // 3. removeAttribute("style") empties the block; an invalid value written
  //    next has nothing stale to fall back to.
  el.style.zIndex = "11";
  el.removeAttribute("style");
  out.lengthAfterRemove = el.style.length;
  el.style.setProperty("z-index", "1e1");
  out.zIndexAfterInvalidWrite = cs("z-index");
  out.attrAfterInvalidWrite = el.getAttribute("style");

  window.__out = out;
</script>`;

test("inline style proxy follows the style content attribute", async ({ page }) => {
  await setContent(page, MARKUP);
  const r = await page.evaluate(
    () => (window as typeof window & { __out: Record<string, unknown> }).__out,
  );

  expect(r.cssTextAfterStringSetter).toBe("");
  expect(r.attrAfterStringSetter).toBe("");
  expect(r.attrAfterWrite).toBe("rotate: 1deg;");
  expect(r.rotateAfterWrite).toBe("1deg");
  expect(r.rotateAfterSecondWrite).toBe("0.9deg");

  expect(r.colorAfterSetAttribute).toBe("rgb(1, 2, 3)");
  expect(r.marginAfterSetAttribute).toBe("7px");
  expect(r.rotateAfterSetAttribute).toBe("");
  expect(r.attrAfterSetAttributeWrite).not.toContain("rotate");
  expect(r.attrAfterSetAttributeWrite).toContain("margin-left: 9px");
  expect(r.attrAfterSetAttributeWrite).toContain("color: rgb(1, 2, 3)");

  expect(r.lengthAfterRemove).toBe(0);
  expect(r.zIndexAfterInvalidWrite).toBe("auto");
  expect(r.attrAfterInvalidWrite ?? "").not.toContain("z-index");
});
