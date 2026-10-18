// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("boa-evalless-phase4", async ({ page }) => {
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
  await session.send("Page.navigate", { url: "https://example.com/__fixtures/inline-script.html" });
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

  expect(await evalExpr("(async()=>40+2)()"), "async IIFE returns value").toStrictEqual(42);
  expect(await evalExpr("Promise.resolve(7).then(x=>x+1)"), "boa Promise chain").toStrictEqual(8);

  expect(
    await evalExpr(
      "(async()=>{const r=await fetch('https://example.com/__fixtures/inline-script.html');return r.status})()",
    ),
    "await fetch(...).status",
  ).toStrictEqual(200);
  expect(
    await evalExpr("fetch('https://example.com/__fixtures/inline-script.html').then(r=>r.status)"),
    "fetch(...).then(r=>r.status)",
  ).toStrictEqual(200);
  expect(
    await evalExpr(
      "(async()=>{const r=await fetch('https://example.com/__fixtures/inline-script.html');const t=await r.text();return t.length>0})()",
    ),
    "await fetch then await text().length>0",
  ).toStrictEqual(true);
  expect(
    await evalExpr(
      "(async()=>{const rs=await Promise.all([fetch('https://example.com/__fixtures/inline-script.html'),fetch('https://example.com/__fixtures/inline-script.html')]);return rs.map(r=>r.status).join(',')})()",
    ),
    "Promise.all([fetch,fetch]) statuses",
  ).toStrictEqual("200,200");
});
