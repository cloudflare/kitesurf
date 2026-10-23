// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Protocol } from "devtools-protocol";

import { expect, test } from "../harness";

function exceptionMessage(details: Protocol.Runtime.ExceptionDetails): string {
  return String(details.exception?.description || details.exception?.value || details.text);
}

test("boa-evalless-phase1", async ({ page }) => {
  const session = await page.target().createCDPSession();
  await session.send("Page.enable");
  await session.send("Runtime.enable");
  await session.send("Page.setDocumentContent", {
    frameId: "main",
    html: "<!doctype html><title>boa</title><body>hi</body>",
  });

  async function evalExpr(expr, returnByValue = true) {
    const r = await session.send("Runtime.evaluate", {
      expression: expr,
      returnByValue,
    });
    if (r.exceptionDetails) throw new Error(exceptionMessage(r.exceptionDetails));
    return r.result;
  }

  expect((await evalExpr("2+2")).value, "arithmetic 2+2").toStrictEqual(4);
  expect((await evalExpr("'a'+'b'+'c'")).value, "string concat").toStrictEqual("abc");
  expect((await evalExpr("[1,2,3].map(x=>x*2)")).value, "array map").toStrictEqual([2, 4, 6]);
  expect((await evalExpr("({a:1,b:[2,3],c:'x'})")).value, "object literal").toStrictEqual({
    a: 1,
    b: [2, 3],
    c: "x",
  });
  expect((await evalExpr("JSON.stringify({a:1,b:[2,3]})")).value, "JSON.stringify").toStrictEqual(
    '{"a":1,"b":[2,3]}',
  );
  expect(
    (await evalExpr("(()=>{let s=0;for(let i=0;i<10;i++)s+=i;return s})()")).value,
    "IIFE loop+closure",
  ).toStrictEqual(45);
  expect((await evalExpr("1 < 2 && 3 >= 3")).value, "boolean").toStrictEqual(true);
  expect((await evalExpr("typeof {}")).value, "typeof").toStrictEqual("object");
  expect((await evalExpr("[...'abc'].reverse().join('')")).value, "spread+reverse").toStrictEqual(
    "cba",
  );
  expect((await evalExpr("null")).value, "null").toStrictEqual(null);
  expect((await evalExpr("`${2*21}!`")).value, "template literal").toStrictEqual("42!");
  expect(
    (await evalExpr("(()=>{const [a,b]=[Math.max(1,9),Math.min(4,2)];return a+b})()")).value,
    "Math + destructuring",
  ).toStrictEqual(11);

  const arrRO = await evalExpr("[9,8,7]", false);
  expect(arrRO.type, "array RemoteObject type").toStrictEqual("object");
  expect(arrRO.subtype, "array RemoteObject subtype").toStrictEqual("array");

  await expect(
    evalExpr("(function(){throw new Error('boom')})()"),
    "throw -> exceptionDetails",
  ).rejects.toThrow();
});
