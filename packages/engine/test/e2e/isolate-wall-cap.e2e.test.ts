// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

interface ConsoleEvent {
  type: string;
  args?: Array<{ value?: unknown }>;
}

function eventText(event: ConsoleEvent): string {
  return String(event.args?.[0]?.value ?? "");
}

function isWallClockError(event: ConsoleEvent, text: string): boolean {
  return event.type === "error" && text.includes("wall-clock");
}

test("wall-clock cap kills the page isolate and surfaces to the client", async ({
  browserFactory,
}) => {
  const browser = await browserFactory({ query: "?ksWallCapMs=4000" });
  const page = await browser.newPage();
  const cdp = await page.createCDPSession();
  const crashed = new Promise<string>((resolve) => {
    cdp.on("Inspector.targetCrashed", () => resolve("Inspector.targetCrashed"));
    page.once("error", (e) => resolve(`page error: ${e.message}`));
  });
  const consoleErr = new Promise<string>((resolve) => {
    cdp.on("Runtime.consoleAPICalled", (ev) => {
      const e = ev as ConsoleEvent;
      const text = eventText(e);
      if (isWallClockError(e, text)) resolve(text);
    });
  });
  const gotoOk = await page
    .goto("https://ks.invalid/__fixtures/accessibility.html", {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    })
    .then(() => true)
    .catch(() => false);
  const crashSignal = await Promise.race([
    crashed,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("no crash event within 15s")), 15_000),
    ),
  ]);
  expect(crashSignal).toBeTruthy();
  const text = await Promise.race([
    consoleErr,
    new Promise<string>((resolve) => setTimeout(() => resolve(""), 3_000)),
  ]);
  expect(text).toContain("wall-clock time limit (4000 ms)");
  if (gotoOk) {
    await expect(page.evaluate(() => 1 + 1)).rejects.toThrow(/wall-clock cap/);
  }
});
