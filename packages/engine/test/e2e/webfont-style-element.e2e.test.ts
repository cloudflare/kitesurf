// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A <style> element that declares @font-face has its faces fetched, exactly as
// a linked sheet does. Pages that inline or script-insert their webfonts kept
// the fallback metrics.
// https://drafts.csswg.org/css-fonts/#font-face-rule
import { expect, test } from "./harness";

test("an @font-face in a script-inserted style element applies", async ({ page }) => {
  await page.goto("http://127.0.0.1:8787/__fixtures/webfont-link.html", { waitUntil: "load" });
  const out = await page.evaluate(async () => {
    const style = document.createElement("style");
    style.textContent = `@font-face { font-family: KsInlineSame; src: url("/__fixtures/bungee.woff2?v=inline") format("woff2"); }`;
    document.head.appendChild(style);
    const measure = (family: string) => {
      const span = document.createElement("span");
      span.style.cssText = `font: 32px ${family}, sans-serif; display:inline-block`;
      span.textContent = "Hamburgefonstiv WWII";
      document.body.appendChild(span);
      return span;
    };
    const same = measure("KsInlineSame");
    const fallback = measure("sans-serif");
    const fallbackWidth = fallback.getBoundingClientRect().width;
    const deadline = Date.now() + 10_000;
    let delta = 0;
    while (delta < 30 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      delta = Math.abs(same.getBoundingClientRect().width - fallbackWidth);
    }
    return { delta, status: document.fonts.status };
  });
  expect(out.delta).toBeGreaterThanOrEqual(30);
  expect(out.status).toBe("loaded");
}, 60_000);
