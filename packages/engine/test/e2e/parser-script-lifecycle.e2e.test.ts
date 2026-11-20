// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// load and error on <script src> elements from the initial HTML.
import type { Page } from "@cloudflare/puppeteer";

import { expect, test } from "./harness";

const ORIGIN = "https://ks.invalid";

const scriptUrl = (params: Record<string, string>): string => {
  const u = new URL(`${ORIGIN}/__fixtures/policy-script.js`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
};

const docUrl = (body: string): string => {
  const u = new URL(`${ORIGIN}/__fixtures/policy-doc.html`);
  u.searchParams.set("body", body);
  return u.toString();
};

async function sri(source: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-384", new TextEncoder().encode(source));
  let bin = "";
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return `sha384-${btoa(bin)}`;
}

const fixtureBody = (tag: string): string =>
  `globalThis.__ksRan = (globalThis.__ksRan || []).concat(["${tag}"]);\n`;

// Logs script load and error as seen from a document capture listener, a document bubble
// listener, DOMContentLoaded and window load.
const RECORDER = `<script>
window.__ev = [];
var isScript = function (e) { return e.target && e.target.tagName === "SCRIPT"; };
document.addEventListener("load", function (e) {
  if (isScript(e)) __ev.push("capture:" + e.target.id + ":" + e.eventPhase + ":" + e.bubbles + ":" + e.cancelable);
}, true);
document.addEventListener("load", function (e) { if (isScript(e)) __ev.push("bubble:" + e.target.id); });
document.addEventListener("error", function (e) { if (isScript(e)) __ev.push("error:" + e.target.id); }, true);
document.addEventListener("DOMContentLoaded", function () { __ev.push("dcl"); });
window.addEventListener("load", function () { __ev.push("window-load:" + !!window.__done); });
</script>`;

async function events(page: Page): Promise<string[]> {
  await page.waitForFunction(
    () => ((globalThis as { __ev?: string[] }).__ev ?? []).some((e) => e.startsWith("window-load")),
    { timeout: 20_000 },
  );
  return (await page.evaluate(() => (globalThis as { __ev?: string[] }).__ev ?? [])) as string[];
}

test("regular and defer scripts fire load after their body, before DOMContentLoaded", async ({
  page,
}) => {
  const body =
    RECORDER +
    `<script id="r" src="${scriptUrl({ tag: "r" })}" onload="__ev.push('onload:r:' + __ksRan.join())"></script>` +
    `<script id="i">__ev.push("inline");</script>` +
    `<script id="d" defer src="${scriptUrl({ tag: "d" })}" onload="__ev.push('onload:d:' + __ksRan.join())"></script>`;
  await page.goto(docUrl(body), { waitUntil: "load" });
  expect(await events(page)).toEqual([
    "capture:r:1:false:false",
    "onload:r:r",
    "inline",
    "capture:d:1:false:false",
    "onload:d:r,d",
    "dcl",
    "window-load:false",
  ]);
}, 60_000);

test("an async script's onload runs before window load", async ({ page }) => {
  const body =
    RECORDER +
    `<script id="a" async src="${scriptUrl({ tag: "a" })}" onload="window.__done = true"></script>`;
  await page.goto(docUrl(body), { waitUntil: "load" });
  expect(await events(page)).toEqual(["dcl", "capture:a:1:false:false", "window-load:true"]);
}, 60_000);

test("a DOMContentLoaded loader that waits on an async script's load proceeds", async ({
  page,
}) => {
  const integrity = await sri(fixtureBody("ot"));
  const body =
    `<script id="ot" async src="${scriptUrl({ tag: "ot" })}" integrity="${integrity}" crossorigin="anonymous"` +
    ` onload="window.__otDone = true" onerror="window.__otDone = true"></script>` +
    `<script>
    document.addEventListener("DOMContentLoaded", function () {
      var e = document.getElementById("ot");
      var go = function () {
        setTimeout(function () {
          var s = document.createElement("script");
          s.src = ${JSON.stringify(scriptUrl({ tag: "tools" }))};
          document.head.appendChild(s);
        }, 0);
      };
      if (!e || window.__otDone) return go();
      e.addEventListener("load", go, { once: true });
      e.addEventListener("error", go, { once: true });
    });
    </script>`;
  await page.goto(docUrl(body), { waitUntil: "load" });
  await page.waitForFunction(
    () => ((globalThis as { __ksRan?: string[] }).__ksRan ?? []).includes("tools"),
    { timeout: 20_000 },
  );
  expect(
    await page.evaluate(() => ({
      ran: (globalThis as { __ksRan?: string[] }).__ksRan,
      done: (globalThis as { __otDone?: boolean }).__otDone,
    })),
  ).toEqual({ ran: ["ot", "tools"], done: true });
}, 60_000);

test("an SRI mismatch fires error, not load, and the body does not run", async ({ page }) => {
  const integrity = await sri(fixtureBody("bad"));
  const body =
    RECORDER +
    `<script id="bad" src="${scriptUrl({ tag: "bad", extra: "1" })}" integrity="${integrity}" crossorigin="anonymous"` +
    ` onload="__ev.push('onload:bad')" onerror="__ev.push('onerror:bad')"></script>`;
  await page.goto(docUrl(body), { waitUntil: "load" });
  expect(await events(page)).toEqual(["error:bad", "onerror:bad", "dcl", "window-load:false"]);
  expect(await page.evaluate(() => (globalThis as { __ksRan?: string[] }).__ksRan)).toBeUndefined();
}, 60_000);

test("a failed fetch fires error in document order", async ({ page }) => {
  const body =
    RECORDER +
    `<script id="gone" src="${ORIGIN}/__fixtures/no-such-script.js" onerror="__ev.push('onerror:gone')"></script>` +
    `<script id="i">__ev.push("inline");</script>`;
  await page.goto(docUrl(body), { waitUntil: "load" });
  expect(await events(page)).toEqual([
    "error:gone",
    "onerror:gone",
    "inline",
    "dcl",
    "window-load:false",
  ]);
}, 60_000);

test("duplicate script URLs keep their own lifecycle targets", async ({ page }) => {
  const src = scriptUrl({ tag: "dup" });
  const body =
    RECORDER +
    `<script src="${src}" onload="__ev.push('onload:a'); this.parentNode.insertBefore(document.createElement('script'), this)"></script>` +
    `<script src="${src}" onload="__ev.push('onload:b')"></script>`;
  await page.goto(docUrl(body), { waitUntil: "load" });
  expect((await events(page)).filter((e) => e.startsWith("onload:"))).toEqual([
    "onload:a",
    "onload:b",
  ]);
}, 60_000);

// scan.rs gives no ordinal to a script inside <template>, so the wrappers skip those too.
test("a script inside a template does not shift lifecycle targets", async ({ page }) => {
  const src = scriptUrl({ tag: "tpl" });
  const body =
    RECORDER +
    `<template><script src="${scriptUrl({ tag: "inert" })}"></script></template>` +
    `<script id="a" src="${src}" onload="__ev.push('onload:a')"></script>` +
    `<script id="b" src="${src}" onload="__ev.push('onload:b')"></script>`;
  await page.goto(docUrl(body), { waitUntil: "load" });
  expect((await events(page)).filter((e) => e.startsWith("onload:"))).toEqual([
    "onload:a",
    "onload:b",
  ]);
}, 60_000);
