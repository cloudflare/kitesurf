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
