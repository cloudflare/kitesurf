// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

const PAGE = "https://ks.invalid/__fixtures/external-scripts.html";

interface Seen {
  intercepted: number;
  sawBypassClaim: boolean;
  ownFetchWorks: boolean;
}

test("a replaced globalThis.fetch sees no loader traffic", async ({ page }) => {
  await page.goto(PAGE, { waitUntil: "load" });
  const raw: unknown = await page.evaluate(`(async () => {
    let intercepted = 0;
    let sawBypassClaim = false;
    const real = globalThis.fetch;
    globalThis.fetch = function (input, init) {
      intercepted++;
      const h = new Headers((init && init.headers) || {});
      if (h.get("x-kitesurf-allow-cross-origin") === "1") {
        sawBypassClaim = true;
      }
      return real(input, init);
    };
    // Either terminal event is enough: the point is that the loader
    // RAN, not that it succeeded. The cap keeps a resource that
    // reports neither from hanging the test.
    const settled = (el) => new Promise((r) => {
      el.addEventListener("load", () => r("load"));
      el.addEventListener("error", () => r("error"));
      setTimeout(() => r("timeout"), 5000);
    });
    // Drive the loaders: an inserted <script src> (fetchInsertedScript)
    // and an <img> (doRealFetch), the two post-parse privileged paths.
    const s = document.createElement("script");
    const scriptDone = settled(s);
    s.src = "/__fixtures/regular.js";
    document.head.appendChild(s);
    const img = document.createElement("img");
    const imgDone = settled(img);
    img.src = "/__fixtures/solid-red.png";
    document.body.appendChild(img);
    // The page's OWN fetch must still work through the replacement —
    // this is a capture, not a lockout, and a test that passed by
    // breaking page fetch would be worthless.
    let ownFetchWorks = false;
    try {
      const r = await fetch("/__fixtures/regular.js");
      ownFetchWorks = r.ok;
    } catch (e) {}
    await Promise.all([scriptDone, imgDone]);
    return { intercepted, sawBypassClaim, ownFetchWorks };
  })()`);
  const seen = raw as Seen;
  expect(seen.ownFetchWorks).toBe(true);
  expect(seen.intercepted).toBe(1);
  expect(seen.sawBypassClaim).toBe(false);
});

test("the earliest page script a document can run misses the capture", async ({ page }) => {
  await page.evaluateOnNewDocument(`(() => {
    const seen = { loader: 0, own: 0, bypass: false };
    globalThis.__ksSeen = seen;
    const real = globalThis.fetch;
    globalThis.fetch = function (input, init) {
      // The page's own probe is tagged, so the counters separate
      // "the hook is live" from "the hook saw a loader".
      const url = String((input && input.url) || input || "");
      if (url.indexOf("ks-own-probe") !== -1) seen.own++;
      else seen.loader++;
      try {
        const h = new Headers((init && init.headers) || {});
        if (h.get("x-kitesurf-allow-cross-origin") === "1") {
          seen.bypass = true;
        }
      } catch (e) {}
      return real(input, init);
    };
  })()`);
  await page.goto(PAGE, { waitUntil: "load" });
  const raw: unknown = await page.evaluate(`(async () => {
    // Either terminal event is enough: the point is that the loader
    // RAN, not that it succeeded. The cap keeps a resource that
    // reports neither from hanging the test.
    const settled = (el) => new Promise((r) => {
      el.addEventListener("load", () => r("load"));
      el.addEventListener("error", () => r("error"));
      setTimeout(() => r("timeout"), 5000);
    });
    // Drive the same two post-parse loader paths as above, so the
    // miss is about WHEN the hook went in and not about the page
    // having nothing to intercept.
    const s = document.createElement("script");
    const scriptDone = settled(s);
    s.src = "/__fixtures/regular.js";
    document.head.appendChild(s);
    const img = document.createElement("img");
    const imgDone = settled(img);
    img.src = "/__fixtures/solid-red.png";
    document.body.appendChild(img);
    await fetch("/__fixtures/regular.js?ks-own-probe=1");
    await Promise.all([scriptDone, imgDone]);
    return globalThis.__ksSeen;
  })()`);
  const seen = raw as { loader: number; own: number; bypass: boolean };
  expect(seen.own).toBe(1);
  expect(seen.loader).toBe(0);
  expect(seen.bypass).toBe(false);
});
