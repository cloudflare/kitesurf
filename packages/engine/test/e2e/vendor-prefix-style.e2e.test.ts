// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

interface EvalResult {
  result?: { value?: unknown };
  exceptionDetails?: { exception?: { description?: string } };
}

test("prefixed style properties round-trip and reach the cascade", async ({ cdpSession: cdp }) => {
  const r = (await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const el = document.createElement("div");
      document.body.appendChild(el);
      el.style.setProperty("-webkit-border-radius", "1px");
      const prefixedSet = el.style.getPropertyValue("-webkit-border-radius");
      el.style.cssText = "";
      el.style.setProperty("-webkit-align-content", "center");
      const aliasTarget = el.style.getPropertyValue("align-content");
      el.style.cssText = "";
      el.style.webkitTransform = "scale(4)";
      const camelWrite = el.style.getPropertyValue("-webkit-transform");
      el.style.cssText = "transform: scale(5)";
      const computedAlias =
        getComputedStyle(el).getPropertyValue("-webkit-transform");
      return JSON.stringify({ prefixedSet, aliasTarget, camelWrite, computedAlias });
    })()`,
    returnByValue: true,
  })) as EvalResult;
  expect(r.exceptionDetails).toBeFalsy();
  expect(JSON.parse(String(r.result?.value))).toEqual({
    prefixedSet: "1px",
    aliasTarget: "center",
    camelWrite: "scale(4)",
    computedAlias: "matrix(5, 0, 0, 5, 0, 0)",
  });
}, 120_000);

test("cssFloat is an alias for float, not its own property", async ({ cdpSession: cdp }) => {
  const r = (await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const box = document.createElement("div");
      box.style.cssText = "float: left; width: 40px; height: 40px";
      document.body.appendChild(box);
      // Read through the alias sees what the dashed name declared.
      const aliasRead = box.style.cssFloat;
      const plainRead = box.style.float;
      const computedRead = getComputedStyle(box).float;

      // Write through the alias reaches the cascade, not a dead key.
      box.style.cssFloat = "right";
      const afterAliasWrite = getComputedStyle(box).float;
      const plainSeesIt = box.style.float;
      // ...and does not leave a bogus declaration behind.
      const text = box.style.cssText;

      // The dashed accessors still work unchanged.
      box.style.setProperty("float", "none");
      const afterSetProperty = getComputedStyle(box).float;
      return JSON.stringify({
        aliasRead, plainRead, computedRead, afterAliasWrite,
        plainSeesIt, hasBogusKey: text.indexOf("css-float") >= 0,
        afterSetProperty,
      });
    })()`,
    returnByValue: true,
  })) as EvalResult;
  expect(r.exceptionDetails).toBeFalsy();
  expect(JSON.parse(String(r.result?.value))).toEqual({
    aliasRead: "left",
    plainRead: "left",
    computedRead: "left",
    afterAliasWrite: "right",
    plainSeesIt: "right",
    hasBogusKey: false,
    afterSetProperty: "none",
  });
}, 120_000);
