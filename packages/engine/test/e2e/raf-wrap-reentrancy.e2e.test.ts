// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

test("boa-wrapped requestAnimationFrame fires instead of re-entering", async ({ page }) => {
  await page.goto("http://127.0.0.1:8787/__fixtures/dynprobe-raf.html", {
    waitUntil: "load",
    timeout: 30000,
  });
  await page
    .waitForFunction(() => document.getElementById("results")?.getAttribute("data-done") === "1", {
      timeout: 30_000,
    })
    .catch(() => {});
  const done = await page
    .evaluate(() => document.getElementById("results")?.getAttribute("data-done") ?? "0")
    .catch(() => "0");
  expect(done, "raf probe settled (data-done)").toBe("1");
  const out = JSON.parse(
    await page.evaluate(() => document.getElementById("results")?.textContent ?? "{}"),
  ) as { raf: string; status: string };
  expect(out.status, `raf callback ran (raf=${out.raf})`).toBe("raf-fired");
  expect(out.raf).toBe("ok");
});
