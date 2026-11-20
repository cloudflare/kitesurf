// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

import { setContent } from "./set-content";

const PAGE = "<!doctype html><html><body><p>pre-nav scope</p></body></html>";
const SEED = "globalThis.__ks_pre_nav_owner = 'owner';";
const readOwner = (): string | null =>
  (globalThis as { __ks_pre_nav_owner?: string }).__ks_pre_nav_owner ?? null;

test("a session-scoped pre-nav script runs on its target and dies with it", async ({
  page,
  browser,
  cdpSession,
}) => {
  const { identifier } = await cdpSession.send("Page.addScriptToEvaluateOnNewDocument", {
    source: SEED,
  });

  await setContent(page, PAGE);
  expect(await page.evaluate(readOwner)).toBe("owner");
  await setContent(page, PAGE);
  expect(await page.evaluate(readOwner)).toBe("owner");

  await cdpSession.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  await setContent(page, PAGE);
  expect(await page.evaluate(readOwner)).toBe(null);

  // A script still registered on this target must not reach a different target.
  await cdpSession.send("Page.addScriptToEvaluateOnNewDocument", { source: SEED });
  const other = await browser.newPage();
  try {
    await setContent(other, PAGE);
    expect(await other.evaluate(readOwner)).toBe(null);
  } finally {
    await other.close();
  }
});
