// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Page } from "@cloudflare/puppeteer";

import { expect, test } from "./harness";

const PUBLIC_PAGE = "https://ks.invalid/__fixtures/echo-headers.html";
const LOOPBACK_PAGE = "http://127.0.0.1:8787/__fixtures/echo-headers.html";
const LOOPBACK_JSON = "http://127.0.0.1:8787/__fixtures/echo-headers.json";

const status = (page: Page, url: string) =>
  page.evaluate(
    `fetch(${JSON.stringify(url)}, { mode: "no-cors" }).then((r) => r.type === "opaque" ? 0 : r.status, () => "failed")`,
  );

test("a public page cannot reach a loopback address, directly or through a redirect", async ({
  page,
}) => {
  await page.goto(PUBLIC_PAGE, { waitUntil: "load" });
  expect(await status(page, "https://ks.invalid/__fixtures/echo-headers.json")).toBe(200);
  expect(await status(page, LOOPBACK_JSON)).toBe("failed");
  const viaRedirect = `https://ks.invalid/__fixtures/cors-redirect?to=${encodeURIComponent(LOOPBACK_JSON)}`;
  expect(await status(page, viaRedirect)).toBe("failed");
  const ws = await page.evaluate(`new Promise((resolve) => {
    const s = new WebSocket("ws://127.0.0.1:8787/devtools/browser/kitesurf");
    s.onopen = () => { s.close(); resolve("open"); };
    s.onerror = () => resolve("error");
  })`);
  expect(ws).toBe("error");
});

test("a loopback page still reaches its own loopback origin", async ({ page }) => {
  await page.goto(LOOPBACK_PAGE, { waitUntil: "load" });
  expect(await status(page, LOOPBACK_JSON)).toBe(200);
});

test("a public page cannot navigate itself to a loopback address", async ({ page }) => {
  await page.goto(PUBLIC_PAGE, { waitUntil: "load" });
  const status = new Promise<number>((resolve) => {
    page.on("response", (response) => {
      if (response.url().includes("127.0.0.1:8787")) resolve(response.status());
    });
    setTimeout(() => resolve(0), 4000);
  });
  // The navigation destroys the evaluate context before it replies, so its failure is expected.
  await page.evaluate(`location.href = ${JSON.stringify(LOOPBACK_PAGE)}`).catch(() => {});
  expect(await status).toBe(403);
});
