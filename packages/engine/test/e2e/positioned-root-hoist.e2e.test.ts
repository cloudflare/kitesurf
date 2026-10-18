// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CASES: Record<string, string> = {
  "body-fixed": "body{position:fixed;top:0;left:0}",
  "body-abs": "body{position:absolute;top:0;left:0}",
  "html-abs": "html{position:absolute;top:0;left:0}",
  "html-fixed": "html{position:fixed;top:0;left:0}",
  "html-abs-body-abs": "html{position:absolute;top:0;left:0}body{position:absolute;top:0;left:0}",
  "html-fixed-body-fixed": "html{position:fixed;top:0;left:0}body{position:fixed;top:0;left:0}",
  "html-abs-body-fixed": "html{position:absolute;top:0;left:0}body{position:fixed;top:0;left:0}",
  "html-sticky-body-fixed": "html{position:sticky;top:0}body{position:fixed;top:0;left:0}",
  "html-rel-body-fixed": "html{position:relative}body{position:fixed;top:0;left:0}",
};

for (const [name, css] of Object.entries(CASES)) {
  test(`positioned-root-hoist:${name}`, async ({ page }) => {
    const html = `<!doctype html><html><style>${css}</style><body><div>hoist ${name}</div></body></html>`;
    await page.goto(`data:text/html,${encodeURIComponent(html)}`, {
      timeout: 15000,
    });

    const buf = await page.screenshot({ type: "png" });
    expect([...buf.subarray(0, 8)]).toEqual(PNG_MAGIC);
    expect(buf.length).toBeGreaterThan(500);

    const text = await page.evaluate(() => document.querySelector("div")?.textContent ?? "");
    expect(text).toBe(`hoist ${name}`);
  });
}
