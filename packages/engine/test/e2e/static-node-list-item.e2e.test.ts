// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// querySelectorAll returns a static NodeList. Its item() must answer from
// the matched nodes like the indexed reads do; it used to return null for
// every index because only live lists registered a backing getter.
import { expect, test } from "./harness";

test("static NodeList item() returns the matched nodes", async ({ cdpSession: cdp }) => {
  const r = (await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      document.body.innerHTML = "<p id=a></p><p id=b></p>";
      const list = document.querySelectorAll("p");
      return JSON.stringify({
        first: list.item(0) === list[0] && list[0].id,
        second: list.item(1) === list[1] && list[1].id,
        past: list.item(2),
        empty: document.querySelectorAll("::before").item(0),
      });
    })()`,
    returnByValue: true,
  })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
  expect(r.exceptionDetails).toBeFalsy();
  expect(JSON.parse(String(r.result?.value))).toEqual({
    first: "a",
    second: "b",
    past: null,
    empty: null,
  });
}, 120_000);
