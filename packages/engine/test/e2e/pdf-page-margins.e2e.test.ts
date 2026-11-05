// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import type { Browser } from "@cloudflare/puppeteer";
import { createHash } from "node:crypto";

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

async function pdfPageCount(browser: Browser, pageRule: string, hash: string): Promise<number> {
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
    expect(
      createHash("sha256")
        .update(Buffer.from(reply.data as string, "base64"))
        .digest("hex"),
    ).toBe(hash);
    const count = countPages(Buffer.from(reply.data as string, "base64"));
    expect(count, "parsed a page count").toBeGreaterThan(0);
    return count;
  } finally {
    await page.close();
  }
}

test("@page margins shrink the content box and add pages", async ({ browser }) => {
  expect(
    await pdfPageCount(
      browser,
      "",
      "fb315e1d98b0d4b4f21d3a279912e1f96b0d66b006aab0a7d2a9a7137c3e5dae",
    ),
    "no @page margin",
  ).toBe(4);
  expect(
    await pdfPageCount(
      browser,
      "@page { margin: 2in }",
      "0d41c8a06c56f4d0fcee80ac35c21556a272dc8ef51b65f1123a6df3d656fd95",
    ),
    "@page { margin: 2in }",
  ).toBe(7);
});
