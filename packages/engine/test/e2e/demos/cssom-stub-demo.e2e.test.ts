// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Page } from "@cloudflare/puppeteer";

import { expect, test } from "../harness";
import { setContent } from "../set-content";

async function sheetProbe(page: Page): Promise<Record<string, unknown>> {
  await setContent(
    page,
    `<!doctype html>
    <html><head>
    <style id="inline-css">.foo { color: red; }</style>
    <link rel="stylesheet">
    <link rel="icon">
    </head><body></body></html>
  `,
  );

  return page.evaluate(() => {
    const probe: Record<string, unknown> = {};
    try {
      probe.styleSheetsExists = typeof document.styleSheets !== "undefined";
      probe.styleSheetsIterable =
        Symbol.iterator in document.styleSheets || Array.isArray(Array.from(document.styleSheets));
      probe.styleSheetsLength = document.styleSheets.length;

      const ruleLengths: number[] = [];
      for (const s of document.styleSheets) {
        ruleLengths.push(s.cssRules.length);
      }
      probe.ruleLengths = ruleLengths;

      const first = document.styleSheets[0];
      probe.firstOwnerTag = (first?.ownerNode as Element | null)?.tagName ?? null;
      probe.firstHref = first?.href ?? null;

      const styleEl = document.getElementById("inline-css") as HTMLStyleElement;
      probe.styleSheetType = typeof styleEl.sheet;
      probe.styleSheetCssRulesLen = styleEl.sheet!.cssRules.length;

      const iconEl = document.querySelector('link[rel="icon"]') as HTMLLinkElement;
      probe.iconSheet = iconEl.sheet;

      first!.insertRule(".x{}", 0);
      first!.deleteRule(0);
      probe.ok = true;
    } catch (e) {
      probe.ok = false;
      probe.err = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }
    return probe;
  });
}

test("stylesheet collection stubs are iterable and safe", async ({ page }) => {
  const probe = await sheetProbe(page);

  expect(probe.ok, "stylesheet operations complete without throwing").toBe(true);
  expect(probe.styleSheetsExists, "document.styleSheets exists").toBe(true);
  expect(probe.styleSheetsIterable, "document.styleSheets is iterable").toBe(true);
  expect(probe.firstOwnerTag, "first sheet owner is the style element").toBe("STYLE");
  expect(probe.firstHref, "first inline sheet href is null").toBe(null);
  expect(probe.styleSheetType, "styleEl.sheet is an object").toBe("object");
  expect(probe.styleSheetCssRulesLen, "styleEl.sheet.cssRules holds the inline rule").toBe(1);
  expect(probe.iconSheet, "a link rel=icon has no stylesheet").toBe(null);
});

test.fails("a link rel=stylesheet without href adds no stylesheet", async ({ page }) => {
  // Gap: the engine lists a link rel=stylesheet with no href as an empty sheet.
  const probe = await sheetProbe(page);
  expect(probe.styleSheetsLength, "only the inline style sheet is listed").toBe(1);
  expect(probe.ruleLengths, "the inline sheet is the only sheet").toEqual([1]);
});
