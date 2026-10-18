// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("font-face-variable-demo", async ({ browser }) => {
  const FIXTURE_URL = "http://127.0.0.1:8787/__fixtures/font-face-variable.html";

  const pages = await browser.pages();
  const page = pages[0] ?? (await browser.newPage());
  const cdp = await page.createCDPSession();

  await page.goto(FIXTURE_URL, { waitUntil: "load" });

  await page.evaluate(() => document.fonts.ready);

  const metrics = await page.evaluate(() => {
    const w = (id: string) => document.getElementById(id)!.getBoundingClientRect().width;
    return { w100: w("w100"), w400: w("w400"), w900: w("w900") };
  });
  console.log("[font-var] metrics:", JSON.stringify(metrics));

  interface FaceInfo {
    weight: number;
    hasWghtAxis: boolean;
  }
  interface FamilyInfo {
    family: string;
    faceCount: number;
    faces: FaceInfo[];
  }
  const dump = await cdp.send("Kitesurf.getFontFaces");
  let varProbe: FamilyInfo | null = null;
  for (const entry of Object.values("byTarget" in dump ? dump.byTarget : {})) {
    if (!entry || typeof entry.json !== "string") continue;
    const fams = JSON.parse(entry.json) as FamilyInfo[];
    varProbe = fams.find((f) => f.family === "VarProbe") ?? varProbe;
  }
  expect(
    varProbe !== null && varProbe.faceCount === 1,
    `VarProbe registered with 1 face: got ${JSON.stringify(varProbe)}`,
  ).toBeTruthy();
  const face = varProbe?.faces?.[0];
  expect(
    face?.hasWghtAxis === true,
    `face keeps its wght axis: face=${JSON.stringify(face)}`,
  ).toBeTruthy();
  expect(
    face?.weight === 400,
    `face registers at fvar default 400, not range lower bound 100: face=${JSON.stringify(face)}`,
  ).toBeTruthy();

  expect(
    metrics.w100 > 0 && metrics.w400 > 0 && metrics.w900 > 0,
    `all three spans rendered: ${JSON.stringify(metrics)}`,
  ).toBeTruthy();

  expect(
    metrics.w400 - metrics.w100 >= 2,
    `weight 100 renders narrower than 400: w100=${metrics.w100} w400=${metrics.w400}`,
  ).toBeTruthy();
  expect(
    metrics.w900 - metrics.w400 >= 2,
    `weight 900 renders wider than 400: w400=${metrics.w400} w900=${metrics.w900}`,
  ).toBeTruthy();
});
