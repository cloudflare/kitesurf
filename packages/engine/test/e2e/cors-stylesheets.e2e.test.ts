// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Page } from "@cloudflare/puppeteer";

import { expect, test } from "./harness";

const FIXTURES = {
  clean: "https://ks.invalid/__fixtures/cors-sheet-clean.html",
  noAcao: "https://ks.invalid/__fixtures/cors-sheet-no-acao.html",
  noAttr: "https://ks.invalid/__fixtures/cors-sheet-no-attr.html",
  sameOrigin: "https://ks.invalid/__fixtures/cors-sheet-same-origin.html",
  redirect: "https://ks.invalid/__fixtures/cors-sheet-redirect.html",
  echoOrigin: "https://ks.invalid/__fixtures/cors-sheet-echo-origin.html",
};

type Probe = {
  ok: boolean;
  error: string;
  count: number;
  selectors: string[];
  href: string;
};

async function probeInsertRule(page: Page): Promise<string> {
  return (await page.evaluate(() => {
    const sheet = document.styleSheets[0] as CSSStyleSheet | undefined;
    if (!sheet) return "no-sheet";
    try {
      sheet.insertRule("#x { color: rgb(1, 2, 3); }", 0);
      return "";
    } catch (e) {
      return String((e as DOMException)?.name || e);
    }
  })) as string;
}

async function readSheet(page: Page): Promise<Probe> {
  return (await page.evaluate(() => {
    const sheet = document.styleSheets[0];
    if (!sheet) {
      return { ok: false, error: "no-sheet", count: 0, selectors: [], href: "" };
    }
    const href = String((sheet as CSSStyleSheet).href ?? "");

    function errorMessage(error: unknown): string {
      return String((error as DOMException)?.name || error);
    }

    function readSelectors(rules: CSSRuleList): string[] {
      const selectors: string[] = [];
      for (let i = 0; i < rules.length; i++) {
        const rule = rules[i] as CSSStyleRule;
        if (rule && typeof rule.selectorText === "string") {
          selectors.push(rule.selectorText);
        }
      }
      return selectors;
    }

    try {
      const rules = (sheet as CSSStyleSheet).cssRules;
      const selectors = readSelectors(rules);
      return { ok: true, error: "", count: rules.length, selectors, href };
    } catch (e) {
      return {
        ok: false,
        error: errorMessage(e),
        count: 0,
        selectors: [],
        href,
      };
    }
  })) as Probe;
}

const DEADLINE_MS = 20000;

async function poll<T>(probe: () => Promise<T>, settled: (v: T) => boolean) {
  const deadline = Date.now() + DEADLINE_MS;
  for (;;) {
    const v = await probe();
    if (settled(v) || Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function waitCleanSheet(page: Page): Promise<Probe> {
  return poll(
    () => readSheet(page),
    (r) => r.error !== "no-sheet" && (!r.ok || r.count > 0),
  );
}

async function waitOpaqueSheet(page: Page): Promise<string> {
  return poll(
    () => probeInsertRule(page),
    (e) => e === "SecurityError",
  );
}

async function gotoFixture(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
}

test("cross-origin sheet with crossorigin + ACAO exposes cssRules", async ({ page }) => {
  await gotoFixture(page, FIXTURES.clean);
  const probe = await waitCleanSheet(page);
  expect(probe.error).toBe("");
  expect(probe.ok).toBe(true);
  expect(probe.count).toBe(2);
  expect(probe.selectors).toEqual(["#target", "#other"]);
  expect(probe.href).toBe("https://ks-alt.invalid/__fixtures/cors-sheet-acao.css");
  expect(await probeInsertRule(page)).toBe("");
});

test("cross-origin sheet without ACAO is opaque", async ({ page }) => {
  await gotoFixture(page, FIXTURES.noAcao);
  expect(await waitOpaqueSheet(page)).toBe("SecurityError");
  expect((await readSheet(page)).count).toBe(0);
});

test("cross-origin sheet with ACAO but no crossorigin attr is opaque", async ({ page }) => {
  await gotoFixture(page, FIXTURES.noAttr);
  expect(await waitOpaqueSheet(page)).toBe("SecurityError");
  expect((await readSheet(page)).count).toBe(0);
});

test("same-origin external sheet exposes cssRules without any ACAO", async ({ page }) => {
  await gotoFixture(page, FIXTURES.sameOrigin);
  const probe = await waitCleanSheet(page);
  expect(probe.error).toBe("");
  expect(probe.count).toBe(2);
});

test("an opaque sheet still applies to the cascade", async ({ page }) => {
  await gotoFixture(page, FIXTURES.noAttr);
  const color = await poll(
    () =>
      page.evaluate(() => {
        const el = document.getElementById("target");
        return el ? getComputedStyle(el).color : "";
      }) as Promise<string>,
    (c) => c === "rgb(0, 0, 255)",
  );
  expect(color).toBe("rgb(0, 0, 255)");
});

test("a same-origin href redirecting cross-origin stays opaque", async ({ page }) => {
  await gotoFixture(page, FIXTURES.redirect);
  expect(await waitOpaqueSheet(page)).toBe("SecurityError");
  expect((await readSheet(page)).count).toBe(0);
});

test("a cors-mode sheet is sent an Origin so a per-Origin ACAO can match", async ({ page }) => {
  await gotoFixture(page, FIXTURES.echoOrigin);
  const probe = await waitCleanSheet(page);
  expect(probe.error).toBe("");
  expect(probe.count).toBe(2);
  expect(await probeInsertRule(page)).toBe("");
});
