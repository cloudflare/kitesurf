// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

const FIXTURE = "https://ks.invalid/__fixtures/lifecycle.html";
const REOPENED_LOAD_TIMEOUT_MS = 12_000;

test("timer-driven document.open/write/close replays load via the background drain", async ({
  page,
  cdpSession: cdp,
}) => {
  await cdp.send("DOM.enable");

  await page.goto(FIXTURE, { waitUntil: "load" });

  const secondLoad = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), REOPENED_LOAD_TIMEOUT_MS);
    page.once("load", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

  await page.evaluate(`
    setTimeout(() => {
      document.open();
      document.write("<!doctype html><html><body><h1>reopened</h1></body></html>");
      document.close();
    }, 0);
    null
  `);

  expect(await secondLoad).toBe(true);
}, 120_000);

test("eval-driven document.open/write/close replays load after console", async ({ page }) => {
  await page.goto(FIXTURE, { waitUntil: "load" });

  const cdp = await page.createCDPSession();
  const eventOrder: string[] = [];
  let resolveSecondLoad: (loaded: boolean) => void = () => {};
  const secondLoad = new Promise<boolean>((resolve) => {
    resolveSecondLoad = resolve;
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const onConsole = (event: { args: Array<{ value?: unknown }> }) => {
    if (event.args.some(({ value }) => value === "eval-reopen-marker")) {
      eventOrder.push("console");
    }
  };
  const onLoad = () => {
    if (timeout) clearTimeout(timeout);
    eventOrder.push("load");
    resolveSecondLoad(true);
  };

  try {
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    cdp.on("Runtime.consoleAPICalled", onConsole);
    cdp.once("Page.loadEventFired", onLoad);
    timeout = setTimeout(() => resolveSecondLoad(false), REOPENED_LOAD_TIMEOUT_MS);

    await cdp.send("Runtime.evaluate", {
      expression: `document.open();
        document.write("<!doctype html><html><body><h1>reopened</h1></body></html>");
        document.close();
        console.log("eval-reopen-marker");`,
      returnByValue: true,
    });

    expect(await secondLoad).toBe(true);
    expect(eventOrder).toEqual(["console", "load"]);
  } finally {
    if (timeout) clearTimeout(timeout);
    cdp.off("Runtime.consoleAPICalled", onConsole);
    cdp.off("Page.loadEventFired", onLoad);
    await cdp.detach();
  }
}, 120_000);
