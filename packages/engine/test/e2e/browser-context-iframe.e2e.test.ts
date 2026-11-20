// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

const FRAME_ORIGIN = "https://ks-other.invalid";

test("an out-of-process iframe uses its browser context's cookies", async ({ browser }) => {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const cdp = await page.createCDPSession();
  await cdp.send("Storage.setCookies", {
    browserContextId: context.id,
    cookies: [
      {
        name: "who",
        value: "context",
        domain: "ks-other.invalid",
        path: "/",
        secure: true,
        sameSite: "None",
      },
    ],
  });
  const contexts: number[] = [];
  cdp.on("Runtime.executionContextCreated", (e) => {
    if (e.context.origin === FRAME_ORIGIN) contexts.push(e.context.id);
  });
  await cdp.send("Runtime.enable");
  await page.goto("https://ks.invalid/__fixtures/lifecycle.html", { waitUntil: "load" });
  await page.evaluate((src) => {
    const f = document.createElement("iframe");
    f.src = src;
    document.body.appendChild(f);
  }, `${FRAME_ORIGIN}/__fixtures/lifecycle.html`);
  await expect.poll(() => contexts.length, { timeout: 15_000 }).toBeGreaterThan(0);

  const r = await cdp.send("Runtime.evaluate", {
    contextId: contexts[0],
    expression: `fetch("/__fixtures/echo-headers.json", { credentials: "include" })
      .then((r) => r.json()).then((h) => h.cookie ?? "")`,
    awaitPromise: true,
    returnByValue: true,
  });
  expect(r.result.value).toBe("who=context");
  await context.close();
}, 60_000);
