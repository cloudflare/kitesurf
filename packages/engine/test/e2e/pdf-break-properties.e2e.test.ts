// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Page } from "@cloudflare/puppeteer";
import { createHash } from "node:crypto";

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const ZERO_MARGIN = {
  marginTop: 0,
  marginBottom: 0,
  marginLeft: 0,
  marginRight: 0,
  paperWidth: 8.5,
  paperHeight: 11,
};

function countPdfPages(buf: Uint8Array): number {
  const s = Buffer.from(buf).toString("latin1");
  const m = s.match(/\/Type\s*\/Page[^s]/g);
  return m ? m.length : 0;
}

async function printPdf(page: Page, html: string): Promise<{ pages: number; hash: string }> {
  await setContent(page, html);
  const cdp = await page.createCDPSession();
  const reply = (await cdp.send("Page.printToPDF", ZERO_MARGIN)) as { data: string };
  const bytes = Buffer.from(reply.data, "base64");
  return {
    pages: countPdfPages(new Uint8Array(bytes)),
    hash: createHash("sha256").update(bytes).digest("hex"),
  };
}

test("break-before:page forces one PDF page per section", async ({ page }) => {
  const printed = await printPdf(
    page,
    `<style>
  body { margin: 0; font: 16px/1.5 sans-serif; }
  section { height: 400px; break-before: page; background: #eee; }
  section:first-of-type { break-before: auto; }
  .keep { height: 300px; break-inside: avoid; background: #cde; }
</style>
<section>one</section>
<section>two</section>
<section>three</section>
<div class="keep">keep-together</div>`,
  );

  expect(printed.hash, "printToPDF bytes").toBe(
    "d921d2c9ec05a0d9b945a99a7780e0eadf84c172a731358beb5700734f0cea88",
  );
  expect(printed.pages).toBe(3);
}, 120_000);

test("break-inside:avoid moves blocks the heuristic would cut", async ({ page }) => {
  const printed = await printPdf(
    page,
    `<style>
  body { margin: 0; }
  .filler { height: 500px; background: #eee; }
  .keep { height: 600px; break-inside: avoid; background: #cde; }
  .keep + .keep { background: #dec; }
</style>
<div class="filler"></div>
<div class="keep"></div>
<div class="keep"></div>`,
  );

  expect(printed.hash, "printToPDF bytes").toBe(
    "d99517aa24982082ae7414450e4ccfed58fbcb65a1d64f5b6b5803fe04b8e557",
  );
  expect(printed.pages).toBe(3);
}, 120_000);
