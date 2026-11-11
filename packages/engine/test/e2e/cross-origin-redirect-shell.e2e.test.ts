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

test("page hooks never observe a cross-origin redirect target", async ({ page }) => {
  await page.goto(HOST, { waitUntil: "domcontentloaded" });

  const out = (await page.evaluate(
    `(async () => {
      const SECRET = ${JSON.stringify(SECRET)};
      const LOUD = ${JSON.stringify(LOUD)};
      const SAME = "https://ks.invalid/__fixtures/loud-redirect";
      const TERMINAL = "https://ks-other.invalid/__fixtures/no-acao-secret.json?code=" + SECRET;
      const seen = [];
      const counts = { status: 0, headers: 0, url: 0, text: 0, console: 0 };
      const native = {
        status: Object.getOwnPropertyDescriptor(Response.prototype, "status").get,
        headers: Object.getOwnPropertyDescriptor(Response.prototype, "headers").get,
        url: Object.getOwnPropertyDescriptor(Response.prototype, "url").get,
        text: Response.prototype.text,
      };
      const saved = {
        status: Object.getOwnPropertyDescriptor(Response.prototype, "status"),
        headers: Object.getOwnPropertyDescriptor(Response.prototype, "headers"),
        url: Object.getOwnPropertyDescriptor(Response.prototype, "url"),
        text: Response.prototype.text,
        consoleError: console.error,
      };
      // A hooked getter receives the raw shell as its receiver, so a Location read there is a
      // leak: the shim must never invoke one on an unfiltered engine response.
      const note = (channel, value) => {
        const text = String(value === null || value === undefined ? "" : value);
        if (text.includes(SECRET)) seen.push(channel + ":" + text);
      };
      const hookGetter = (name) => {
        Object.defineProperty(Response.prototype, name, {
          configurable: true,
          enumerable: true,
          get() {
            counts[name] += 1;
            try {
              note(name, native.headers.call(this).get("location"));
            } catch {}
            return native[name].call(this);
          },
        });
      };
      let result = { installed: false };
      try {
        hookGetter("status");
        hookGetter("headers");
        hookGetter("url");
        Response.prototype.text = async function text() {
          counts.text += 1;
          const body = await native.text.call(this);
          note("text", body);
          return body;
        };
        console.error = (...args) => {
          counts.console += 1;
          note("console", args.join(" "));
        };
        const probes = {};
        const url = LOUD + "?to=" + encodeURIComponent(TERMINAL);
        const rows = {
          manual: { mode: "no-cors", redirect: "manual" },
          follow: {},
        };
        for (const [name, init] of Object.entries(rows)) {
          try {
            const r = await fetch(url, { credentials: "include", ...init });
            probes[name] = { type: r.type, status: r.status, location: r.headers.get("location") };
          } catch (e) {
            probes[name] = { threw: String(e) };
          }
        }
        // The same-origin control proves the hooks are live and real reads still work.
        const control = await fetch(SAME + "?to=" + encodeURIComponent("/__fixtures/status-204"));
        await control.text();
        console.error("hook-control");
        result = { installed: true, seen, counts, probes, status: control.status };
      } finally {
        Object.defineProperty(Response.prototype, "status", saved.status);
        Object.defineProperty(Response.prototype, "headers", saved.headers);
        Object.defineProperty(Response.prototype, "url", saved.url);
        Response.prototype.text = saved.text;
        console.error = saved.consoleError;
      }
      return JSON.stringify(result);
    })()`,
  )) as string;

  const seen = JSON.parse(out) as {
    installed: boolean;
    seen: string[];
    counts: Record<string, number>;
    probes: Record<
      string,
      { type?: string; status?: number; location?: string | null; threw?: string }
    >;
    status: number;
  };

  expect(seen.installed).toBe(true);
  expect(seen.status).toBe(204);
  expect(seen.counts.status).toBeGreaterThan(0);
  expect(seen.counts.text).toBeGreaterThan(0);
  expect(seen.counts.console).toBeGreaterThan(0);
  expect(seen.probes.manual?.type).toBe("opaqueredirect");
  expect(seen.probes.manual?.location).toBeNull();
  expect(JSON.stringify(seen.probes.follow)).toContain("Failed to fetch");
  expect(seen.seen).toEqual([]);
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
