// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import type { Protocol } from "devtools-protocol";

interface FaceInfo {
  weight: number;
  hasWghtAxis: boolean;
}

interface FamilyInfo {
  family: string;
  faceCount: number;
  faces: FaceInfo[];
}

type FontFacesDump = Protocol.Kitesurf.PageDiagnosticResponse<Protocol.Kitesurf.FontFaces>;

function findVariableFamily(
  entry: { json?: string; error?: string } | null | undefined,
): FamilyInfo | null {
  if (!entry || typeof entry.json !== "string") return null;
  const families = JSON.parse(entry.json) as FamilyInfo[];
  return families.find((family) => family.family === "VarProbe") ?? null;
}

function findVariableProbe(value: FontFacesDump): FamilyInfo | null {
  const entries = "byTarget" in value ? Object.values(value.byTarget) : [];
  for (const entry of entries) {
    const match = findVariableFamily(entry);
    if (match) return match;
  }
  return null;
}

function assertVariableProbeCount(probe: FamilyInfo | null): void {
  expect(probe?.faceCount, `VarProbe registered with 1 face: got ${JSON.stringify(probe)}`).toBe(1);
}

function assertVariableFaceAxis(face: FaceInfo | undefined): void {
  expect(face?.hasWghtAxis, `face keeps its wght axis: face=${JSON.stringify(face)}`).toBe(true);
}

function assertVariableFaceWeight(face: FaceInfo | undefined): void {
  expect(
    face?.weight,
    `face registers at fvar default 400, not range lower bound 100: face=${JSON.stringify(face)}`,
  ).toBe(400);
}

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

  const dump = await cdp.send("Kitesurf.getFontFaces");
  const varProbe = findVariableProbe(dump);
  assertVariableProbeCount(varProbe);
  const face = varProbe?.faces?.[0];
  assertVariableFaceAxis(face);
  assertVariableFaceWeight(face);

  expect(metrics.w100, `weight 100 span rendered: ${JSON.stringify(metrics)}`).toBeGreaterThan(0);
  expect(metrics.w400, `weight 400 span rendered: ${JSON.stringify(metrics)}`).toBeGreaterThan(0);
  expect(metrics.w900, `weight 900 span rendered: ${JSON.stringify(metrics)}`).toBeGreaterThan(0);

  expect(
    metrics.w400 - metrics.w100 >= 2,
    `weight 100 renders narrower than 400: w100=${metrics.w100} w400=${metrics.w400}`,
  ).toBeTruthy();
  expect(
    metrics.w900 - metrics.w400 >= 2,
    `weight 900 renders wider than 400: w400=${metrics.w400} w900=${metrics.w900}`,
  ).toBeTruthy();
});
