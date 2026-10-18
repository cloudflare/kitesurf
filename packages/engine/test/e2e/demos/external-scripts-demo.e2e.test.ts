// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("external-scripts-demo", async ({ page }) => {
  const FIXTURE_URL =
    process.env.KITESURF_FIXTURE ?? "http://127.0.0.1:8787/__fixtures/external-scripts.html";

  const messages = [];

  page.on("console", (msg) => {
    messages.push({ type: msg.type(), text: msg.text() });
  });

  await page.goto(FIXTURE_URL, { timeout: 15000 });
  await page
    .waitForFunction(() => (globalThis as any).__ks_order?.length === 5, {
      timeout: 15_000,
    })
    .catch(() => {});

  const order = await page.evaluate(() => globalThis.__ks_order);

  const expected = ["inline-1", "regular", "inline-2", "defer", "async"];
  expect(order, "__ks_order").toStrictEqual(expected);

  const isExternalLog = (m) =>
    m.text.startsWith("[regular.js]") ||
    m.text.startsWith("[defer.js]") ||
    m.text.startsWith("[async.js]");
  await expect
    .poll(() => messages.filter(isExternalLog).length, { timeout: 10_000 })
    .toBe(3)
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 50));
  const externalLogs = messages.filter(isExternalLog).map((m) => m.text);
  expect(externalLogs.length, "console messages from external scripts").toBe(3);
});
