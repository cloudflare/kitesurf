// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Page } from "@cloudflare/puppeteer";

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const OFF_POLICY = "https://ks-other.invalid/__fixtures/inserted-ok.js";

test("script-src applies to the target of a script's redirect", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html>
    <meta http-equiv="Content-Security-Policy" content="script-src https://ks.invalid">
    <title>start</title>
    <script src="https://ks.invalid/__fixtures/loud-redirect?to=${encodeURIComponent(OFF_POLICY)}"></script>`,
  );
  expect(await page.evaluate(() => Reflect.get(window, "__insertedRan") ?? false)).toBe(false);
});

test("a script that redirects within script-src still runs", async ({ page }) => {
  const allowed = "https://ks.invalid/__fixtures/inserted-ok.js";
  await setContent(
    page,
    `<!doctype html>
    <meta http-equiv="Content-Security-Policy" content="script-src https://ks.invalid">
    <title>start</title>
    <script src="https://ks.invalid/__fixtures/loud-redirect?to=${encodeURIComponent(allowed)}"></script>`,
  );
  expect(await page.evaluate(() => Reflect.get(window, "__insertedRan") ?? false)).toBe(true);
});

// A cross-origin frame's legacy parser scripts are gated by its terminal document's CSP.
const FRAME = "https://ks-other.invalid";
const NONCE = "n0nce";

async function addCspFrame(page: Page, params: Record<string, string>): Promise<string[]> {
  await page.goto("https://ks.invalid/__fixtures/lifecycle.html", { waitUntil: "load" });
  await page.evaluate(
    `window.__msgs = [];
     addEventListener("message", (e) => window.__msgs.push(String(e.data)));`,
  );
  await page.evaluate(
    (src) => {
      const frame = document.createElement("iframe");
      frame.src = src;
      document.body.appendChild(frame);
    },
    `${FRAME}/__fixtures/oopif-csp-frame.html?${new URLSearchParams(params)}`,
  );
  // The frame's last parser script posts "parsed" after every earlier script settled.
  await expect
    .poll(() => page.evaluate("JSON.stringify(window.__msgs ?? [])"), { timeout: 20_000 })
    .toContain("parsed");
  return JSON.parse((await page.evaluate("JSON.stringify(window.__msgs ?? [])")) as string);
}

test("a cross-origin frame never fetches a redirect hop its CSP refuses", async ({ page }) => {
  const key = Math.random().toString(36).slice(2);
  const hop = `https://ks-alt.invalid/__fixtures/oopif-csp-hop/${key}.js`;
  const src = `${FRAME}/__fixtures/loud-redirect?to=${encodeURIComponent(hop)}`;
  const refused = await addCspFrame(page, {
    csp: `script-src ${FRAME} 'nonce-${NONCE}'`,
    src,
  });
  expect(refused.filter((message) => message !== "parsed")).toEqual([]);
  const hits = await page.evaluate(
    `fetch("/__fixtures/oopif-csp-hits/${key}").then((r) => r.json()).then((b) => b.hits)`,
  );
  expect(hits).toBe(0);
}, 60_000);

test("a cross-origin frame refuses an inline script without a nonce", async ({ page }) => {
  const inline = await addCspFrame(page, { csp: `script-src 'nonce-${NONCE}'`, inline: "1" });
  expect(inline.filter((message) => message !== "parsed")).toEqual([]);
}, 60_000);
