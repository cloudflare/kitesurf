// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

const FIXTURE = "https://ks.invalid/__fixtures/fetch-priority-probe.html";

test("a late body stylesheet is admitted ahead of queued tarpit images", async ({
  page,
  cdpSession,
}) => {
  const order: string[] = [];
  cdpSession.on("Network.requestWillBeSent", (ev: { request?: { url?: string } }) => {
    const u = ev.request?.url ?? "";
    if (u.includes("slow-headers-red.png") || u.includes("probe-late.css")) {
      order.push(u);
    }
  });
  await cdpSession.send("Network.enable", {});

  await page.goto(FIXTURE, { waitUntil: "load", timeout: 30000 });

  expect(order.length).toBe(9);
  const cssIndex = order.findIndex((u) => u.includes("probe-late.css"));
  expect(cssIndex).toBeLessThanOrEqual(5);

  const color = await page.evaluate(`
    getComputedStyle(document.getElementById("probe")).color
  `);
  expect(color).toBe("rgb(0, 128, 0)");
});
