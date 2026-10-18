// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { readJsonReport } from "./eval-report";

const FIXTURE = "https://ks.invalid/__fixtures/img-dimensions.html";

test("img natural dimensions and width IDL follow the HTML rules", async ({
  page,
  cdpSession: cdp,
}) => {
  await page.goto(FIXTURE, { waitUntil: "load" });

  const report = await readJsonReport(cdp, "globalThis.__imgReport");

  expect(report).toEqual({
    svgDefault: true,
    svgViewBoxRatio: true,
    svgWidthPlusRatio: true,
    svgBothAttrs: true,
    rasterNatural: true,
    rasterRenderedWidth: true,
    rasterHiddenWidthFromAttr: true,
    rasterHiddenWidthFromNatural: true,
    blockImgNotStretched: true,
  });
}, 120_000);
