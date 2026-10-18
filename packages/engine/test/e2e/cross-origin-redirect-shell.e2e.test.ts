// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

const HOST = "https://ks.invalid/__fixtures/lifecycle.html";
const SECRET = "kitesurf-cross-origin-secret";
const LOUD = "https://ks-other.invalid/__fixtures/loud-redirect";

test("a cross-origin redirect hands back only status and Location", async ({ page }) => {
  await page.goto(HOST, { waitUntil: "domcontentloaded" });

  const out = (await page.evaluate(
    `(async () => {
      const url = ${JSON.stringify(LOUD)} + "?to=" +
        encodeURIComponent("/__fixtures/status-204");
      const seen = { manual: null, followed: null };

      // redirect: "manual" is the only way page JS can hold a 3xx.
      // Spec says opaqueredirect: no headers, no body.
      try {
        const r = await fetch(url, { mode: "no-cors", redirect: "manual" });
        const names = [];
        r.headers.forEach((_v, k) => names.push(k));
        seen.manual = {
          type: r.type,
          headerNames: names.sort(),
          body: await r.text(),
          secretHeader: r.headers.get("x-secret-hop-header"),
          setCookie: r.headers.get("set-cookie"),
          location: r.headers.get("location"),
        };
      } catch (e) { seen.manual = { threw: String(e) }; }

      // The chain must still WALK — the shell keeps Location, so a
      // followed cross-origin redirect still reaches its target.
      try {
        const r = await fetch(url, { mode: "no-cors" });
        seen.followed = { type: r.type, status: r.status, ok: true };
      } catch (e) { seen.followed = { threw: String(e) }; }

      return JSON.stringify(seen);
    })()`,
  )) as string;

  const seen = JSON.parse(out) as {
    manual: {
      type?: string;
      headerNames?: string[];
      body?: string;
      secretHeader?: string | null;
      setCookie?: string | null;
      location?: string | null;
      threw?: string;
    };
    followed: { type?: string; status?: number; ok?: boolean; threw?: string };
  };

  expect(seen.manual.threw).toBeUndefined();
  expect(seen.manual.body).toBe("");
  expect(seen.manual.secretHeader).toBeNull();
  expect(seen.manual.setCookie).toBeNull();
  expect(JSON.stringify(seen.manual)).not.toContain(SECRET);

  expect(seen.manual.type).toBe("opaqueredirect");
  expect(seen.manual.headerNames).toEqual([]);

  expect(seen.followed.threw).toBeUndefined();
  expect(seen.followed.ok).toBe(true);
  expect(seen.followed.type).toBe("opaque");
  expect(seen.followed.status).toBe(0);
});

test("the document navigate still reads Set-Cookie off a cross-origin 302", async ({ page }) => {
  await page.goto(`${LOUD}?to=${encodeURIComponent("/__fixtures/lifecycle.html")}`, {
    waitUntil: "domcontentloaded",
  });

  const cookies = await page.cookies();
  const hop = cookies.find((c) => c.name === "hopsession");
  expect(hop, "the 302's Set-Cookie never reached the jar").toBeDefined();
  expect(hop?.value).toBe(SECRET);
});
