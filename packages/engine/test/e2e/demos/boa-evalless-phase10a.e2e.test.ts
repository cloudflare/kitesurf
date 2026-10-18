// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("boa-evalless-phase10a", async ({ page }) => {
  const ORIGIN = process.env.KITESURF_ORIGIN ?? "http://127.0.0.1:8787";

  const session = await page.target().createCDPSession();
  await session.send("Page.enable");
  await session.send("Runtime.enable");
  const loaded = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 15_000);
    session.once("Page.loadEventFired", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await session.send("Page.navigate", { url: `${ORIGIN}/__fixtures/dynimport.html` });
  await loaded;

  async function evalExpr(expr) {
    const r = await session.send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(d.exception?.description || d.exception?.value || d.text);
    }
    return r.result.value;
  }

  expect(
    await evalExpr("import('/__fixtures/dynimport-chunk.js').then(m => m.value)"),
    "import(...).then(m => m.value)",
  ).toStrictEqual(42);
  expect(
    await evalExpr("import('/__fixtures/dynimport-chunk.js').then(m => m.compute(20,22))"),
    "import(...).then uses a function export",
  ).toStrictEqual(42);
  expect(
    await evalExpr(
      "(async()=>{const m = await import('/__fixtures/dynimport-chunk.js'); return m.compute(1,1)})()",
    ),
    "await import(...) then compute",
  ).toStrictEqual(2);
  expect(
    await evalExpr(
      "Promise.all([import('/__fixtures/dynimport-chunk.js'),import('/__fixtures/dynimport-chunk.js')]).then(([a,b])=>a.value+b.value)",
    ),
    "second import of same URL (cache)",
  ).toStrictEqual(84);
});
