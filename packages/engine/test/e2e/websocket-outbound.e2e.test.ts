// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Page } from "@cloudflare/puppeteer";
import { expect, test } from "./harness";

const PAGE = "https://ks.invalid/__fixtures/lifecycle.html";

function openSocket(page: Page, path: string): Promise<string> {
  return page.evaluate(
    (url) =>
      new Promise<string>((resolve) => {
        const ws = new WebSocket(url);
        ws.onmessage = (e) => {
          resolve(String(e.data));
          ws.close();
        };
        ws.onopen = () => ws.send("ping");
        ws.onerror = () => resolve("error");
        setTimeout(() => resolve("timeout"), 10_000);
      }),
    "wss://ks.invalid/__fixtures/" + path,
  );
}

test("a websocket resource-type filter blocks the page's sockets", async ({ page, cdpSession }) => {
  await page.goto(PAGE, { waitUntil: "load" });
  expect(await openSocket(page, "ws-echo")).toBe("echo:ping");
  await cdpSession.send("Kitesurf.setOutboundFilters", { rejectResourceTypes: ["websocket"] });
  expect(await openSocket(page, "ws-echo")).toBe("error");
}, 30_000);

test("a websocket handshake always carries the document's origin and a user agent", async ({
  page,
}) => {
  await page.goto(PAGE, { waitUntil: "load" });
  expect(JSON.parse(await openSocket(page, "ws-handshake"))).toEqual({
    origin: "https://ks.invalid",
    userAgent: expect.any(String),
  });

  // Page script can reach the platform fetch and set the engine's request headers itself.
  const forged = await page.evaluate(`(async () => {
    const platformFetch = Object.getPrototypeOf(globalThis).fetch;
    if (typeof platformFetch !== "function") return "no platform fetch";
    const resp = await platformFetch.call(globalThis, "https://ks.invalid/__fixtures/ws-handshake", {
      headers: { Upgrade: "websocket", "x-kitesurf-page-origin": "null" },
    });
    const ws = resp.webSocket;
    if (!ws) return "no socket: " + resp.status;
    return await new Promise((resolve) => {
      ws.addEventListener("message", (e) => resolve(String(e.data)));
      ws.accept();
    });
  })()`);
  expect(JSON.parse(String(forged))).toEqual({
    origin: "https://ks.invalid",
    userAgent: expect.any(String),
  });
}, 30_000);
