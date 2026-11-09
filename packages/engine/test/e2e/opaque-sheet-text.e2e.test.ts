// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { CDPSession, Page } from "@cloudflare/puppeteer";

import { expect, test } from "./harness";

// No crossorigin attribute, so the page sees an opaque sheet and the engine fetches its text.
const PAGE = "https://ks.invalid/__fixtures/cors-sheet-no-attr.html";

// The same, for a sheet whose server sends no Access-Control-Allow-Origin.
const BARE_SHEET_PAGE = `https://ks.invalid/__fixtures/policy-doc.html?body=${encodeURIComponent(
  '<link rel="stylesheet" href="https://ks-alt.invalid/__fixtures/cors-sheet-bare.css">',
)}`;

async function opaqueSheetText(
  page: Page,
  cdpSession: CDPSession,
  beforeEnable?: () => Promise<unknown>,
  pageUrl: string = PAGE,
): Promise<string> {
  await page.goto(pageUrl, { waitUntil: "load" });
  // The page loads its own copy first; only the engine's later fetch should see a filter.
  await beforeEnable?.();
  const added: string[] = [];
  cdpSession.on("CSS.styleSheetAdded", (p) => {
    if (p.header.sourceURL.startsWith("https://ks-alt.invalid/")) added.push(p.header.styleSheetId);
  });
  await cdpSession.send("DOM.enable");
  await cdpSession.send("CSS.enable");
  for (let i = 0; i < 40 && added.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
  expect(added.length, "the cross-origin sheet was never reported").toBeGreaterThan(0);
  const { text } = await cdpSession.send("CSS.getStyleSheetText", { styleSheetId: added[0] ?? "" });
  return text;
}

test("the engine reads an opaque sheet's text through the connection's gateway", async ({
  page,
  cdpSession,
}) => {
  expect(await opaqueSheetText(page, cdpSession)).toContain("{");
});

test("the engine reads an opaque sheet's text when its server sends no ACAO", async ({
  page,
  cdpSession,
}) => {
  expect(await opaqueSheetText(page, cdpSession, undefined, BARE_SHEET_PAGE)).toContain("{");
});

test("an outbound filter also applies to the engine's opaque-sheet fetch", async ({
  page,
  cdpSession,
}) => {
  const filter = () =>
    cdpSession.send("Kitesurf.setOutboundFilters", {
      rejectRequestPattern: ["^https://ks-alt\\.invalid/"],
    });
  expect(await opaqueSheetText(page, cdpSession, filter)).toBe("");
});
