// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

interface EvalResult {
  result?: { value?: unknown };
  exceptionDetails?: { exception?: { description?: string } };
}

const DEFAULT_COLOR = "rgb(0, 0, 0)";

test("insertRule and deleteRule reach the cascade, and a removed <style> drops a queued rule", async ({
  cdpSession: cdp,
}) => {
  const r = (await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const st = document.createElement("style");
      document.head.appendChild(st);
      const d = document.createElement("div");
      d.className = "target";
      document.body.appendChild(d);
      const color = () => getComputedStyle(d).color;
      st.sheet.insertRule(".target { color: rgb(1, 2, 3); }", 0);
      const first = color();
      for (let i = 0; i < 50; i++) st.sheet.insertRule(".filler" + i + " { color: red; }", st.sheet.cssRules.length);
      st.sheet.insertRule(".target { color: rgb(4, 5, 6); }", st.sheet.cssRules.length);
      const last = color();
      st.sheet.deleteRule(st.sheet.cssRules.length - 1);
      const afterDelete = color();
      st.sheet.insertRule(".target { color: rgb(7, 8, 9); }", st.sheet.cssRules.length);
      st.remove();
      const afterRemove = color();
      return JSON.stringify({ first, last, afterDelete, afterRemove });
    })()`,
    returnByValue: true,
  })) as EvalResult;

  expect(r.exceptionDetails).toBeFalsy();
  expect(JSON.parse(String(r.result?.value))).toEqual({
    first: "rgb(1, 2, 3)",
    last: "rgb(4, 5, 6)",
    afterDelete: "rgb(1, 2, 3)",
    afterRemove: DEFAULT_COLOR,
  });
});
