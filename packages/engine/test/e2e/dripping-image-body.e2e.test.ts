// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Page } from "@cloudflare/puppeteer";

import { expect, test } from "./harness";
import { setContent } from "./set-content";

async function expectCutAtDeadline(page: Page, file: string): Promise<void> {
  const t0 = Date.now();
  await setContent(
    page,
    `<!doctype html><title>t</title><p>text</p>` +
      `<img id="i" src="https://ks-other.invalid/__fixtures/${file}?ms=45000">`,
    { timeout: 60_000 },
  );
  const settled = (await page.evaluate(`new Promise((r) => {
    const i = document.getElementById("i");
    if (i.complete) return r("complete");
    i.onload = () => r("load");
    i.onerror = () => r("error");
  })`)) as string;
  const elapsed = Date.now() - t0;
  expect(["complete", "load", "error"]).toContain(settled);
  expect(elapsed).toBeLessThan(25_000);

  const t1 = Date.now();
  expect(await page.evaluate("1 + 1")).toBe(2);
  expect(Date.now() - t1).toBeLessThan(3_000);
}

test("a dribbling image body is cut at the deadline and the page stays reachable", async ({
  page,
}) => {
  await expectCutAtDeadline(page, "dripping-red.png");
}, 120_000);

test("a dribbling SVG image body is cut at the deadline too", async ({ page }) => {
  await expectCutAtDeadline(page, "dripping-red.svg");
}, 120_000);
