// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

interface EvalResult {
  result?: { value?: unknown };
  exceptionDetails?: { exception?: { description?: string } };
}

test("getComputedStyle resolves ::marker, ::before and ::selection", async ({
  cdpSession: cdp,
}) => {
  const r = (await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      document.head.insertAdjacentHTML("beforeend", \`<style>
        li::marker { color: rgb(0, 128, 0); font-size: 20px; }
        .b::before { content: "x"; color: rgb(255, 0, 0); }
        .s::selection { background-color: rgb(0, 0, 255); }
      </style>\`);
      document.body.innerHTML = '<ul><li id=li class="s">item</li></ul><div class="b" id=b>t</div>';
      const li = document.getElementById("li"), b = document.getElementById("b");
      // Unstyled pseudo: no ::before rule matches #li, but CSSOM
      // still returns computed defaults (inherited color, not "").
      li.style.color = "rgb(7, 8, 9)";
      return JSON.stringify({
        markerColor: getComputedStyle(li, "::marker").color,
        markerSize: getComputedStyle(li, "::marker").fontSize,
        beforeColor: getComputedStyle(b, "::before").color,
        selBg: getComputedStyle(li, "::selection").backgroundColor,
        noPseudo: getComputedStyle(li).color,
        legacySingle: getComputedStyle(b, ":before").color,
        unstyledBeforeColor: getComputedStyle(li, "::before").color,
        unstyledBeforeDisplay: getComputedStyle(li, "::before").display,
      });
    })()`,
    returnByValue: true,
  })) as EvalResult;
  expect(r.exceptionDetails).toBeFalsy();
  expect(JSON.parse(String(r.result?.value))).toEqual({
    markerColor: "rgb(0, 128, 0)",
    markerSize: "20px",
    beforeColor: "rgb(255, 0, 0)",
    selBg: "rgb(0, 0, 255)",
    noPseudo: "rgb(7, 8, 9)",
    legacySingle: "rgb(255, 0, 0)",
    unstyledBeforeColor: "rgb(7, 8, 9)",
    unstyledBeforeDisplay: "inline",
  });
}, 120_000);
