// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// fetch's cache option adds cache-control and pragma as the browser's own headers, so a
// cross-origin request needs no preflight for them; the same headers set by the page do.
import { expect, test } from "./harness";

const PAGE = "https://ks.invalid/__fixtures/policy-doc.html";
// Answers any method with Access-Control-Allow-Origin: * and no Allow-Headers.
const TARGET = "https://ks-other.invalid/__fixtures/policy-script.js?tag=cache";

test("a cross-origin fetch with a cache mode is not preflighted", async ({ page }) => {
  await page.goto(PAGE, { waitUntil: "load" });
  const outcome = await page.evaluate(async (url: string) => {
    const attempt = async (init: RequestInit): Promise<string> => {
      try {
        const res = await fetch(url, init);
        return "ok:" + res.status;
      } catch (e) {
        return "failed:" + (e as Error).name;
      }
    };
    return {
      noStore: await attempt({ cache: "no-store" }),
      noCache: await attempt({ cache: "no-cache" }),
      pageHeader: await attempt({ headers: { "Cache-Control": "no-cache" } }),
      both: await attempt({ cache: "no-store", headers: { "Cache-Control": "no-cache" } }),
    };
  }, TARGET);
  expect(outcome).toEqual({
    noStore: "ok:200",
    noCache: "ok:200",
    pageHeader: "failed:TypeError",
    both: "failed:TypeError",
  });
}, 60_000);

// With the page's own cache-control, the mode still adds pragma; only cache-control is the
// page's, so a server that allows just that header accepts the preflight, as in Chrome.
test("a cache mode's own header does not join a page header's preflight", async ({ page }) => {
  await page.goto(PAGE, { waitUntil: "load" });
  const outcome = await page.evaluate(async (base: string) => {
    const attempt = async (allow: string): Promise<string> => {
      try {
        const res = await fetch(`${base}?allow=${allow}`, {
          cache: "no-store",
          headers: { "Cache-Control": "no-cache" },
        });
        return "ok:" + res.status;
      } catch (e) {
        return "failed:" + (e as Error).name;
      }
    };
    return { allowed: await attempt("cache-control"), refused: await attempt("") };
  }, "https://ks-other.invalid/__fixtures/allow-headers");
  expect(outcome).toEqual({ allowed: "ok:200", refused: "failed:TypeError" });
}, 60_000);
