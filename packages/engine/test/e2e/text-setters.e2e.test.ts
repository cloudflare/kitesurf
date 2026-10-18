// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";
import html from "./html/text-setters.html?raw";

test("innerText/outerText setters follow the HTML fragment steps", async ({ page, cdpSession }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });

  const report = await readJsonReport(cdpSession, "globalThis.__tsReport");

  expect(report).toEqual({
    innerTextBr: true,
    innerTextNull: true,
    innerTextUndefined: true,
    outerTextMerge: true,
    outerTextBrs: true,
    outerTextDetachedThrows: true,
    svgInnerTextExpando: true,
  });
}, 120_000);
