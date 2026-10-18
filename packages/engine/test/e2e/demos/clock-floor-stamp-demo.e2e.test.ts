// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { setTimeout as sleep } from "node:timers/promises";

import { expect, test } from "../harness";

test("clock-floor-stamp-demo", async ({ page }) => {
  const session = await page.target().createCDPSession();
  const tree = await session.send("Page.getFrameTree");
  await session.send("Page.setDocumentContent", {
    frameId: tree.frameTree.frame.id,
    html: "<!doctype html><html><body>clock</body></html>",
  });
  await sleep(50);

  const read1 = await page.evaluate(
    () => (globalThis as { __ks_clock_floor_ms?: number }).__ks_clock_floor_ms,
  );
  expect(typeof read1, "floor must be stamped by the first message").toBe("number");
  expect(read1!).toBeGreaterThan(Date.now() - 5 * 60_000);
  expect(read1!).toBeLessThanOrEqual(Date.now() + 5_000);

  await sleep(300);
  const read2 = await page.evaluate(
    () => (globalThis as { __ks_clock_floor_ms?: number }).__ks_clock_floor_ms,
  );
  expect(read2!).toBeGreaterThan(read1!);
});
