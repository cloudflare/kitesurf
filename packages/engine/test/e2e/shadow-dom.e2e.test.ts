// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import html from "./html/shadow-dom.html?raw";

test("shadow DOM: attach semantics + encapsulation + scoped styles", async ({ page }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  const flags = await page.evaluate(() => (globalThis as any).__ks_shadow);
  expect(flags.litTplChild).toBe(true);
  expect(flags.litTplMarkerData).toBe("?lit$999$");
  expect(flags.litWalk).toBe("e:p|c:?lit$999$");
  expect(flags.litMarkerInRoot).toBe("?lit$999$");
  expect(flags.litCommitted).toBe("beforeCOMMITTED");
  expect(flags).toMatchObject({
    isShadowRoot: true,
    hostLink: true,
    shadowRootProp: true,
    closedHidden: true,
    closedRootUsable: true,
    reattachThrows: true,
    queryHidden: true,
    queryInside: true,
    rootNode: true,
    composedRoot: true,
    serializationHidden: true,
    slotNamed: true,
    slotDefault: true,
    slotBack: true,
    slotEmptyFallback: true,
    retargetInside: true,
    retargetHost: true,
    retargetDoc: true,
    openPathVisible: true,
    composedFalseContained: true,
    closedRetarget: true,
    closedPathHidden: true,
    slottedPathThroughSlot: true,
    slottedNotRetargetedInside: true,
  });

  const slots = await page.evaluate(() => {
    const out = (globalThis as any).__ks_shadow;
    const card: any = document.querySelector("x-card");
    const _rootText = card.shadowRoot.host === card ? card.shadowRoot.textContent || "" : "";
    return {
      slotchangeCount: out.slotchangeCount,
      lateAssigned: card.querySelector("u").assignedSlot !== null,
      fallbackShown: !!card.shadowRoot.querySelector("#fb"),
    };
  });
  expect(slots.slotchangeCount).toBeGreaterThanOrEqual(1);
  expect(slots.lateAssigned).toBe(true);
  expect(slots.fallbackShown).toBe(true);

  const colors = await page.evaluate(() => {
    const host: any = document.getElementById("host");
    const shadowSpan = host.shadowRoot.querySelector("#shadowspan");
    const lightSpan = document.getElementById("lightspan")!;
    return {
      shadow: getComputedStyle(shadowSpan).color,
      light: getComputedStyle(lightSpan).color,
    };
  });
  expect(colors.shadow).toBe("rgb(4, 5, 6)");
  expect(colors.light).toBe("rgb(7, 8, 9)");

  const boxes = await page.evaluate(() => {
    const host: any = document.getElementById("host");
    const box = host.shadowRoot.querySelector(".box").getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    return {
      box: { w: box.width, h: box.height },
      host: { h: hostRect.height },
    };
  });
  expect(boxes.box.w).toBe(120);
  expect(boxes.box.h).toBe(40);
  expect(boxes.host.h).toBeGreaterThanOrEqual(40);
  expect(boxes.host.h).toBeLessThan(200);
});

test("shadow DOM: writes to a slottable survive its slot being freed", async ({ page }) => {
  await setContent(
    page,
    `<div id="host"><span id="s">hi</span></div>
    <script>
      const host = document.getElementById("host");
      const s = document.getElementById("s");
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = "<div><slot></slot></div>";
      s.getBoundingClientRect();
      root.textContent = "";
      let error = null;
      try {
        s.setAttribute("class", "y");
        s.firstChild.data = "changed";
      } catch (e) {
        error = String(e && e.message);
      }
      window.__freedSlot = JSON.stringify({ error, className: s.className, text: s.textContent });
    </script>`,
  );
  expect(await page.evaluate("JSON.parse(window.__freedSlot)")).toEqual({
    error: null,
    className: "y",
    text: "changed",
  });
});
