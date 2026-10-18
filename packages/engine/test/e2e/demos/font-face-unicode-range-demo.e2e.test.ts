// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { setTimeout as sleep } from "node:timers/promises";

import { expect, test } from "../harness";

test("font-face-unicode-range-demo", async ({ browser }) => {
  const FIXTURE_URL = "http://127.0.0.1:8787/__fixtures/font-face-unicode-range.html";

  const pages = await browser.pages();
  const page = pages[0] ?? (await browser.newPage());
  const cdp = await page.createCDPSession();

  await page.goto(FIXTURE_URL, { waitUntil: "load" });

  let rangeFont: { family: string; faceCount: number } | null = null;
  const faceDeadline = Date.now() + 15_000;
  while (Date.now() < faceDeadline) {
    const dump = await cdp.send("Kitesurf.getFontFaces");
    rangeFont = null;
    for (const entry of Object.values("byTarget" in dump ? dump.byTarget : {})) {
      if (!entry || typeof entry.json !== "string") continue;
      const fams = JSON.parse(entry.json) as {
        family: string;
        faceCount: number;
      }[];
      rangeFont = fams.find((f) => f.family === "RangeFont") ?? rangeFont;
    }
    if (rangeFont && rangeFont.faceCount === 2) break;
    await sleep(25);
  }

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
