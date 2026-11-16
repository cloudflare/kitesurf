// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A FontFace the page loads itself registers with layout: after load() and
// document.fonts.add(), text in that family uses the face instead of the
// fallback.
// https://drafts.csswg.org/css-font-loading/#fontface-interface
import { expect, test } from "./harness";

test("a loaded FontFace applies to text", async ({ page }) => {
  await page.goto("http://127.0.0.1:8787/__fixtures/webfont-link.html", { waitUntil: "load" });
  const out = await page.evaluate(async () => {
    const measure = (family: string) => {
      const span = document.createElement("span");
      span.style.cssText = `font: 32px ${family}, sans-serif; display:inline-block`;
      span.textContent = "Hamburgefonstiv WWII";
      document.body.appendChild(span);
      return span;
    };
    const face = new FontFace("KsJsFace", 'url("/__fixtures/bungee.woff2?v=jsface")', {
      weight: "400",
      style: "normal",
    });
    const unloaded = face.status;
    // A face the set knows but that has not loaded is not usable yet.
    document.fonts.add(face);
    const checkBefore = document.fonts.check("32px KsJsFace");
    await face.load();
    const checkAfter = document.fonts.check("32px KsJsFace");
    const cross = measure("KsJsFace");
    const fallback = measure("sans-serif");
    const fallbackWidth = fallback.getBoundingClientRect().width;
    const deadline = Date.now() + 10_000;
    let delta = 0;
    while (delta < 30 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      delta = Math.abs(cross.getBoundingClientRect().width - fallbackWidth);
    }
    return {
      unloaded,
      checkBefore,
      checkAfter,
      status: face.status,
      delta,
      size: document.fonts.size,
      has: document.fonts.has(face),
    };
  });
  expect(out.unloaded).toBe("unloaded");
  expect(out.checkBefore).toBe(false);
  expect(out.checkAfter).toBe(true);
  expect(out.status).toBe("loaded");
  expect(out.delta).toBeGreaterThanOrEqual(30);
  expect(out.size).toBe(1);
  expect(out.has).toBe(true);
}, 60_000);
