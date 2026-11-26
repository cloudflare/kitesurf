// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A font fetched from another origin applies when that origin allows CORS, as
// a font CDN does. The fetch keeps the CSS Fonts CORS requirement, so a
// response without access-control-allow-origin is still refused.
// https://drafts.csswg.org/css-fonts/#font-fetching-requirements
import { expect, test } from "./harness";

test("a cross-origin @font-face with CORS applies", async ({ page }) => {
  await page.goto("http://127.0.0.1:8787/__fixtures/webfont-link.html", { waitUntil: "load" });
  const out = await page.evaluate(async () => {
    const style = document.createElement("style");
    style.textContent =
      '@font-face { font-family: KsCrossCdn; src: url("https://ks.invalid/__fixtures/bungee.woff2?v=cross") format("woff2"); }';
    document.head.appendChild(style);
    const measure = (family: string) => {
      const span = document.createElement("span");
      span.style.cssText = `font: 32px ${family}, sans-serif; display:inline-block`;
      span.textContent = "Hamburgefonstiv WWII";
      document.body.appendChild(span);
      return span;
    };
    const cross = measure("KsCrossCdn");
    const fallback = measure("sans-serif");
    const fallbackWidth = fallback.getBoundingClientRect().width;
    const deadline = Date.now() + 10_000;
    let delta = 0;
    while (delta < 30 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      delta = Math.abs(cross.getBoundingClientRect().width - fallbackWidth);
    }
    return { delta, status: document.fonts.status };
  });
  expect(out.delta).toBeGreaterThanOrEqual(30);
  expect(out.status).toBe("loaded");
}, 60_000);
