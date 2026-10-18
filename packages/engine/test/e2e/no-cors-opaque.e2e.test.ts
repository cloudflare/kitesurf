// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

const HOST = "https://ks.invalid/__fixtures/lifecycle.html";
const SECRET = "https://ks-other.invalid/__fixtures/no-acao-secret.json";

test("cross-origin no-cors yields an opaque, bodyless response", async ({ page }) => {
  await page.goto(HOST, { waitUntil: "domcontentloaded" });
  const out = (await page.evaluate(`
    fetch(${JSON.stringify(SECRET)}, { mode: "no-cors" }).then(async (r) => ({
      type: r.type,
      status: r.status,
      ok: r.ok,
      headerCount: Array.from(r.headers.keys()).length,
      body: await r.text(),
    })).catch((e) => ({ error: String(e) }))
  `)) as Record<string, unknown>;
  expect(out.error).toBeUndefined();
  expect(out.type).toBe("opaque");
  expect(out.status).toBe(0);
  expect(out.ok).toBe(false);
  expect(out.headerCount).toBe(0);
  expect(out.body).toBe("");
}, 120_000);

test("same-origin no-cors stays readable", async ({ page }) => {
  await page.goto(HOST, { waitUntil: "domcontentloaded" });
  const out = (await page.evaluate(`
    fetch("/__fixtures/echo-headers.json", { mode: "no-cors" }).then((r) => ({
      type: r.type,
      status: r.status,
    })).catch((e) => ({ error: String(e) }))
  `)) as Record<string, unknown>;
  expect(out.error).toBeUndefined();
  expect(out.type).toBe("basic");
  expect(out.status).toBe(200);
}, 120_000);

test("no-cors rejects methods a form could not send", async ({ page }) => {
  await page.goto(HOST, { waitUntil: "domcontentloaded" });
  const out = (await page.evaluate(`
    fetch("/__fixtures/echo-headers.json", { mode: "no-cors", method: "PUT" })
      .then(() => "ALLOWED")
      .catch((e) => e.name)
  `)) as string;
  expect(out).toBe("TypeError");
}, 120_000);

test("a no-cors request is reduced to safelisted headers, gateway-side", async ({ page }) => {
  await page.goto(HOST, { waitUntil: "domcontentloaded" });
  const out = (await page.evaluate(`
    (async () => {
      const echo = await fetch("/__fixtures/echo-headers.json", {
        mode: "no-cors",
        method: "POST",
        headers: { "x-probe": "leaked", "content-type": "text/plain" },
      }).then((r) => r.json());
      return {
        // Non-safelisted: dropped before the request was forwarded.
        sawProbe: "x-probe" in echo,
        // CORS-safelisted with a safelisted value: survives.
        sawContentType: (echo["content-type"] || "").includes("text/plain"),
        // Ours, added after the reduction — proof it only touched the
        // author's headers.
        sawUa: "user-agent" in echo,
      };
    })()
  `)) as Record<string, unknown>;
  expect(out.sawProbe).toBe(false);
  expect(out.sawContentType).toBe(true);
  expect(out.sawUa).toBe(true);
}, 120_000);

test("a cross-origin iframe exposes no contentDocument", async ({ page }) => {
  await page.goto(HOST, { waitUntil: "domcontentloaded" });
  const out = (await page.evaluate(`
    (async () => {
      const f = document.createElement("iframe");
      // Listen before loading; cap the wait if the cross-origin frame emits
      // neither event.
      const settled = new Promise((r) => {
        f.addEventListener("load", () => r("load"));
        f.addEventListener("error", () => r("error"));
        setTimeout(() => r("timeout"), 5000);
      });
      f.src = ${JSON.stringify(SECRET)};
      document.body.appendChild(f);
      await settled;
      return {
        doc: f.contentDocument === null ? "null" : "EXPOSED",
        win: f.contentWindow == null ? "null" : "present",
      };
    })()
  `)) as Record<string, string>;
  expect(out.doc).toBe("null");
}, 120_000);
