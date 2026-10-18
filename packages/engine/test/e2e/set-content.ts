// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Page } from "@cloudflare/puppeteer";

export interface SetContentOptions {
  waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
  timeout?: number;
}

export async function setContent(
  page: Page,
  html: string,
  options: SetContentOptions = {},
): Promise<void> {
  await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`, {
    waitUntil: options.waitUntil ?? "load",
    timeout: options.timeout ?? 15_000,
  });
}
