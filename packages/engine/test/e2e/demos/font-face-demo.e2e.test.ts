// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { setTimeout as sleep } from "node:timers/promises";

import { expect, test } from "../harness";

test("font-face-demo", async ({ browser }) => {
  const FIXTURE_URL = "http://127.0.0.1:8787/__fixtures/font-face.html";
  const WOFF2_URL = "http://127.0.0.1:8787/__fixtures/bungee.woff2";

  const fetches = [];
  const pages = await browser.pages();
  const page = pages[0] ?? (await browser.newPage());
  const cdp = await page.createCDPSession();
  await cdp.send("Network.enable");
  cdp.on("Network.requestWillBeSent", (e) => {
    if (e.request.url.includes(".woff2") || e.type === "Font") {
      fetches.push({
        phase: "willBeSent",
        url: e.request.url,
        type: e.type,
        initiator: e.initiator?.type,
      });
    }
  });
  cdp.on("Network.responseReceived", (e) => {
    if (e.response.url.includes(".woff2") || e.type === "Font") {
      fetches.push({
        phase: "responseReceived",
        url: e.response.url,
        status: e.response.status,
        mimeType: e.response.mimeType,
        type: e.type,
      });
    }
  });
  cdp.on("Network.loadingFailed", (e) => {
    fetches.push({
      phase: "loadingFailed",
      type: e.type,
      errorText: e.errorText,
      canceled: e.canceled,
    });
  });

  await page.goto(FIXTURE_URL, { waitUntil: "load" });

  const fontDeadline = Date.now() + 15000;
  while (
    !fetches.some((f) => f.phase === "responseReceived" && f.url === WOFF2_URL) &&
    Date.now() < fontDeadline
  ) {
    await sleep(10);
  }
  await page.evaluate(async () => {
    await document.fonts.ready;
  });

  const metrics = await page.evaluate(() => {
    const t = document.getElementById("target");
    const c = document.getElementById("control");
    const tr = t.getBoundingClientRect();
    const cr = c.getBoundingClientRect();
    return {
      target: { width: tr.width, height: tr.height, text: t.textContent },
      control: { width: cr.width, height: cr.height, text: c.textContent },
      widthDelta: tr.width - cr.width,
    };
  });

  console.log("[font] metrics:", JSON.stringify(metrics, null, 2));
  console.log("[font] network events:", JSON.stringify(fetches, null, 2));

  expect(
    metrics.target.width > 0 && metrics.control.width > 0,
    `both paragraphs rendered: target=${metrics.target.width} control=${metrics.control.width}`,
  ).toBeTruthy();

  const willBeSent = fetches.find((f) => f.phase === "willBeSent" && f.url === WOFF2_URL);
  expect(
    willBeSent !== undefined,
    `woff2 fetch was queued: events=${JSON.stringify(fetches)}`,
  ).toBeTruthy();
  if (willBeSent) {
    expect(
      willBeSent.type === "Font",
      `woff2 fetch type=Font: got type=${willBeSent.type}`,
    ).toBeTruthy();
  }

  const responseReceived = fetches.find(
    (f) => f.phase === "responseReceived" && f.url === WOFF2_URL,
  );
  expect(
    responseReceived !== undefined && responseReceived.status === 200,
    `woff2 response arrived: got ${JSON.stringify(responseReceived)}`,
  ).toBeTruthy();

  expect(
    Math.abs(metrics.widthDelta) >= 30,
    `text reshaped against fetched font (widthDelta >= 30px): widthDelta=${metrics.widthDelta} (target=${metrics.target.width}, control=${metrics.control.width}) — both paragraphs rendered at similar widths, indicating the @font-face src was dropped or the font failed to register`,
  ).toBeTruthy();
});
