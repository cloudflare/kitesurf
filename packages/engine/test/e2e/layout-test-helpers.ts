// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Page } from "@cloudflare/puppeteer";

import { setContent } from "./set-content";

export async function loadLayoutPage(page: Page, html: string): Promise<void> {
  await page.setViewport({ width: 800, height: 600 });
  await setContent(page, html, { waitUntil: "domcontentloaded" });
}
