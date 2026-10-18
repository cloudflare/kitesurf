// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import type { Page } from "@cloudflare/puppeteer";

interface ProbeResult {
  ok: boolean;
  err?: string;
}

async function runProbe(page: Page, url: string): Promise<Record<string, ProbeResult>> {
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await page
    .waitForFunction(() => document.getElementById("results")?.getAttribute("data-done") === "1", {
      timeout: 30_000,
    })
    .catch(() => {});
  const done = await page
    .evaluate(() => document.getElementById("results")?.getAttribute("data-done") ?? "0")
    .catch(() => "0");
  expect(done, "probe matrix settled (data-done)").toBe("1");
  const raw = await page.evaluate(() => document.getElementById("results")?.textContent ?? "");
  return JSON.parse(raw) as Record<string, ProbeResult>;
}

const VARIANTS: Array<{ kind: string; url: string; cases: string[] }> = [
  {
    kind: "module",
    url: "http://127.0.0.1:8787/__fixtures/dynprobe.html",
    cases: [
      "rel_leaf",
      "attr_root_tree",
      "abs_url",
      "abs_frag",
      "shared_singleton",
      "baked_dep",
      "custom_element",
    ],
  },
  {
    kind: "classic",
    url: "http://127.0.0.1:8787/__fixtures/dynprobe-classic.html",
    cases: [
      "rel_leaf",
      "attr_root_tree",
      "abs_url",
      "abs_frag_retry",
      "shared_singleton",
      "custom_element",
    ],
  },
];

for (const { kind, url, cases } of VARIANTS) {
  test(`computed dynamic import() resolves from ${kind} scripts`, async ({ page }) => {
    const results = await runProbe(page, url);
    for (const name of cases) {
      const r = results[name];
      expect(r, `${kind}/${name} reported a result`).toBeTruthy();
      expect(r!.ok, `${kind}/${name} (err=${r!.err ?? "none"})`).toBe(true);
    }
  });
}

test("concurrent imports fetch a shared dependency once", async ({ page }) => {
  await page.goto("http://127.0.0.1:8787/__fixtures/lifecycle.html", { waitUntil: "load" });
  const cdp = await page.createCDPSession();
  const shared: string[] = [];
  cdp.on("Network.requestWillBeSent", (e: { requestId: string; request: { url: string } }) => {
    if (e.request.url.endsWith("/dynprobe-shared.js")) shared.push(e.requestId);
  });
  await cdp.send("Network.enable");
  const same = await page.evaluate(`Promise.all([
    import("http://127.0.0.1:8787/__fixtures/dynprobe-user-a.js"),
    import("http://127.0.0.1:8787/__fixtures/dynprobe-user-b.js"),
  ]).then(([a, b]) => a.value === b.value)`);
  expect(same).toBe(true);
  expect(shared).toHaveLength(1);
});

test("an Astro island component runs natively, not in boa", async ({ page }) => {
  await page.goto("http://127.0.0.1:8787/__fixtures/astro-island.html", { waitUntil: "load" });
  await page.waitForFunction(() => document.body.dataset.native !== undefined, { timeout: 10_000 });
  expect(await page.evaluate(() => document.body.dataset.native)).toBe("true");
});
