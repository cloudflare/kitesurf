// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Page } from "@cloudflare/puppeteer";

import { expect, test } from "../harness";
import { setContent } from "../set-content";

interface RoundTripProbe {
  ok: boolean;
  err?: string;
  beforeChildren?: number;
  beforeText?: string | null;
  sheetExists?: boolean;
  identitySame?: boolean;
  afterInsertChildren?: number;
  afterInsertText?: string | null;
  cssRulesLen?: number;
  firstRuleText?: string | false;
  twoRulesLen?: number;
  afterDeleteLen?: number;
  afterDeleteFirstText?: string | false;
}

async function roundTrip(page: Page): Promise<RoundTripProbe> {
  await setContent(
    page,
    `<!doctype html>
    <html><head>
    <style id="s">.original { color: red; }</style>
    </head><body>
    <div class="dynamic" id="t">test</div>
    </body></html>
  `,
  );

  return page.evaluate(() => {
    const probe: RoundTripProbe = { ok: false };
    try {
      const s = document.getElementById("s") as HTMLStyleElement;
      probe.beforeChildren = s.childNodes.length;
      probe.beforeText = s.textContent;
      probe.sheetExists = !!s.sheet;
      probe.identitySame = s.sheet === s.sheet;

      s.sheet!.insertRule(".dynamic { color: blue; }", 0);
      probe.afterInsertChildren = s.childNodes.length;
      probe.afterInsertText = s.textContent;
      probe.cssRulesLen = s.sheet!.cssRules.length;
      probe.firstRuleText = s.sheet!.cssRules[0] && s.sheet!.cssRules[0].cssText;

      s.sheet!.insertRule(".second { color: green; }", 1);
      probe.twoRulesLen = s.sheet!.cssRules.length;

      s.sheet!.deleteRule(0);
      probe.afterDeleteLen = s.sheet!.cssRules.length;
      probe.afterDeleteFirstText = s.sheet!.cssRules[0] && s.sheet!.cssRules[0].cssText;
      probe.ok = true;
    } catch (e) {
      probe.ok = false;
      probe.err = String((e as Error)?.stack || e);
    }
    return probe;
  });
}

test("CSSOM insertRule and deleteRule update the live rule list", async ({ page }) => {
  const probe = await roundTrip(page);

  expect(probe.ok, "CSSOM mutations complete without throwing").toBe(true);
  expect(probe.sheetExists, "style element exposes a stylesheet").toBe(true);
  expect(probe.identitySame, "repeated sheet reads preserve identity").toBe(true);
  expect(probe.beforeText?.includes(".original"), "starting text contains the original CSS").toBe(
    true,
  );
  expect(probe.afterInsertChildren, "insertRule leaves the style childNodes unchanged").toBe(
    probe.beforeChildren,
  );
  expect(probe.cssRulesLen, "insertRule adds one rule to cssRules").toBe(2);
  expect(probe.firstRuleText, "cssRules[0].cssText round-trips the inserted rule").toBe(
    ".dynamic { color: blue; }",
  );
  expect(probe.twoRulesLen, "a second insertRule extends cssRules").toBe(3);
  expect(probe.afterDeleteLen, "deleteRule reduces cssRules length").toBe(2);
  expect(probe.afterDeleteFirstText, "deleteRule(0) removes the first rule").toBe(
    ".second { color: green; }",
  );
});

test.fails("insertRule leaves the style element text unchanged", async ({ page }) => {
  // Gap: the engine rewrites the style element text on insertRule.
  const probe = await roundTrip(page);
  expect(probe.afterInsertText, "style textContent is unchanged").toBe(probe.beforeText);
});
