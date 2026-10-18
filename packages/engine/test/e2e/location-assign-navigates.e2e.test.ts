// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

const FROM = "https://ks.invalid/__fixtures/events.html";
const TO = "https://ks.invalid/__fixtures/keyboard.html";
const LOOP = "https://ks.invalid/__fixtures/reload-loop.html";
type LocationPageGlobal = typeof globalThis & { __ks_realm?: string };

test("location.assign refetches the document, not just the URL", async ({ page }) => {
  await page.goto(FROM, { waitUntil: "domcontentloaded" });

  await page.evaluate(() => {
    (globalThis as LocationPageGlobal).__ks_realm = "first";
  });
  // Limitation: if navigation retires this isolate, evaluation rejects; Chrome returns undefined.
  await page
    .evaluate((to: string) => location.assign(to), TO)
    .catch((e: Error) => expect(String(e)).toMatch(/Execution context was destroyed/));

  await page
    .waitForFunction(() => !!document.querySelector("#i"), { timeout: 15_000 })
    .catch(() => {});
  const landed = await page.evaluate(() => ({
    url: location.href,
    hasInput: !!document.querySelector("#i"),
    h1: document.querySelector("h1")?.textContent?.trim() || "",
    realm: (globalThis as LocationPageGlobal).__ks_realm ?? "(fresh)",
  }));
  expect(landed.url).toBe(TO);
  expect(landed.hasInput).toBe(true);
  expect(landed.h1).toBe("keyboard");
  expect(landed.realm).toBe("(fresh)");

  await page
    .evaluate((from: string) => {
      location.href = from;
    }, FROM)
    .catch(() => {});
  await page
    .waitForFunction(() => !document.querySelector("#i"), { timeout: 15_000 })
    .catch(() => {});
  expect(await page.evaluate(() => location.href)).toBe(FROM);
  expect(await page.evaluate(() => !!document.querySelector("#i"))).toBe(false);
}, 120_000);

test("location.reload() refetches the same URL", async ({ page }) => {
  await page.goto(TO, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    (globalThis as LocationPageGlobal).__ks_realm = "first";
  });

  await page.evaluate(() => location.reload()).catch(() => {});
  await page
    .waitForFunction(() => (globalThis as LocationPageGlobal).__ks_realm === undefined, {
      timeout: 15_000,
    })
    .catch(() => {});
  expect(
    await page.evaluate(() => ({
      url: location.href,
      realm: (globalThis as LocationPageGlobal).__ks_realm ?? "(fresh)",
      hasInput: !!document.querySelector("#i"),
    })),
  ).toEqual({ url: TO, realm: "(fresh)", hasInput: true });
}, 120_000);

test("a self-reload loop is capped and leaves the last document live", async ({
  page,
  cdpSession: cdp,
}) => {
  await cdp.send("Network.enable");
  let documentLoads = 0;
  cdp.on("Network.requestWillBeSent", (e) => {
    const ev = e as { request: { url: string }; type?: string };
    if (ev.type === "Document" && ev.request.url === LOOP) documentLoads++;
  });

  await page.goto(LOOP, { waitUntil: "domcontentloaded" }).catch(() => {});

  let stableFor = 0;
  let last = -1;
  for (let waited = 0; waited < 60_000 && stableFor < 5_000; waited += 500) {
    await new Promise((r) => setTimeout(r, 500));
    stableFor = documentLoads === last ? stableFor + 500 : 0;
    last = documentLoads;
  }

  expect(documentLoads).toBe(4);

  expect(await page.evaluate(() => document.querySelector("#hdr")?.textContent ?? "")).toBe(
    "reload-loop",
  );
}, 120_000);

test("a hash-only location write stays same-document", async ({ page }) => {
  await page.goto(FROM, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    (globalThis as LocationPageGlobal).__ks_realm = "first";
  });

  await page.evaluate(() => {
    location.hash = "#frag";
  });
  const after = await page.evaluate(() => ({
    hash: location.hash,
    realm: (globalThis as LocationPageGlobal).__ks_realm ?? "(fresh)",
  }));
  expect(after).toEqual({ hash: "#frag", realm: "first" });
}, 120_000);
