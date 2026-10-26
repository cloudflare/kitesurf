// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { setTimeout as sleep } from "node:timers/promises";

import { expect, test } from "../harness";

// Runs in the page: puppeteer serializes it, so it can't close over imports.
function readClockFloor(): number | undefined {
  const internals: unknown = Reflect.get(globalThis, Symbol.for("kitesurf.internals"));
  if (typeof internals !== "object" || internals === null) return undefined;
  const floor: unknown = Reflect.get(internals, "clockFloorMs");
  return typeof floor === "number" ? floor : undefined;
}

test("clock-floor-stamp-demo", async ({ page }) => {
  const session = await page.target().createCDPSession();
  const tree = await session.send("Page.getFrameTree");
  await session.send("Page.setDocumentContent", {
    frameId: tree.frameTree.frame.id,
    html: "<!doctype html><html><body>clock</body></html>",
  });
  await sleep(50);

  const read1 = await page.evaluate(readClockFloor);
  expect(typeof read1, "floor must be stamped by the first message").toBe("number");
  expect(read1!).toBeGreaterThan(Date.now() - 5 * 60_000);
  expect(read1!).toBeLessThanOrEqual(Date.now() + 5_000);

  await sleep(300);
  const read2 = await page.evaluate(readClockFloor);
  expect(read2!).toBeGreaterThan(read1!);
});
