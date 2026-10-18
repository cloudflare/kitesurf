// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { env } from "cloudflare:test";
import { test as base } from "vitest";
import type { Browser, CDPSession, Page } from "@cloudflare/puppeteer";

import { connectEngine } from "./connect";

export { expect } from "vitest";

type EngineBinding = Cloudflare.Env["ENGINE"];

export const engine = env.ENGINE;

export interface BrowserOptions {
  headers?: Record<string, string>;
  query?: string;
  engine?: EngineBinding;
}

export type BrowserFactory = (options?: BrowserOptions) => Promise<Browser>;

export const test = base.extend<{
  browserFactory: BrowserFactory;
  browser: Browser;
  page: Page;
  cdpSession: CDPSession;
}>({
  browserFactory: async ({}, use) => {
    const browsers: Browser[] = [];
    try {
      await use(async ({ headers, query, engine } = {}) => {
        const browser = await connectEngine(engine ?? env.ENGINE, headers, query);
        browsers.push(browser);
        return browser;
      });
    } finally {
      await Promise.all(
        browsers.map((browser) => (browser.connected ? browser.disconnect() : undefined)),
      );
    }
  },
  browser: async ({ browserFactory }, use) => {
    await use(await browserFactory());
  },
  page: async ({ browser }, use) => {
    const page = (await browser.pages())[0] ?? (await browser.newPage());
    try {
      await use(page);
    } finally {
      await page.close();
    }
  },
  cdpSession: async ({ page }, use) => {
    const session = await page.createCDPSession();
    try {
      await use(session);
    } finally {
      await session.detach();
    }
  },
});
