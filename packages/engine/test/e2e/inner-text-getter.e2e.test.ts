// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";
import html from "./html/inner-text-getter.html?raw";

test("innerText getter follows the rendered-text collection steps", async ({
  page,
  cdpSession,
}) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });

  const report = await readJsonReport(cdpSession, "globalThis.__itReport");

  expect(report).toEqual({
    collapse: true,
    hardBreak: true,
    blocks: true,
    hidden: true,
    pre: true,
    table: true,
    notRenderedFallsBack: true,
  });
}, 120_000);
