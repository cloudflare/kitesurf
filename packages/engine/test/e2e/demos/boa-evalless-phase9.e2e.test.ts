// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Protocol } from "devtools-protocol";

import { expect, test } from "../harness";

function exceptionMessage(details: Protocol.Runtime.ExceptionDetails): string {
  return String(details.exception?.description || details.exception?.value || details.text);
}
import { setContent } from "../set-content";

const HTML = `<title>orig</title><div id=out></div><script>window.__e1 = eval('40+2');document.body.setAttribute('data-e2', eval('[1,2,3].map(x=>x*2).join("-")'));window.__e3 = typeof eval('({a:1})');window.__e4 = eval('({x:5,y:[1,2]})').y[1];var f = eval('(a=>a*10)'); window.__e5 = f(4);document.getElementById('out').textContent = 'e1='+window.__e1+' e4='+window.__e4+' e5='+window.__e5;</script>`;

test("boa-evalless-phase9", async ({ page, cdpSession: session }) => {
  await session.send("Page.enable");
  await session.send("Runtime.enable");

  await setContent(page, HTML);

  async function evalExpr(expr) {
    const r = await session.send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(exceptionMessage(r.exceptionDetails));
    return r.result.value;
  }

  expect(await evalExpr("window.__e1"), "eval('40+2') primitive").toStrictEqual(42);
  expect(
    await evalExpr("document.body.getAttribute('data-e2')"),
    "eval expr -> attribute",
  ).toStrictEqual("2-4-6");
  expect(await evalExpr("window.__e3"), "eval object result is usable (typeof)").toStrictEqual(
    "object",
  );
  expect(
    await evalExpr("window.__e4"),
    "eval object nested read (V8 uses the result)",
  ).toStrictEqual(2);
  expect(
    await evalExpr("window.__e5"),
    "eval returns a FUNCTION, V8 calls it (trampoline)",
  ).toStrictEqual(40);
});
