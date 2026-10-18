// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";
import html from "./html/idl-interface-shape.html?raw";

test("idlStub interface objects have WebIDL name/class-string shape", async ({
  page,
  cdpSession,
}) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });

  const report = await readJsonReport(cdpSession, "globalThis.__idlReport");

  expect(
    await page.evaluate(() => [typeof HTMLDocument, document instanceof HTMLDocument]),
  ).toEqual(["function", true]);

  for (const name of [
    "ValidityState",
    "TimeRanges",
    "MediaError",
    "CanvasRenderingContext2D",
    "Storage",
    "Navigation",
    "HTMLElement",
  ]) {
    expect(report[name], name).toEqual({
      name,
      ctorTag: "[object Function]",
      protoTag: `[object ${name}]`,
      tagIsData: true,
      tagEnumerable: false,
    });
  }
}, 120_000);
