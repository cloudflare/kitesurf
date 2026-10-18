// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import expectedCss from "../../fixtures-worker/assets/external-sheet.css?raw";

test("network-stylesheet-headers-demo", async ({ page }) => {
  const FIXTURE_URL = "http://127.0.0.1:8787/__fixtures/external-sheet.html";
  const SHEET_URL = "http://127.0.0.1:8787/__fixtures/external-sheet.css";

  const session = await page.target().createCDPSession();

  let cssRequest = null;
  let cssFinished = false;
  session.on("Network.requestWillBeSent", (p) => {
    if (p.request.url === SHEET_URL) cssRequest = p;
  });
  session.on("Network.loadingFinished", (p) => {
    if (cssRequest && p.requestId === cssRequest.requestId) cssFinished = true;
  });

  await session.send("Network.enable");
  await session.send("Page.navigate", { url: FIXTURE_URL });
  await expect.poll(() => !!cssRequest && cssFinished, { timeout: 10_000 }).toBe(true);

  expect(cssRequest, "captured Network.requestWillBeSent for the stylesheet").toBeTruthy();

  const headers = cssRequest.request.headers;
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;

  const kitesurfKeys = Object.keys(lower).filter((k) => k.startsWith("x-kitesurf-"));
  expect(
    kitesurfKeys.length === 0,
    `no x-kitesurf-* headers leak into Network.requestWillBeSent (leaked: ${JSON.stringify(kitesurfKeys)})`,
  ).toBeTruthy();

  expect(
    typeof lower["user-agent"] === "string" && lower["user-agent"].includes("Mozilla"),
    "user-agent header is set to a real browser-shaped UA",
  ).toBeTruthy();
  expect(lower["accept"], "accept header is the stylesheet-specific value").toBe(
    "text/css,*/*;q=0.1",
  );
  expect(
    typeof lower["accept-language"] === "string" && lower["accept-language"].length > 0,
    "accept-language header is set",
  ).toBeTruthy();
  expect(
    typeof lower["referer"] === "string" && lower["referer"].includes("127.0.0.1:8787"),
    "referer header is set to the document origin",
  ).toBeTruthy();

  const body = await session.send("Network.getResponseBody", {
    requestId: cssRequest.requestId,
  });
  expect(
    typeof body.body === "string" && body.body.length > 0,
    "Network.getResponseBody returns non-empty body",
  ).toBeTruthy();
  expect(body.body, "body matches the fixture CSS verbatim").toBe(expectedCss);
  expect(body.base64Encoded, "base64Encoded is false (text response)").toBe(false);
});
