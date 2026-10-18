// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("boa-concurrent-import-demo", async ({ page }) => {
  const session = await page.target().createCDPSession();
  await session.send("Page.enable");
  await session.send("Runtime.enable");
  await session.send("Page.navigate", { url: "http://127.0.0.1:8787/__fixtures/concimport.html" });

  const evalExpr = async (expr: string) => {
    const r = await session.send("Runtime.evaluate", { expression: expr, returnByValue: true });
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  await page
    .waitForFunction(() => document.getElementById("out")?.getAttribute("data-status") === "done", {
      timeout: 30_000,
    })
    .catch(() => {});
  const out = await evalExpr(`(() => {
    const el = document.getElementById('out');
    return {
      status: el.getAttribute('data-status'),
      resolved: el.getAttribute('data-resolved'),
      correct: el.getAttribute('data-correct'),
      error: el.getAttribute('data-error'),
    };
  })()`);
  const { status, resolved, correct, error } = out;

  expect(status, "18 concurrent imports: status (error=" + error + ")").toBe("done");
  expect(resolved, "18 concurrent imports: resolved (error=" + error + ")").toBe("18");
  expect(correct, "18 concurrent imports: correct (error=" + error + ")").toBe("18");
});
