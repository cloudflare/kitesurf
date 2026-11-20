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
var s = (window.__ksState = { leak: false, sel: false, then: false, push: false, shadow: false });
var hooks = (window.__ksHooks = { charCode: 0, encodeInto: 0, set: 0, installed: {} });
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
// The engine answers selector matches through the DomHandle page code can reach, but calls the
// prototype method it captured before page code ran, so shadowing the instance must not be seen.
var dom = globalThis[Symbol.for("kitesurf.internals")].domDebug;
function matchesHook(nodeId, selector) { s.shadow = true; return true; }
dom.matchesInSubtreeBytes = matchesHook;
hooks.installed.matchesInSubtreeBytes = dom.matchesInSubtreeBytes === matchesHook;
var charCodeAt = String.prototype.charCodeAt;
String.prototype.charCodeAt = function (index) {
  hooks.charCode++;
  if (typeof this === "string" && this.indexOf("ks-selector-marker") >= 0) s.sel = true;
  return charCodeAt.call(this, index);
};
hooks.installed.charCodeAt = String.prototype.charCodeAt !== charCodeAt;
if (typeof TextEncoder.prototype.encodeInto === "function") {
  var encodeInto = TextEncoder.prototype.encodeInto;
  TextEncoder.prototype.encodeInto = function (text, view) {
    hooks.encodeInto++;
    if (typeof text === "string" && text.indexOf("ks-selector-marker") >= 0) s.sel = true;
    return encodeInto.call(this, text, view);
  };
  hooks.installed.encodeInto = TextEncoder.prototype.encodeInto !== encodeInto;
}
// wasm-bindgen copies caller bytes into wasm memory through Uint8Array.prototype.set; the glue
// captures it at load, so selector bytes must never reach this hook.
var setBytes = Uint8Array.prototype.set;
// "ks-selector-marker" as bytes, so the hook never calls the charCodeAt it replaced.
var MARKER = [107, 115, 45, 115, 101, 108, 101, 99, 116, 111, 114, 45, 109, 97, 114, 107, 101, 114];
function hasMarker(bytes) {
  if (!bytes || bytes.length > 4096) return false;
  for (var i = 0; i + MARKER.length <= bytes.length; i++) {
    var hit = true;
    for (var j = 0; j < MARKER.length; j++) {
      if (bytes[i + j] !== MARKER[j]) { hit = false; break; }
    }
    if (hit) return true;
  }
  return false;
}
Uint8Array.prototype.set = function (source, offset) {
  hooks.set++;
  if (hasMarker(source)) s.sel = true;
  return setBytes.call(this, source, offset);
};
hooks.installed.set = Uint8Array.prototype.set !== setBytes;
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
  const installed = await page.evaluate(() => (window as any).__ksHooks.installed);
  expect(JSON.stringify(reply)).toContain("ks-opaque-sheet-marker");
  expect(state).toEqual({ leak: false, sel: false, then: true, push: true, shadow: false });
  // A script error before an install would leave the hook unproven, so assert every install.
  expect(installed).toEqual({
    matchesInSubtreeBytes: true,
    charCodeAt: true,
    encodeInto: true,
    set: true,
  });
});
