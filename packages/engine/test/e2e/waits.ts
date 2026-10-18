// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Page } from "@cloudflare/puppeteer";

export async function waitForTitle(
  page: Page,
  expected: string,
  options: { prefix?: boolean; timeout?: number } = {},
): Promise<string> {
  const { prefix = false, timeout = 10_000 } = options;
  await page
    .waitForFunction(
      (wanted: string, startsWith: boolean) =>
        startsWith ? document.title.startsWith(wanted) : document.title === wanted,
      { timeout },
      expected,
      prefix,
    )
    .catch(() => {});
  return page.title();
}
