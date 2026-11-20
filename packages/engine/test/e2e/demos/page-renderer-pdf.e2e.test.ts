// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Page } from "@cloudflare/puppeteer";
import { createHash } from "node:crypto";

import { expect, test } from "../harness";

const FIXTURE = "https://ks.invalid/__fixtures/image-heavy.html?n=8&side=512";
// The unbanded renderer's bytes, pinned so a streaming change shows up as a diff.
const EXPECTED_PDF_SHA256 = "bff285e3a33451d4444e004b49373f7ad4b62bfa3c09be0b8add8b37aa917ea2";

async function pdfFor(
  page: Page,
  url: string,
): Promise<{
  bytes: Uint8Array;
  psDeltaBytes: number;
}> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 500));
  const cdp = await page.createCDPSession();
  const reply = await cdp.send("Page.printToPDF", { printBackground: true });
  expect(reply.error, "printToPDF error").toBeUndefined();
  const bytes = Uint8Array.from(atob(reply.data), (c) => c.charCodeAt(0));
  const mem = await cdp.send("Kitesurf.getMemoryStats", {});
  const t = Object.values(mem.byTarget ?? {}).find(
    (v) => v && typeof v.wasmDeltaBytes === "number",
  );
  return { bytes, psDeltaBytes: t?.wasmDeltaBytes ?? 0 };
}

function pageCount(pdf: Uint8Array): number {
  const text = new TextDecoder("latin1").decode(pdf);
  const m = text.match(/\/Count (\d+)/);
  return m ? Number(m[1]) : 0;
}

test("printToPDF renders via the pageRenderer without inflating pageScript", async ({ page }) => {
  const renderer = await pdfFor(page, FIXTURE);
  expect(createHash("sha256").update(renderer.bytes).digest("hex")).toBe(EXPECTED_PDF_SHA256);
  expect(renderer.bytes.length).toBeGreaterThan(10_000);
  expect(new TextDecoder().decode(renderer.bytes.subarray(0, 5))).toBe("%PDF-");
  expect(pageCount(renderer.bytes)).toBeGreaterThanOrEqual(2);

  console.log(`[pdf] pageScript wasm delta: ${renderer.psDeltaBytes}`);
  expect(renderer.psDeltaBytes).toBeLessThan(10_000_000);
}, 120_000);
