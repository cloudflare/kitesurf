// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Page } from "@cloudflare/puppeteer";

import { expect, test } from "./harness";

const FIXTURE = "https://ks.invalid/__fixtures/font-face-unicode-range.html";

async function fetchedFonts(page: Page) {
  const cdp = await page.createCDPSession();
  await cdp.send("Network.enable");
  const fonts = new Set<string>();
  cdp.on("Network.requestWillBeSent", (e) => {
    const u = (e as { request: { url: string } }).request.url;
    if (/\.woff2$/.test(u)) fonts.add(u.replace(/^.*\/__fixtures\//, ""));
  });
  return fonts;
}

async function waitFor(pred: () => boolean, ms: number) {
  const deadline = Date.now() + ms;
  while (!pred() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

test("only the subsets covering the page's text are fetched", async ({ page }) => {
  const fonts = await fetchedFonts(page);
  await page.goto(FIXTURE, { waitUntil: "load" });
  await waitFor(() => fonts.size >= 2, 5_000);
  await new Promise((r) => setTimeout(r, 800));

  expect(fonts.has("bungee.woff2")).toBe(true);
  expect(fonts.has("noto-cyrillic-subset.woff2")).toBe(true);
  expect(fonts.has("noto-greek-subset.woff2")).toBe(false);

  const delta = await page.evaluate(() => {
    const w = (id: string) => document.getElementById(id)!.getBoundingClientRect().width;
    return w("target") - w("control");
  });
  expect(Math.abs(delta)).toBeGreaterThanOrEqual(30);

  await page.evaluate(() => {
    const p = document.createElement("p");
    p.style.fontFamily = '"RangeFont", serif';
    p.textContent = "Ωμέγα";
    document.body.appendChild(p);
    return p.getBoundingClientRect().width;
  });
  await waitFor(() => fonts.has("noto-greek-subset.woff2"), 5_000);
  expect(fonts.has("noto-greek-subset.woff2")).toBe(true);
}, 60_000);

test("a face without unicode-range is fetched on family use alone", async ({ page }) => {
  const fonts = await fetchedFonts(page);
  await page.goto("https://ks.invalid/__fixtures/webfont.html", { waitUntil: "load" });
  await waitFor(() => fonts.size >= 1, 5_000);
  expect(fonts.size).toBeGreaterThanOrEqual(1);
}, 60_000);

test("an in-place CharacterData write pulls the subset it needs", async ({ page }) => {
  const fonts = await fetchedFonts(page);
  await page.goto(FIXTURE, { waitUntil: "load" });
  await waitFor(() => fonts.size >= 2, 5_000);
  expect(fonts.has("noto-greek-subset.woff2")).toBe(false);

  await page.evaluate(() => {
    const p = document.getElementById("target")!;
    (p.firstChild as Text).data = "Ωμέγα";
    return p.getBoundingClientRect().width;
  });
  await waitFor(() => fonts.has("noto-greek-subset.woff2"), 5_000);
  expect(fonts.has("noto-greek-subset.woff2")).toBe(true);
}, 60_000);
