// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

interface EvalResult {
  result?: { value?: unknown };
  exceptionDetails?: { exception?: { description?: string } };
}

test("querySelector throws SyntaxError on invalid pseudo constructs", async ({
  cdpSession: cdp,
}) => {
  const r = (await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const t = (sel) => { try { document.querySelector(sel); return "ok"; } catch (e) { return e.name; } };
      return JSON.stringify({
        descendantAfterPseudo: t("::before *"),
        pseudoAfterPseudo: t("::before::selection"),
        classAfterPseudo: t("::selection.a"),
        combinatorAfterPseudo: t("::marker + div"),
        garbage: t("!!"),
        validPseudo: t("::before"),
        validSelection: t("::selection"),
        plain: t("div > a"),
      });
    })()`,
    returnByValue: true,
  })) as EvalResult;
  expect(r.exceptionDetails).toBeFalsy();
  expect(JSON.parse(String(r.result?.value))).toEqual({
    descendantAfterPseudo: "SyntaxError",
    pseudoAfterPseudo: "SyntaxError",
    classAfterPseudo: "SyntaxError",
    combinatorAfterPseudo: "SyntaxError",
    garbage: "SyntaxError",
    validPseudo: "ok",
    validSelection: "ok",
    plain: "ok",
  });
}, 120_000);
