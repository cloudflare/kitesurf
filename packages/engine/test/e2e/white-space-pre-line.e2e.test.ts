// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

const HTML = `<!doctype html><html><body style="margin:20px;font:16px/20px sans-serif">
<a id="pill" style="display:inline-flex;align-items:center;justify-content:center;padding:12px 24px;border:1px solid #000;border-radius:9999px">
<span id="label" style="white-space:pre-line"> Start building for free </span></a>
</body></html>`;

test("pre-line collapses edge spaces instead of wrapping snug labels", async ({ page }) => {
  await page.goto(`data:text/html,${encodeURIComponent(HTML)}`, { timeout: 15000 });
  const r = JSON.parse(
    (await page.evaluate(`(() => {
      const a = document.getElementById('pill').getBoundingClientRect();
      const s = document.getElementById('label').getBoundingClientRect();
      return JSON.stringify({ pill: Math.round(a.height), label: Math.round(s.height) });
    })()`)) as string,
  ) as { pill: number; label: number };
  expect(r.label, "label is a single line").toBeLessThanOrEqual(20);
  expect(r.pill, "pill height").toBeLessThanOrEqual(48);
});
