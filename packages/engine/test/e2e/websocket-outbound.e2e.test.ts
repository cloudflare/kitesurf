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
