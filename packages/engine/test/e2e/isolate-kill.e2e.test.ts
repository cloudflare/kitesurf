// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import type { Page } from "@cloudflare/puppeteer";

async function isolatesKilled(page: Page): Promise<number> {
  const session = await page.createCDPSession();
  const stats = await session.send("Kitesurf.getMemoryStats", {});
  await session.detach().catch(() => {});
  if (typeof stats.isolatesKilled !== "number") {
    throw new Error(`no isolatesKilled in ${JSON.stringify(stats).slice(0, 200)}`);
  }
  return stats.isolatesKilled;
}

test("Target.closeTarget kills the retired isolate after session close", async ({
  browser,
  page,
}) => {
  await setContent(page, "<p>anchor</p>");
  const doomed = await browser.newPage();
  await setContent(doomed, "<p>doomed</p>");
  const before = await isolatesKilled(page);
  await doomed.close();
  expect(await isolatesKilled(page), "closeTarget must reclaim the PageScript isolate").toBe(
    before + 1,
  );
});
