// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import type { Browser } from "@cloudflare/puppeteer";

// A CDP reply that carries a byte stream must serialize: Workers RPC refuses an instance of a
// class the page installed over the shared global, so the engine builds its streams from a
// captured constructor instead.

const PAGE = "data:text/html;charset=utf-8," + encodeURIComponent("<!doctype html><p>x</p>");

const TAMPERS: Record<string, string> = {
  "globalThis.ReadableStream": `
    globalThis.ReadableStream = class ReadableStream { constructor() {} };`,
  "var ReadableStream": `
    var ReadableStream = function () {};`,
  "delegating subclass": `
    const Real = ReadableStream;
    globalThis.ReadableStream = class extends Real {};`,
};

async function printPdf(browser: Browser, tamper: string | null): Promise<string> {
  const page = await browser.newPage();
  try {
    const session = await page.createCDPSession();
    await page.goto(PAGE, { timeout: 30000, waitUntil: "domcontentloaded" });
    if (tamper) await page.evaluate(tamper);
    const reply = (await session.send("Page.printToPDF", {
      paperWidth: 8.5,
      paperHeight: 11,
    })) as { data?: string; error?: string };
    expect(reply.error, "printToPDF rejected").toBeUndefined();
    return Buffer.from(reply.data ?? "", "base64").toString("latin1");
  } finally {
    await page.close();
  }
}

test("a page's own ReadableStream does not break printToPDF", async ({ browser }) => {
  const control = await printPdf(browser, null);
  expect(control.startsWith("%PDF")).toBe(true);

  for (const [name, tamper] of Object.entries(TAMPERS)) {
    const pdf = await printPdf(browser, tamper);
    expect(pdf.startsWith("%PDF"), name).toBe(true);
    expect(pdf.length, name).toBeGreaterThan(control.length / 2);
  }
}, 200_000);
