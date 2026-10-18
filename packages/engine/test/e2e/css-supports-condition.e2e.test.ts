// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

interface EvalResult {
  result?: { value?: unknown };
  exceptionDetails?: { exception?: { description?: string } };
}

test("CSS.supports evaluates the full supports-condition grammar", async ({ cdpSession: cdp }) => {
  const r = (await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const S = (x) => CSS.supports(x);
      return JSON.stringify({
        and: S("(display: grid) and (display: flex)"),
        or: S("(display: grid) or (display: bogus)"),
        not: S("not (display: bogus)"),
        nested: S("((display: grid) and ((display: flex) or (display: block)))"),
        mixedNoParens: S("(display: grid) and (display: flex) or (display: block)"),
        notUnknown: S("not random-function(foo)"),
        orUnknown: S("(display: grid) or random-function(foo)"),
        andUnknown: S("(display: grid) and random-function(foo)"),
        selHas: S("selector(:has(a))"),
        selGarbage: S("selector(!!)"),
        custom: S("(--x: 1)"),
        urlVal: S("(background: url(http://a/b.png))"),
      });
    })()`,
    returnByValue: true,
  })) as EvalResult;
  expect(r.exceptionDetails).toBeFalsy();
  expect(JSON.parse(String(r.result?.value))).toEqual({
    and: true,
    or: true,
    not: true,
    nested: true,
    mixedNoParens: false,
    notUnknown: false,
    orUnknown: true,
    andUnknown: false,
    selHas: true,
    selGarbage: false,
    custom: true,
    urlVal: true,
  });
}, 120_000);

test("CSSStyleDeclaration exposes every property CSS.supports accepts", async ({ page }) => {
  const result = await page.evaluate(() => {
    const style = document.createElement("div").style;
    const checks: Array<[string, string]> = [
      ["color", "color"],
      ["background-color", "backgroundColor"],
      ["-webkit-transform", "webkitTransform"],
      ["-moz-animation", "MozAnimation"],
    ];
    style.setProperty("--declared", "yes");
    return {
      checks: checks.map(([property, attribute]) => ({
        property,
        supported: CSS.supports(property, "inherit"),
        dashed: property in style,
        camel: attribute in style,
      })),
      lowercaseMoz: "mozAnimation" in style,
      malformedWebkit: "webkit-transform" in style,
      unknown: "notAProperty" in style,
      missingCustom: "--missing" in style,
      declaredCustom: "--declared" in style,
      members:
        ["cssText", "length", "setProperty", "getPropertyValue", "removeProperty", "item"].every(
          (member) => member in style,
        ) && Symbol.iterator in style,
    };
  });

  for (const check of result.checks) {
    expect(check.dashed, check.property).toBe(check.supported);
    expect(check.camel, check.property).toBe(check.supported);
  }
  expect(result.lowercaseMoz).toBe(false);
  expect(result.malformedWebkit).toBe(false);
  expect(result.unknown).toBe(false);
  expect(result.missingCustom).toBe(false);
  expect(result.declaredCustom).toBe(false);
  expect(result.members).toBe(true);
}, 120_000);
