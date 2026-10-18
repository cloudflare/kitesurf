// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// boa 0.22 lexes `using` as a keyword and its identifier gates never listed it, so any
// read of a variable named `using` was a SyntaxError (rxjs ships `exports.using = using`).
import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("`using` still works as an ordinary identifier on boa", async ({ page }) => {
  await setContent(page, "<!doctype html><title>t</title>");
  const results = await page.evaluate(`(() => {
    const out = {};
    out.varRead = (() => { var using = 3; return using; })();
    out.newFunction = new Function("var using = 5; return using")();
    out.declaredFn = (() => { function using() { return 1; } return using(); })();
    out.namedExpr = (function using() { return typeof using; })();
    out.shorthand = (() => { const using = 9; return ({ using }).using; })();
    out.arrowParam = ((using) => using + 1)(1);
    out.bareArrow = (using => using * 2)(4);
    out.letBinding = (() => { let using = 6; return using; })();
    out.declaration = new Function("{ using held = null; } return 'parsed'")();
    return out;
  })()`);
  expect(results).toEqual({
    varRead: 3,
    newFunction: 5,
    declaredFn: 1,
    namedExpr: "function",
    shorthand: 9,
    arrowParam: 2,
    bareArrow: 8,
    letBinding: 6,
    declaration: "parsed",
  });
}, 60_000);

// A statement starting with `using` went straight to the declaration parser whatever followed,
// so `using(`, `using =`, `using.x` and a `using:` label were SyntaxErrors.
test("a statement may start with `using` as an identifier on boa", async ({ page }) => {
  await setContent(page, "<!doctype html><title>t</title>");
  const bodies: Record<string, string> = {
    call: 'function using() { return 1 } using(); return "ok"',
    assign: "var using; using = 4; return using",
    member: "var using = { x: 1 }; using.x = 9; return using.x",
    index: "var using = [1]; using[0] = 3; return using[0]",
    label: 'using: for (;;) { break using } return "ok"',
    newlineBeforeName: 'var using = 1, x = 2; using\nx; return "ok"',
    lineStart: "var using = 0;\nusing = 5; return using",
    declaration: "{ using held = null; } return 'declared'",
    bodyStartDeclaration: "using held = null; return 'declared'",
    functionBodyDeclaration:
      "return (function () {\n  using held = null;\n  return 'declared';\n})()",
    asyncBodyDeclaration:
      "return typeof (async function () { await using held = null; return 1; })()",
  };
  const results = await page.evaluate((bodies: Record<string, string>) => {
    const out: Record<string, unknown> = {};
    for (const [name, body] of Object.entries(bodies)) {
      try {
        out[name] = new Function(body)();
      } catch (e) {
        out[name] = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      }
    }
    return out;
  }, bodies);
  expect(results).toEqual({
    call: "ok",
    assign: 4,
    member: 9,
    index: 3,
    label: "ok",
    newlineBeforeName: "ok",
    lineStart: 5,
    declaration: "declared",
    bodyStartDeclaration: "declared",
    functionBodyDeclaration: "declared",
    asyncBodyDeclaration: "object",
  });
  expect(await page.evaluate("var using = 1; using = 2; using")).toBe(2);
}, 60_000);
