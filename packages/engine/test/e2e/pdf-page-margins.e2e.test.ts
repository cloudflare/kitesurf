// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import type { Browser } from "@cloudflare/puppeteer";
import { createHash } from "node:crypto";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function doc(pageRule: string): string {
  const blocks = Array.from(
    { length: 40 },
    (_, i) => `<p style="height:100px;margin:0">block ${i}</p>`,
  ).join("");
  return (
    "data:text/html;base64," +
    Buffer.from(
      `<!doctype html><html><head><style>${pageRule}
       body { margin: 0; font: 16px sans-serif }</style></head>
       <body>${blocks}</body></html>`,
    ).toString("base64")
  );
}

function countPages(bytes: Buffer): number {
  const s = bytes.toString("latin1");
  return (s.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
}

async function printPdf(
  browser: Browser,
  pageRule: string,
): Promise<{ pages: number; hash: string }> {
  const page = await browser.newPage();
  try {
    const session = await page.createCDPSession();
    await page.goto(doc(pageRule), {
      timeout: 30000,
      waitUntil: "domcontentloaded",
    });
    const reply = (await session.send("Page.printToPDF", {
      paperWidth: 8.5,
      paperHeight: 11,
    })) as { data?: string; error?: string };
    expect(reply.error, "printToPDF error").toBeUndefined();
    expect(typeof reply.data).toBe("string");
    const bytes = Buffer.from(reply.data as string, "base64");
    const pages = countPages(bytes);
    expect(pages, "parsed a page count").toBeGreaterThan(0);
    return { pages, hash: sha256(bytes) };
  } finally {
    await page.close();
  }
}

const PAGE_MARGIN_CASES = [
  {
    pageRule: "",
    label: "no @page margin",
    pages: 4,
    hash: "2eb932d3b42ff105a572a1dda789cba09481f96f92abc890be902f956e2cd675",
  },
  {
    pageRule: "@page { margin: 2in }",
    label: "@page { margin: 2in }",
    pages: 7,
    hash: "2908b30d07f47f1c70d2ff52e52accf654a0b5f898e9e83def595e520ed381b3",
  },
];

test("@page margins shrink the content box and add pages", async ({ browser }) => {
  for (const { pageRule, label, pages, hash } of PAGE_MARGIN_CASES) {
    const printed = await printPdf(browser, pageRule);
    expect(printed.hash, `${label} document bytes`).toBe(hash);
    expect(printed.pages, label).toBe(pages);
  }
});
