// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("boa-evalless-phase10b", async ({ page }) => {
  const ORIGIN = "http://127.0.0.1:8787";
  const session = await page.target().createCDPSession();
  await session.send("Page.enable");
  await session.send("Runtime.enable");
  await session.send("Page.navigate", { url: `${ORIGIN}/__fixtures/dynimport-var.html` });
  await page
    .waitForFunction(() => document.getElementById("out")?.getAttribute("data-compute") === "42", {
      timeout: 15_000,
    })
    .catch(() => {});

  async function evalExpr(expr) {
    const r = await session.send("Runtime.evaluate", { expression: expr, returnByValue: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(d.exception?.description || d.exception?.value || d.text);
    }
    return r.result.value;
  }

  expect(
    await evalExpr("document.getElementById('out').getAttribute('data-compute')"),
    "function export via __ks_import (compute)",
  ).toBe("42");
  expect(
    await evalExpr("document.getElementById('out').textContent"),
    "value export via __ks_import",
  ).toBe("var-val=42");
});
