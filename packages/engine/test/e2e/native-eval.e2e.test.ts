// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// KITESURF_NATIVE_EVAL gives page isolates workerd's local native eval, so CDP evaluation and
// page eval run on V8. Without it they run on boa, as on Cloudflare. A V8 stack names the frame
// `eval`, a boa one `<main>` or `<eval>`.
import { env } from "cloudflare:test";
import type { CDPSession } from "@cloudflare/puppeteer";

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const STACK = "new Error('probe').stack.split('\\n')[1]";

async function evaluate(session: CDPSession, expression: string): Promise<unknown> {
  const r = await session.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
  return r.result.value;
}

test("without KITESURF_NATIVE_EVAL, Runtime.evaluate runs on boa", async ({ cdpSession }) => {
  expect(await evaluate(cdpSession, STACK)).toMatch(/^\s+at <main>/);
});

test("with KITESURF_NATIVE_EVAL, CDP and page evaluation run on V8", async ({ browserFactory }) => {
  const browser = await browserFactory({ engine: env.ENGINE_NATIVE_EVAL });
  const page = await browser.newPage();
  const session = await page.createCDPSession();
  try {
    await setContent(page, `<script>window.answer = () => 42;</script>`);
    expect(await evaluate(session, STACK)).toMatch(/^\s+at eval \(/);
    expect(await evaluate(session, `eval(${JSON.stringify(STACK)})`)).toMatch(/^\s+at eval \(/);
    expect(await evaluate(session, "new Function('return answer()')()")).toBe(42);

    const { result } = await session.send("Runtime.evaluate", { expression: "document.body" });
    const called = await session.send("Runtime.callFunctionOn", {
      functionDeclaration: `function () { return [this.tagName, ${STACK}]; }`,
      objectId: result.objectId,
      returnByValue: true,
    });
    const [tagName, frame] = called.result.value as [string, string];
    expect(tagName).toBe("BODY");
    expect(frame).toMatch(/^\s+at /);
    expect(frame).not.toMatch(/at <(?:main|eval)>/);
  } finally {
    await session.detach().catch(() => {});
    await page.close();
  }
});

test("with KITESURF_NATIVE_EVAL, an expression that mentions `await` still evaluates", async ({
  browserFactory,
}) => {
  const browser = await browserFactory({ engine: env.ENGINE_NATIVE_EVAL });
  const page = await browser.newPage();
  const session = await page.createCDPSession();
  try {
    // Statements around `await` in a string do not parse as an async function's return value.
    expect(await evaluate(session, "var s = 'await'; s.length")).toBe(5);
    expect(await evaluate(session, "await Promise.resolve(7)")).toBe(7);
    // Without awaitPromise, a promise stays a promise.
    const pending = await session.send("Runtime.evaluate", { expression: "Promise.resolve(1)" });
    expect(pending.result.className).toBe("Promise");
    const mentions = await session.send("Runtime.evaluate", {
      expression: "Promise.resolve('await')",
    });
    expect(mentions.result.className).toBe("Promise");
  } finally {
    await session.detach().catch(() => {});
    await page.close();
  }
});
