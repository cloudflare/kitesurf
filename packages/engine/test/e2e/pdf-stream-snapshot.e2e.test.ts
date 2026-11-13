// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { CDPSession, Page } from "@cloudflare/puppeteer";

import { expect, test } from "./harness";
import { setContent } from "./set-content";

async function printPdf(
  cdpSession: CDPSession,
): Promise<{ bytes: Uint8Array | null; error?: string }> {
  const result = await cdpSession.send("Page.printToPDF", {});
  if (result.error) return { bytes: null, error: result.error };
  return { bytes: Uint8Array.from(atob(result.data), (character) => character.charCodeAt(0)) };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function printHash(cdpSession: CDPSession): Promise<string> {
  const { bytes, error } = await printPdf(cdpSession);
  expect(error).toBeUndefined();
  if (!bytes) throw new Error("printToPDF returned no data");
  return sha256Hex(bytes);
}

async function printResult(cdpSession: CDPSession): Promise<{ hash: string } | { error: string }> {
  const { bytes, error } = await printPdf(cdpSession);
  if (error) return { error };
  if (!bytes) throw new Error("printToPDF returned no data");
  return { hash: await sha256Hex(bytes) };
}

/** Starts a 1 ms timer that mutates colour, an attribute and the input every tick. */
async function startTicking(page: Page) {
  await page.evaluate(() => {
    Reflect.set(window, "__pdfStreamTicks", 0);
    const timer = window.setInterval(() => {
      const tick = Number(Reflect.get(window, "__pdfStreamTicks")) + 1;
      Reflect.set(window, "__pdfStreamTicks", tick);
      document.body.style.color = tick % 2 === 0 ? "red" : "blue";
      document.body.setAttribute("data-pdf-tick", String(tick));
      const input = document.querySelector("input");
      if (input) input.value = tick % 2 === 0 ? "alpha" : "beta";
    }, 1);
    Reflect.set(window, "__pdfStreamTimer", timer);
  });
}

const tickCount = (page: Page) =>
  page.evaluate(() => Number(Reflect.get(window, "__pdfStreamTicks")));

async function stopTicking(page: Page) {
  await page.evaluate(() => window.clearInterval(Number(Reflect.get(window, "__pdfStreamTimer"))));
}

async function setInputValue(page: Page, value: string) {
  await page.evaluate((next) => {
    const input = document.querySelector("input");
    if (!input) throw new Error("PDF input fixture missing");
    input.value = next;
  }, value);
}

async function setBodyColor(page: Page, color: string) {
  await page.evaluate((next) => {
    document.body.style.color = next;
  }, color);
}

test("PDF streaming holds a stable snapshot and resumes page timers afterward", async ({
  page,
  cdpSession,
}) => {
  const paragraphs = Array.from({ length: 900 }, (_, index) => `<p>Print row ${index}</p>`).join(
    "",
  );
  await setContent(
    page,
    `<style>p { height: 32px; margin: 0 } body { color: red }</style><input value="alpha">${paragraphs}`,
  );
  await setInputValue(page, "alpha");
  const alphaSnapshot = await printHash(cdpSession);

  const exceptions: string[] = [];
  cdpSession.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
    exceptions.push(exceptionDetails.text);
  });
  await cdpSession.send("Runtime.enable");
  await startTicking(page);

  try {
    const duringInterval = await printResult(cdpSession);
    const ticksAfterPrint = await tickCount(page);
    await expect.poll(() => tickCount(page)).toBeGreaterThan(ticksAfterPrint);
    await stopTicking(page);

    await setBodyColor(page, "red");
    await setInputValue(page, "alpha");
    await setInputValue(page, "beta");
    const betaSnapshot = await printHash(cdpSession);
    await setBodyColor(page, "blue");
    const blueSnapshot = await printHash(cdpSession);

    expect(alphaSnapshot).not.toBe(betaSnapshot);
    if ("error" in duringInterval) {
      expect(duringInterval.error).toContain("PDF document changed during scene streaming");
    } else {
      expect([alphaSnapshot, blueSnapshot]).toContain(duringInterval.hash);
    }
    expect(exceptions).toEqual([]);
  } finally {
    await stopTicking(page);
  }
});
