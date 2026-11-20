// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("Runtime.callFunctionOn reports Chrome-compatible class names", async ({ page }) => {
  await setContent(page, "<!doctype html><main>class names</main>");
  const session = await page.target().createCDPSession();
  const global = await session.send("Runtime.evaluate", {
    expression: "globalThis",
    returnByValue: false,
  });
  expect(global.result.objectId).toBeTypeOf("string");

  const evaluateCases = [
    ["({ answer: 42 })", "Object"],
    ["[1, 2, 3]", "Array"],
  ] as const;
  for (const [expression, className] of evaluateCases) {
    const response = await session.send("Runtime.evaluate", {
      expression,
      returnByValue: false,
    });
    expect(response.exceptionDetails).toBeUndefined();
    expect(response.result.className).toBe(className);
    expect(response.result.objectId).toBeTypeOf("string");
  }

  const cases = [
    ["function () { return { answer: 42 }; }", "Object"],
    ["function () { return [1, 2, 3]; }", "Array"],
    ["function () { return function named() {}; }", "Function"],
  ] as const;
  for (const [functionDeclaration, className] of cases) {
    const response = await session.send("Runtime.callFunctionOn", {
      objectId: global.result.objectId,
      functionDeclaration,
      returnByValue: false,
      awaitPromise: true,
    });
    expect(response.exceptionDetails).toBeUndefined();
    expect(response.result.className).toBe(className);
    expect(response.result.objectId).toBeTypeOf("string");
  }

  await session.send("Runtime.enable");
  const consoleEvent = new Promise<{
    args: Array<{ className?: string }>;
  }>((resolve) => session.once("Runtime.consoleAPICalled", resolve));
  await session.send("Runtime.evaluate", {
    expression: "console.log({ answer: 42 }, [1, 2, 3], function named() {})",
    returnByValue: true,
  });
  expect((await consoleEvent).args.map((arg) => arg.className)).toEqual([
    "Object",
    "Array",
    "Function",
  ]);
});

test("a result returned by value is its type and value alone, as in Chrome", async ({ page }) => {
  await setContent(page, "<!doctype html><main>by value</main>");
  const session = await page.target().createCDPSession();
  const global = await session.send("Runtime.evaluate", {
    expression: "globalThis",
    returnByValue: false,
  });

  const cases = [
    ["({ answer: 42 })", { type: "object", value: { answer: 42 } }],
    ["[1, 2, 3]", { type: "object", value: [1, 2, 3] }],
    ["new Map([[1, 2]])", { type: "object", value: {} }],
    ["undefined", { type: "undefined" }],
    ["null", { type: "object", subtype: "null", value: null }],
    ["42", { type: "number", value: 42, description: "42" }],
    ["'text'", { type: "string", value: "text" }],
  ] as const;
  for (const [expression, expected] of cases) {
    const evaluated = await session.send("Runtime.evaluate", { expression, returnByValue: true });
    expect(evaluated.result, `Runtime.evaluate ${expression}`).toEqual(expected);
    const called = await session.send("Runtime.callFunctionOn", {
      objectId: global.result.objectId,
      functionDeclaration: `function () { return ${expression}; }`,
      returnByValue: true,
    });
    expect(called.result, `Runtime.callFunctionOn ${expression}`).toEqual(expected);
  }

  for (const expression of ["undefined", "null"]) {
    const handle = await session.send("Runtime.evaluate", { expression, returnByValue: false });
    expect(handle.result, `${expression} as a handle`).not.toHaveProperty("description");
  }
});
