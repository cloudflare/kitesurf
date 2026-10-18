// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { setContent } from "../set-content";

const HTML = `<title>orig</title><div id=out></div><script>var add = new Function('a','b','return a+b'); window.__f1 = add(40,2);var noarg = new Function('return 7*6'); window.__f2 = noarg();var scoped = new Function('scope', 'with(scope){return a*b}'); window.__f3 = scoped({a:6,b:7});var viaCall = Function('return 123')(); window.__f4 = viaCall;document.getElementById('out').textContent = 'f1='+window.__f1+' f2='+window.__f2+' f3='+window.__f3+' f4='+window.__f4;</script>`;

test("boa-evalless-phase11", async ({ page, cdpSession: session }) => {
  await session.send("Page.enable");
  await session.send("Runtime.enable");
  await setContent(page, HTML);

  async function evalExpr(expr) {
    const r = await session.send("Runtime.evaluate", { expression: expr, returnByValue: true });
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }

  expect(
    await evalExpr("document.getElementById('out').textContent"),
    "rendered result line",
  ).toStrictEqual("f1=42 f2=42 f3=42 f4=123");
  expect(await evalExpr("window.__f1"), "new Function(a,b,'return a+b')(40,2)").toStrictEqual(42);
  expect(await evalExpr("window.__f2"), "new Function('return 7*6')()").toStrictEqual(42);
  expect(
    await evalExpr("window.__f3"),
    "with(scope) template compiler, scope passed as arg",
  ).toStrictEqual(42);
  expect(await evalExpr("window.__f4"), "Function('return 123')() (no new)").toStrictEqual(123);
});
