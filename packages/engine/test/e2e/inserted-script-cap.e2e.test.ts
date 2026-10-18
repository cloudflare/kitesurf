// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// The byte budget applies only after a fetch and unique URLs pass the dedupe, so a count cap
// is what bounds the fetches one page starts; it sits far past any real chunk graph.
import { expect, test } from "./harness";
import { setContent } from "./set-content";

const CAP = 1024;
const EXTRA = 6;

test("inserted external scripts stop at the per-navigate cap", async ({ page }) => {
  const skipped: string[] = [];
  page.on("console", (m) => {
    if (m.text().includes("[ks-inserted-script] budget: skipping")) skipped.push(m.text());
  });
  await setContent(
    page,
    `<!doctype html><title>t</title><script>
      window.__ran = 0;
      window.__loaded = 0;
      for (var i = 0; i < ${CAP + EXTRA}; i++) {
        var s = document.createElement("script");
        s.src = "data:text/javascript,window.__ran%2B%2B//" + i;
        s.onload = function () { window.__loaded++; };
        document.head.appendChild(s);
      }
    </script>`,
  );
  await page.waitForFunction(
    (cap: number) => Reflect.get(globalThis, "__loaded") === cap,
    { timeout: 90_000 },
    CAP,
  );
  await expect.poll(() => skipped.length, { timeout: 10_000 }).toBe(EXTRA);
  expect(await page.evaluate(() => Reflect.get(globalThis, "__ran"))).toBe(CAP);
}, 120_000);
