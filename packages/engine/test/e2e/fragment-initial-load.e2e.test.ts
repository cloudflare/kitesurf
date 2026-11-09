// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A URL fragment must scroll its target into view on initial load, before
// DOMContentLoaded, as a deep link does in Chrome.
// https://html.spec.whatwg.org/multipage/browsing-the-web.html#scroll-to-the-fragment-identifier
import { expect, test } from "./harness";

const html = `<!doctype html><html><body>
<div style="height:2000px"></div>
<div id="target" style="height:100px">target</div>
</body></html>`;

test("an initial URL fragment scrolls its target into view", async ({ page }) => {
  await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}#target`, {
    waitUntil: "load",
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const report = (await page.evaluate(() => {
    const target = document.getElementById("target");
    return JSON.stringify({
      hash: location.hash,
      scrollY: window.scrollY,
      targetTop: target ? target.getBoundingClientRect().top : -1,
    });
  })) as string;
  const parsed = JSON.parse(report) as { hash: string; scrollY: number; targetTop: number };
  expect(parsed.hash).toBe("#target");
  expect(parsed.scrollY).toBeGreaterThan(0);
  expect(parsed.targetTop).toBeGreaterThanOrEqual(0);
  expect(parsed.targetTop).toBeLessThan(900);
}, 60_000);
