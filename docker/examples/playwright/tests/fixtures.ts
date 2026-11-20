// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Replaces Playwright's launched browser with a connection to the Kitesurf engine.

import { test as base } from "@playwright/test";

export { expect } from "@playwright/test";

export const KITESURF_WS = process.env.KITESURF_WS ?? "ws://127.0.0.1:8787/devtools/browser";
// The engine runs in a container, so the app's address is the one that the container can reach.
export const APP_URL = process.env.APP_URL ?? "http://host.docker.internal:3000/";

export const test = base.extend({
  browser: [
    async ({ playwright }, use) => {
      const browser = await playwright.chromium.connectOverCDP(KITESURF_WS);
      await use(browser);
      await browser.close();
    },
    { scope: "worker" },
  ],
  // The engine's single default context; clear its cookies so tests do not share a session.
  context: async ({ browser }, use) => {
    const [context] = browser.contexts();
    if (!context) throw new Error("the engine has no default browser context");
    await use(context);
    await context.clearCookies();
  },
  page: async ({ context }, use) => {
    const page = await context.newPage();
    await use(page);
    await page.close();
  },
});
