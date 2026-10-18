// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Page } from "@cloudflare/puppeteer";

import { expect, test, type BrowserFactory } from "./harness";

const HOST = "https://ks.invalid/__fixtures/lifecycle.html";
const SECRET = "https://ks-other.invalid/__fixtures/no-acao-secret.json";
const ECHO = "https://ks-other.invalid/__fixtures/echo-headers.json";
const OPAQUE_SHEET = "https://ks-alt.invalid/__fixtures/cors-sheet-bare.css";

async function withPage<T>(
  browserFactory: BrowserFactory,
  fn: (page: Page) => Promise<T>,
): Promise<T> {
  const browser = await browserFactory();
  const page = await browser.newPage();
  await page.goto(HOST, { waitUntil: "domcontentloaded" });
  return await fn(page);
}

const TAMPERS: Record<string, string> = {
  "Headers.prototype.set": `
    const real = Headers.prototype.set;
    Headers.prototype.set = function (n, v) {
      if (String(n).toLowerCase() === "x-kitesurf-resource-type") {
        return real.call(this, n, "Stylesheet");
      }
      return real.call(this, n, v);
    };`,
  "Headers.prototype.set no-op": `
    const real = Headers.prototype.set;
    Headers.prototype.set = function (n, v) {
      if (String(n).toLowerCase() === "x-kitesurf-resource-type") return;
      return real.call(this, n, v);
    };`,
  "globalThis.Headers": `
    const Real = Headers;
    globalThis.Headers = class extends Real {
      constructor(init) {
        super(init);
        Real.prototype.set.call(this, "x-kitesurf-resource-type", "Stylesheet");
      }
      set(n, v) {
        if (String(n).toLowerCase() === "x-kitesurf-resource-type") return;
        return Real.prototype.set.call(this, n, v);
      }
    };`,
  "Function.prototype.call": `
    const realCall = Function.prototype.call;
    Function.prototype.call = function (thisArg, ...args) {
      const target = this;
      if (target === Headers.prototype.set &&
          String(args[0]).toLowerCase() === "x-kitesurf-resource-type") {
        return Reflect.apply(target, thisArg, [args[0], "Stylesheet"]);
      }
      return Reflect.apply(target, thisArg, args);
    };`,
};

async function forgeType(
  page: Page,
  tamper: string | null,
): Promise<{ accept: string; secret: string }> {
  return (await page.evaluate(`(async () => {
    ${tamper ?? ""}
    const claim = { headers: {
      "x-kitesurf-allow-cross-origin": "1",
      "x-kitesurf-resource-type": "Stylesheet",
    } };
    const e = await fetch(${JSON.stringify(ECHO)}, claim);
    const accept = (await e.json()).accept || "";
    let secret = "blocked";
    try {
      const r = await fetch(${JSON.stringify(SECRET)}, claim);
      secret = (await r.text()).includes("kitesurf-cross-origin-secret")
        ? "READABLE"
        : "opaque";
    } catch (err) {}
    return { accept, secret };
  })()`)) as { accept: string; secret: string };
}

const FETCH_DEFAULT = "*/*";

test("patching the header writer does not forge a resource type", async ({ page }) => {
  await page.goto(HOST, { waitUntil: "domcontentloaded" });
  const control = await forgeType(page, null);
  expect(control.accept).toBe(FETCH_DEFAULT);
  expect(control.secret).toBe("blocked");

  for (const [name, tamper] of Object.entries(TAMPERS)) {
    const got = await forgeType(page, tamper);
    expect(got.accept, name).toBe(FETCH_DEFAULT);
    expect(got.secret, name).toBe("blocked");
  }
}, 200_000);

const VERDICT_TAMPERS: Record<string, string> = {
  "Headers.prototype.get": `
    const real = Headers.prototype.get;
    Headers.prototype.get = function (n) {
      if (String(n).toLowerCase() === "x-kitesurf-cors") return "clean";
      return real.call(this, n);
    };`,
  "Headers.prototype.get no-op": `
    Headers.prototype.get = function () { return null; };`,
  "Function.prototype.call": `
    const realCall = Function.prototype.call;
    Function.prototype.call = function (thisArg, ...args) {
      const target = this;
      if (target === Headers.prototype.get &&
          String(args[0]).toLowerCase() === "x-kitesurf-cors") return "clean";
      return Reflect.apply(target, thisArg, args);
    };`,
};

async function readOpaqueSheet(
  page: Page,
  tamper: string | null,
): Promise<{ rules: number; mutate: string }> {
  return (await page.evaluate(`(async () => {
    ${tamper ?? ""}
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = ${JSON.stringify(OPAQUE_SHEET)} + "?t=" + Math.random();
    document.head.appendChild(l);
    // The sheet has to come back before the probe means anything, and
    // an opaque one never announces itself — poll the mutator, which is
    // the only signal that distinguishes "denied" from "still fetching".
    let mutate = "", rules = 0;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 100));
      // By href, not by index: the fixture carries an inline <style>, so
      // the last entry is not necessarily the one just inserted (and an
      // inline sheet's href is null).
      let sheet = null;
      for (const s of document.styleSheets) {
        const href = s && s.href;
        if (typeof href === "string" && href.indexOf("cors-sheet-bare") !== -1) {
          sheet = s;
        }
      }
      if (!sheet) continue;
      try { rules = sheet.cssRules.length; } catch (e) { rules = -1; }
      mutate = "";
      try { sheet.insertRule("#zz{color:rgb(1,2,3)}", 0); }
      catch (e) { mutate = String((e && e.name) || e); }
      if (rules > 0 || mutate !== "") break;
    }
    return { rules, mutate };
  })()`)) as { rules: number; mutate: string };
}

test("patching the verdict read does not expose an opaque sheet", async ({ browserFactory }) => {
  const control = await withPage(browserFactory, (page) => readOpaqueSheet(page, null));
  expect(control.rules).toBe(0);
  expect(control.mutate).toBe("SecurityError");

  for (const [name, tamper] of Object.entries(VERDICT_TAMPERS)) {
    const got = await withPage(browserFactory, (page) => readOpaqueSheet(page, tamper));
    expect(got.rules, name).toBe(0);
    expect(got.mutate, name).toBe("SecurityError");
  }
}, 200_000);

test("a page's Headers patch cannot revoke a genuine load's claim", async ({ page }) => {
  await page.goto(HOST, { waitUntil: "domcontentloaded" });
  const width = await page.evaluate(`(async () => {
    // Blanket sabotage rather than a targeted rewrite: strip the type
    // and the bypass claim from every write, whoever makes it.
    const real = Headers.prototype.set;
    Headers.prototype.set = function (n, v) {
      const lc = String(n).toLowerCase();
      if (lc === "x-kitesurf-resource-type") return real.call(this, n, "Fetch");
      if (lc === "x-kitesurf-allow-cross-origin") return;
      return real.call(this, n, v);
    };
    const img = document.createElement("img");
    img.id = "probe";
    img.src = "https://ks-other.invalid/__fixtures/solid-red.png";
    document.body.appendChild(img);
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (img.naturalWidth > 0) break;
    }
    return img.naturalWidth;
  })()`);
  expect(Number(width)).toBeGreaterThan(0);
}, 200_000);

test("a page's own Headers patch still works on its own requests", async ({ page }) => {
  await page.goto(HOST, { waitUntil: "domcontentloaded" });
  const out = (await page.evaluate(`(async () => {
    const real = Headers.prototype.set;
    let seen = 0;
    Headers.prototype.set = function (n, v) {
      seen++;
      return real.call(this, n, v);
    };
    const h = new Headers();
    h.set("x-page-own", "yes");
    const r = await fetch("/__fixtures/echo-headers.json", { headers: h });
    const j = await r.json();
    return { own: j["x-page-own"] || "", seen: seen > 0, ok: r.ok };
  })()`)) as { own: string; seen: boolean; ok: boolean };
  expect(out.ok).toBe(true);
  expect(out.own).toBe("yes");
  expect(out.seen).toBe(true);
}, 200_000);
