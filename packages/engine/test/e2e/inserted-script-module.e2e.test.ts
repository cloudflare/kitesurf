// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A page inserts <script type="module" src>, as a storefront loader does for its WebMCP tools.
import type { Page } from "@cloudflare/puppeteer";

import { expect, test } from "./harness";

const ORIGIN = "https://ks.invalid";
const moduleUrl = (file: string): string => `${ORIGIN}/__fixtures/inserted-module/${file}`;

const docUrl = (body: string): string => {
  const u = new URL(`${ORIGIN}/__fixtures/policy-doc.html`);
  u.searchParams.set("body", body);
  return u.toString();
};

// Inserts one module per file and records the element's load or error event.
const inserter = (files: string[]): string => `<script>
  window.__events = [];
  ${JSON.stringify(files)}.forEach(function (file) {
    var s = document.createElement("script");
    s.type = "module";
    s.src = ${JSON.stringify(moduleUrl(""))} + file;
    s.addEventListener("load", function () { __events.push("load:" + file); });
    s.addEventListener("error", function () { __events.push("error:" + file); });
    document.head.appendChild(s);
  });
</script>`;

async function settled(page: Page, count: number): Promise<{ events: string[]; ran: string[] }> {
  await page.waitForFunction(
    (n: number) => ((globalThis as { __events?: string[] }).__events ?? []).length >= n,
    { timeout: 20_000 },
    count,
  );
  return (await page.evaluate(() => ({
    events: ((globalThis as { __events?: string[] }).__events ?? []).slice().sort(),
    ran: ((globalThis as { __insertedModule?: string[] }).__insertedModule ?? []).slice().sort(),
  }))) as { events: string[]; ran: string[] };
}

test("an inserted module runs its import graph and registers a WebMCP tool", async ({
  page,
  cdpSession,
}) => {
  const added: string[] = [];
  cdpSession.on("WebMCP.toolsAdded", (p: { tools: Array<{ name: string }> }) =>
    added.push(...p.tools.map((t) => t.name)),
  );
  await cdpSession.send("WebMCP.enable");
  await page.goto(docUrl(inserter(["tool.js"])), { waitUntil: "load" });
  expect(await settled(page, 1)).toEqual({ events: ["load:tool.js"], ran: ["tool"] });
  await expect.poll(() => added, { timeout: 10_000 }).toContain("inserted_tool");
}, 60_000);

test("a module that throws fires load; a failed fetch in its graph fires error", async ({
  page,
}) => {
  await page.goto(docUrl(inserter(["throws.js", "broken.js", "absent.js"])), {
    waitUntil: "load",
  });
  expect(await settled(page, 3)).toEqual({
    events: ["error:absent.js", "error:broken.js", "load:throws.js"],
    ran: ["throws"],
  });
}, 60_000);

test("a fetch that fails outside a module's graph does not turn its load into error", async ({
  page,
}) => {
  await page.goto(docUrl(inserter(["throws-after-lazy-404.js", "absent.js"])), {
    waitUntil: "load",
  });
  expect(await settled(page, 2)).toEqual({
    events: ["error:absent.js", "load:throws-after-lazy-404.js"],
    ran: ["lazy"],
  });
}, 60_000);

// Two elements for one URL share its fetch, which must keep the first element's integrity.
test("a second element for the same module URL keeps the first one's integrity", async ({
  page,
}) => {
  const slow = `${ORIGIN}/__fixtures/written-script.js?tag=slow&ms=1000`;
  const bad = "sha256-" + "A".repeat(43) + "=";
  await page.goto(
    docUrl(`<script>
    window.__events = [];
    var add = function (url, label, integrity) {
      var s = document.createElement("script");
      s.type = "module";
      s.src = url;
      if (integrity) s.setAttribute("integrity", integrity);
      s.onload = function () { __events.push("load:" + label); };
      s.onerror = function () { __events.push("error:" + label); };
      document.head.appendChild(s);
    };
    add(${JSON.stringify(slow)}, "slow");
    add(${JSON.stringify(moduleUrl("dep.js"))}, "first", ${JSON.stringify(bad)});
    add(${JSON.stringify(moduleUrl("dep.js"))}, "second");
  </script>`),
    { waitUntil: "load" },
  );
  expect((await settled(page, 3)).events).toEqual(["error:first", "error:second", "load:slow"]);
}, 60_000);

// An import's fetch inherits the referring module's nonce, so a nonce-only CSP that admits the
// inserted entry also admits the graph under it.
test("a nonce-only CSP admits an inserted module's imports", async ({ page }) => {
  const u = new URL(`${ORIGIN}/__fixtures/policy-doc.html`);
  u.searchParams.set("csp", "script-src 'nonce-n0nce'");
  u.searchParams.set(
    "body",
    `<script nonce="n0nce">
    window.__events = [];
    var s = document.createElement("script");
    s.type = "module";
    s.nonce = "n0nce";
    s.src = ${JSON.stringify(moduleUrl("tool.js"))};
    s.onload = function () { __events.push("load:tool.js"); };
    s.onerror = function () { __events.push("error:tool.js"); };
    document.head.appendChild(s);
  </script>`,
  );
  await page.goto(u.toString(), { waitUntil: "load" });
  expect(await settled(page, 1)).toEqual({ events: ["load:tool.js"], ran: ["tool"] });
}, 60_000);

// HTML: a parse error leaves a module script with an error to rethrow, not a null result, so the
// element gets load and the error goes to the window ("execute the script element").
test("a module that fails to parse fires load and does not run", async ({ page }) => {
  await page.goto(docUrl(inserter(["syntax.js"])), { waitUntil: "load" });
  expect(await settled(page, 1)).toEqual({ events: ["load:syntax.js"], ran: [] });
}, 60_000);

test("an inserted module past the source byte budget fires error", async ({ page }) => {
  await page.goto(docUrl(inserter(["big.js"])), { waitUntil: "load" });
  expect(await settled(page, 1)).toEqual({ events: ["error:big.js"], ran: [] });
}, 60_000);
