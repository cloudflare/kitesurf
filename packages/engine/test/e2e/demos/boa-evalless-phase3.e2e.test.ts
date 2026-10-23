// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Protocol } from "devtools-protocol";

import { expect, test } from "../harness";

function exceptionMessage(details: Protocol.Runtime.ExceptionDetails): string {
  return String(details.exception?.description || details.exception?.value || details.text);
}

test("boa-evalless-phase3", async ({ page }) => {
  const session = await page.target().createCDPSession();
  await session.send("Page.enable");
  await session.send("Runtime.enable");
  await session.send("Page.setDocumentContent", {
    frameId: "main",
    html: "<!doctype html><title>w</title><body><div id='root'></div><p class='item'>a</p><p class='item'>b</p></body>",
  });

  async function evalExpr(expr) {
    const r = await session.send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(exceptionMessage(r.exceptionDetails));
    return r.result.value;
  }

  expect(
    await evalExpr("(()=>{const d=document.getElementById('root');d.id='changed';return d.id})()"),
    "set id then read",
  ).toStrictEqual("changed");

  expect(
    await evalExpr(
      "(()=>{const d=document.getElementById('changed');d.setAttribute('data-x','42');return d.getAttribute('data-x')})()",
    ),
    "setAttribute + getAttribute",
  ).toStrictEqual("42");

  expect(
    await evalExpr(
      "(()=>{const d=document.getElementById('changed');d.textContent='hello boa';return d.textContent})()",
    ),
    "textContent write",
  ).toStrictEqual("hello boa");

  expect(
    await evalExpr(
      "(()=>{const s=document.createElement('span');s.textContent='kid';document.body.appendChild(s);return document.body.lastChild.tagName})()",
    ),
    "createElement + appendChild(bridged) -> lastChild.tagName",
  ).toStrictEqual("SPAN");

  expect(
    await evalExpr("document.body.lastChild.textContent"),
    "appended child textContent",
  ).toStrictEqual("kid");

  expect(
    await evalExpr(
      "(()=>{const d=document.getElementById('changed');d.className='a b c';return d.classList.contains('b')})()",
    ),
    "className set -> classList.contains",
  ).toStrictEqual(true);

  await evalExpr(
    "(()=>{const d=document.getElementById('changed');d.setAttribute('data-persist','yes');return 1})()",
  );
  expect(
    await evalExpr("document.getElementById('changed').getAttribute('data-persist')"),
    "mutation persists across evals",
  ).toStrictEqual("yes");

  expect(
    await evalExpr(
      "(()=>{const out=[];document.querySelectorAll('.item').forEach((e,i)=>out.push(i+':'+e.tagName));return out.join(',')})()",
    ),
    "NodeList.forEach(boaFn) with index + element",
  ).toStrictEqual("0:P,1:P");
  expect(
    await evalExpr(
      "(()=>{document.querySelectorAll('.item').forEach(e=>e.setAttribute('data-seen','1'));return document.querySelectorAll('[data-seen]').length})()",
    ),
    "forEach callback mutates each element (nested bridge call)",
  ).toStrictEqual(2);
  expect(
    await evalExpr(
      "(()=>{let n=0;document.querySelectorAll('.item').forEach(e=>{n+=e.textContent.length});return n})()",
    ),
    "boa closure state survives across trampoline calls",
  ).toStrictEqual(2);

  expect(
    await evalExpr("(()=>{document.body.__boa={a:1,b:[2,3]};return document.body.__boa.b[1]})()"),
    "store boa object on element, read nested back",
  ).toStrictEqual(3);
  expect(
    await evalExpr(
      "(()=>{document.body.__boa2={name:'x',n:41};const o=document.body.__boa2;return o.name+(o.n+1)})()",
    ),
    "boa object props survive the V8 round-trip",
  ).toStrictEqual("x42");
});
