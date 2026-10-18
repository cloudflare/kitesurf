// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

const HOST = "https://ks.invalid/__fixtures/lifecycle.html";
const SECRET = "https://ks-other.invalid/__fixtures/no-acao-secret.json";

test("a forged x-kitesurf-page-origin cannot claim the target's origin", async ({ page }) => {
  await page.goto(HOST, { waitUntil: "domcontentloaded" });
  const out = (await page.evaluate(`
    fetch(${JSON.stringify(SECRET)}, {
      headers: { "x-kitesurf-page-origin": "https://ks-other.invalid" },
    })
      .then((r) => r.text())
      .then((t) => "READ:" + t)
      .catch((e) => "BLOCKED:" + (e && e.name ? e.name : String(e)))
  `)) as string;
  expect(out).not.toContain("kitesurf-cross-origin-secret");
  expect(out.startsWith("BLOCKED:")).toBe(true);
}, 120_000);

test("a forged x-kitesurf-cookie-key cannot reach another context's jar", async ({ browser }) => {
  const c1 = await browser.createBrowserContext();
  const c2 = await browser.createBrowserContext();
  const p1 = await c1.newPage();
  await p1.goto(HOST, { waitUntil: "domcontentloaded" });
  const p2 = await c2.newPage();
  await p2.goto(HOST, { waitUntil: "domcontentloaded" });
  const cdp1 = await p1.createCDPSession();
  const cdp2 = await p2.createCDPSession();
  await cdp1.send("Storage.setCookies", {
    browserContextId: c1.id,
    cookies: [{ name: "who", value: "ctx1", domain: "ks.invalid", path: "/" }],
  });
  await cdp2.send("Storage.setCookies", {
    browserContextId: c2.id,
    cookies: [{ name: "who", value: "ctx2", domain: "ks.invalid", path: "/" }],
  });
  const forged = (await p1.evaluate(`
    fetch("/__fixtures/echo-headers.json", {
      headers: { "x-kitesurf-cookie-key": ${JSON.stringify(`::${c2.id}`)} },
    }).then((r) => r.json())
  `)) as { cookie?: string };
  expect(forged.cookie ?? "").toContain("who=ctx1");
  expect(forged.cookie ?? "").not.toContain("ctx2");
}, 120_000);

test("a forged Document resource-type cannot read cross-origin HTML", async ({ page }) => {
  await page.goto(HOST, { waitUntil: "domcontentloaded" });
  const out = (await page.evaluate(`
    fetch("https://ks-other.invalid/__fixtures/no-acao-secret.json", {
      headers: {
        "x-kitesurf-resource-type": "Document",
        "x-kitesurf-allow-cross-origin": "1",
      },
    })
      .then((r) => r.text())
      .then((t) => "READ:" + t)
      .catch((e) => "BLOCKED:" + (e && e.name ? e.name : String(e)))
  `)) as string;
  expect(out).not.toContain("kitesurf-cross-origin-secret");
  expect(out.startsWith("BLOCKED:")).toBe(true);
}, 120_000);

test("sealed props keep same-origin and CORS-allowed reads working", async ({ page }) => {
  await page.goto(HOST, { waitUntil: "domcontentloaded" });
  const same = (await page.evaluate(`
    fetch("/__fixtures/echo-headers.json").then((r) => r.json())
  `)) as Record<string, string>;
  expect(typeof same["user-agent"]).toBe("string");
  const cross = (await page.evaluate(`
    fetch("https://ks-other.invalid/__fixtures/echo-headers.json")
      .then((r) => r.json())
      .catch((e) => ({ error: String(e) }))
  `)) as Record<string, string>;
  expect(cross.error).toBeUndefined();
  expect(cross["origin"]).toBe("https://ks.invalid");
}, 120_000);
