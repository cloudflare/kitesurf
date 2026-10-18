// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

interface EvalResult {
  result?: { value?: unknown };
  exceptionDetails?: { exception?: { description?: string } };
}

test("fresh page has a document without navigating", async ({ cdpSession: cdp }) => {
  const r = (await cdp.send("Runtime.evaluate", {
    expression: `JSON.stringify({
      win: typeof window,
      doc: typeof document,
      body: typeof document.body,
      title: typeof document.title,
    })`,
    returnByValue: true,
  })) as EvalResult;
  expect(r.exceptionDetails).toBeFalsy();
  expect(JSON.parse(String(r.result?.value))).toEqual({
    win: "object",
    doc: "object",
    body: "object",
    title: "string",
  });
}, 120_000);

test("addBinding before any navigate installs on the blank page", async ({ cdpSession: cdp }) => {
  const events: Array<{ name: string; payload: string }> = [];
  cdp.on("Runtime.bindingCalled", (e) => events.push(e as never));

  await cdp.send("Runtime.addBinding", { name: "ksBlankBinding" });
  const seen = (await cdp.send("Runtime.evaluate", {
    expression: `JSON.stringify({
      onGlobalThis: typeof globalThis.ksBlankBinding,
      onWindow: typeof window.ksBlankBinding,
    })`,
    returnByValue: true,
  })) as EvalResult;
  expect(JSON.parse(String(seen.result?.value))).toEqual({
    onGlobalThis: "function",
    onWindow: "function",
  });

  await cdp.send("Runtime.evaluate", {
    expression: `window.ksBlankBinding("from-blank"); null`,
  });
  await expect
    .poll(() => events.some((e) => e.payload === "from-blank"), {
      timeout: 10_000,
    })
    .toBe(true);
}, 120_000);

test("puppeteer exposeFunction round-trips with no navigation", async ({ page }) => {
  await page.exposeFunction("ksBlankCompute", (a: number, b: number) => a * b);
  const result = await page.evaluate("window.ksBlankCompute(6, 7)");
  expect(result).toBe(42);
}, 120_000);
