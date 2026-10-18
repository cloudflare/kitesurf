// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("boa-evalless-phase2", async ({ page }) => {
  const session = await page.target().createCDPSession();
  await session.send("Page.enable");
  await session.send("Runtime.enable");
  await session.send("Page.setDocumentContent", {
    frameId: "main",
    html: "<!doctype html><title>boa-bridge</title><body id='b' class='x y'>hi<p>para</p></body>",
  });

  async function evalExpr(expr) {
    const r = await session.send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(d.exception?.description || d.exception?.value || d.text);
    }
    return r.result.value;
  }

  expect(await evalExpr("typeof document"), "typeof document").toStrictEqual("object");
  expect(await evalExpr("document.title"), "document.title").toStrictEqual("boa-bridge");
  expect(await evalExpr("document.nodeType"), "document.nodeType").toStrictEqual(9);

  expect(await evalExpr("document.body.tagName"), "document.body.tagName").toStrictEqual("BODY");
  expect(await evalExpr("document.body.id"), "document.body.id").toStrictEqual("b");
  expect(await evalExpr("document.body.className"), "document.body.className").toStrictEqual("x y");

  expect(await evalExpr("typeof window"), "typeof window").toStrictEqual("object");
  expect(await evalExpr("window.document.title"), "window.document.title").toStrictEqual(
    "boa-bridge",
  );

  expect(await evalExpr("typeof navigator.userAgent"), "typeof navigator.userAgent").toStrictEqual(
    "string",
  );
  expect(await evalExpr("typeof location.href"), "typeof location.href").toStrictEqual("string");

  expect(
    await evalExpr("'the title is: ' + document.title.toUpperCase()"),
    "mix boa + bridge",
  ).toStrictEqual("the title is: BOA-BRIDGE");

  expect(await evalExpr("'body' in document"), "'body' in document").toStrictEqual(true);

  expect(
    await evalExpr("document.querySelectorAll('p').length"),
    "querySelectorAll('p').length",
  ).toStrictEqual(1);
  expect(
    await evalExpr("document.getElementById('b').tagName"),
    "getElementById('b').tagName",
  ).toStrictEqual("BODY");
  expect(
    await evalExpr("document.body.getAttribute('class')"),
    "body.getAttribute('class')",
  ).toStrictEqual("x y");
  expect(
    await evalExpr("document.querySelector('p').textContent"),
    "querySelector('p').textContent",
  ).toStrictEqual("para");
  expect(
    await evalExpr("document.body.classList.contains('x')"),
    "classList.contains('x')",
  ).toStrictEqual(true);
  expect(
    await evalExpr("Array.from(document.querySelectorAll('p')).map(e=>e.tagName).join(',')"),
    "map over querySelectorAll results",
  ).toStrictEqual("P");
  expect(
    await evalExpr("document.title.split('-').length"),
    "title round-trips through a method",
  ).toStrictEqual(2);
});
