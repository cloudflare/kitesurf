// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { setTimeout as sleep } from "node:timers/promises";

import type { CDPSession } from "@cloudflare/puppeteer";
import { expect, test } from "../harness";
import type { Protocol } from "devtools-protocol";

type FontFaceDump = Protocol.Kitesurf.PageDiagnosticResponse<Protocol.Kitesurf.FontFaces>;
type RangeFont = { family: string; faceCount: number };

function fontFaceEntries(dump: FontFaceDump) {
  return Object.values("byTarget" in dump ? dump.byTarget : {});
}

function rangeFontFromDump(dump: FontFaceDump): RangeFont | null {
  let rangeFont: RangeFont | null = null;
  for (const entry of fontFaceEntries(dump)) {
    if (!entry || typeof entry.json !== "string") continue;
    const fams = JSON.parse(entry.json) as RangeFont[];
    rangeFont = fams.find((font) => font.family === "RangeFont") ?? rangeFont;
  }
  return rangeFont;
}

async function waitForRangeFont(cdp: CDPSession): Promise<RangeFont | null> {
  let rangeFont: RangeFont | null = null;
  const faceDeadline = Date.now() + 15_000;
  while (Date.now() < faceDeadline) {
    const dump = await cdp.send("Kitesurf.getFontFaces");
    rangeFont = rangeFontFromDump(dump);
    if (rangeFont && rangeFont.faceCount === 2) break;
    await sleep(25);
  }
  return rangeFont;
}

test("font-face-unicode-range-demo", async ({ browser }) => {
  const FIXTURE_URL = "http://127.0.0.1:8787/__fixtures/font-face-unicode-range.html";

  const pages = await browser.pages();
  const page = pages[0] ?? (await browser.newPage());
  const cdp = await page.createCDPSession();

  await page.goto(FIXTURE_URL, { waitUntil: "load" });
  const rangeFont = await waitForRangeFont(cdp);

  const metrics = await page.evaluate(() => {
    const w = (id: string) => document.getElementById(id)!.getBoundingClientRect().width;
    return {
      target: w("target"),
      control: w("control"),
      cyr: w("cyr"),
      widthDelta: w("target") - w("control"),
    };
  });
  console.log("[font-range] metrics:", JSON.stringify(metrics));

  expect(
    rangeFont !== null && rangeFont.faceCount === 2,
    `RangeFont registered with 2 faces (latin + cyrillic; greek ungated): got ${JSON.stringify(rangeFont)}`,
  ).toBeTruthy();

  expect(
    metrics.target > 0 && metrics.control > 0 && metrics.cyr > 0,
    `all runs rendered: ${JSON.stringify(metrics)}`,
  ).toBeTruthy();

  expect(
    Math.abs(metrics.widthDelta) >= 30,
    `latin run picked the latin subset face (widthDelta >= 30px): widthDelta=${metrics.widthDelta}`,
  ).toBeTruthy();
});
