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

const HOSTILE_PAGE = `https://ks.invalid/__fixtures/policy-doc.html?body=${encodeURIComponent(
  `<link rel="stylesheet" href="https://ks-alt.invalid/__fixtures/cors-sheet-private-marker.css">
<p id="target" data-ks-opaque="ks-selector-marker">target</p>
<script>
var s = (window.__ksState = { leak: false, sel: false, then: false, push: false });
function thenHook() {
  s.then = true;
  if (JSON.stringify((this && this.sheet && this.sheet.rules) || "").indexOf("ks-opaque-sheet-marker") >= 0) s.leak = true;
}
Object.defineProperty(Object.prototype, "then", { configurable: true, get: thenHook });
var push = Array.prototype.push;
function pushHook() {
  s.push = true;
  if ([].some.call(arguments, function (a) { return typeof a === "string" && a.indexOf("ks-selector-marker") >= 0; })) s.sel = true;
  return push.apply(this, arguments);
}
Array.prototype.push = pushHook;
</script>`,
)}`;

test("an opaque sheet's rules never pass through a page hook", async ({ page, cdpSession }) => {
  await page.goto(HOSTILE_PAGE, { waitUntil: "load" });
  await cdpSession.send("CSS.enable");
  const { root } = await cdpSession.send("DOM.getDocument");
  const query = { nodeId: root.nodeId, selector: "#target" };
  const { nodeId } = await cdpSession.send("DOM.querySelector", query);
  const reply = await cdpSession.send("CSS.getMatchedStylesForNode", { nodeId });
  const state = await page.evaluate(() => (window as any).__ksState);
  expect(JSON.stringify(reply)).toContain("ks-opaque-sheet-marker");
  expect(state).toEqual({ leak: false, sel: false, then: true, push: true });
});
