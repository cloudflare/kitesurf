// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

interface EvalResult {
  result?: { value?: unknown };
  exceptionDetails?: { exception?: { description?: string } };
}

test("-webkit-box computes, adjusts, clamps and lays out per axis", async ({ cdpSession: cdp }) => {
  const r = (await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      document.body.innerHTML = \`
        <div id=plain style="display:-webkit-box">x</div>
        <div id=clamped style="width:200px;font:16px/20px sans-serif;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden">
          one two three four five six seven eight nine ten eleven twelve thirteen fourteen</div>
        <div id=unclamped style="width:200px;font:16px/20px sans-serif">
          one two three four five six seven eight nine ten eleven twelve thirteen fourteen</div>
        <div id=horiz style="display:-webkit-box;-webkit-box-orient:horizontal;-webkit-line-clamp:2">x</div>
        <div id=row style="display:-webkit-box"><div style="width:50px;height:20px"></div><div style="width:50px;height:20px"></div></div>
        <div id=col style="display:-webkit-box;-webkit-box-orient:vertical"><div style="width:50px;height:20px"></div><div style="width:50px;height:20px"></div></div>\`;
      const cs = (id) => getComputedStyle(document.getElementById(id));
      const h = (id) => document.getElementById(id).getBoundingClientRect().height;
      return JSON.stringify({
        plainDisplay: cs("plain").display,
        clampedDisplay: cs("clamped").display,
        horizDisplay: cs("horiz").display,
        clampValue: cs("clamped").getPropertyValue("-webkit-line-clamp"),
        clampedToTwoLines: h("clamped") <= 45,
        unclampedTaller: h("unclamped") >= h("clamped") + 20,
        rowH: h("row"),
        colH: h("col"),
      });
    })()`,
    returnByValue: true,
  })) as EvalResult;
  expect(r.exceptionDetails).toBeFalsy();
  expect(JSON.parse(String(r.result?.value))).toEqual({
    plainDisplay: "-webkit-box",
    clampedDisplay: "flow-root",
    horizDisplay: "-webkit-box",
    clampValue: "2",
    clampedToTwoLines: true,
    unclampedTaller: true,
    rowH: 20,
    colH: 40,
  });
}, 120_000);
