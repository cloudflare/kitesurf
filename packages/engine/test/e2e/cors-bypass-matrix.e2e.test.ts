// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

// Gap: withheld-response shell header filtering is not asserted here.

const HOST = "https://ks.invalid/__fixtures/lifecycle.html";
const SECRET = "https://ks-other.invalid/__fixtures/no-acao-secret.json";

const KNOWN_READABLE: string[] = [];

test("no forged resource type is a cross-origin read primitive", async ({ page }) => {
  await page.goto(HOST, { waitUntil: "domcontentloaded" });
  const out = (await page.evaluate(`
    (async () => {
      const types = ["Image","Font","Media","Stylesheet","Document","Script","XHR","Fetch","Other"];
      const results = {};
      for (const t of types) {
        for (const bypass of ["1","0"]) {
          for (const sc of ["no-cors","cors"]) {
            const label = t + "/" + bypass + "/" + sc;
            try {
              const r = await fetch(${JSON.stringify(SECRET)}, {
                credentials: "include",
                headers: {
                  "x-kitesurf-allow-cross-origin": bypass,
                  "x-kitesurf-resource-type": t,
                  "x-kitesurf-script-cors": sc,
                  "x-kitesurf-page-origin": "https://ks-other.invalid",
                  "x-kitesurf-cookie-key": "",
                  "x-kitesurf-connection-id": "forged",
                },
              });
              const body = await r.text();
              results[label] = body.includes("kitesurf-cross-origin-secret")
                ? "READABLE"
                : "opaque";
            } catch (e) {
              results[label] = "blocked";
            }
          }
        }
      }
      return results;
    })()
  `)) as Record<string, string>;

  expect(Object.keys(out).length).toBe(36);
  const readable = Object.entries(out)
    .filter(([, v]) => v === "READABLE")
    .map(([k]) => k)
    .sort();
  expect(readable).toEqual([...KNOWN_READABLE].sort());
  const blocked = Object.values(out).filter((v) => v === "blocked").length;
  expect(blocked).toBe(36);
}, 200_000);

test("a same-origin body is unaffected: this closes forgery, not fetch", async ({ page }) => {
  await page.goto(HOST, { waitUntil: "domcontentloaded" });
  const out: unknown = await page.evaluate(`
    (async () => {
      const r = await fetch("/__fixtures/no-acao-secret.json", {
        credentials: "include",
        headers: {
          "x-kitesurf-allow-cross-origin": "1",
          "x-kitesurf-resource-type": "Stylesheet",
        },
      });
      const body = await r.text();
      return body.includes("kitesurf-cross-origin-secret");
    })()
  `);
  expect(out).toBe(true);
}, 120_000);
