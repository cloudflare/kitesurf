// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("before and prepend retain dynamic insertBefore lookup and its receiver", async ({ page }) => {
  await setContent(page, "<p>x</p>");
  const result = await page.evaluate(() => {
    const parent = document.createElement("div");
    const first = document.createElement("i");
    const second = document.createElement("b");
    parent.append(first, second);
    const insertBefore = parent.insertBefore;
    const calls: string[] = [];
    Object.defineProperty(parent, "insertBefore", {
      get() {
        calls.push("lookup");
        return function (this: Node, node: Node, reference: Node | null) {
          calls.push(`${node.nodeName}:${reference?.nodeName}:${this === parent}`);
          return insertBefore.call(this, node, reference);
        };
      },
    });
    second.before(first);
    parent.prepend(document.createElement("em"), document.createElement("strong"));
    return { calls, children: [...parent.childNodes].map((node) => node.nodeName) };
  });
  expect(result).toEqual({
    calls: ["lookup", "I:B:true", "lookup", "EM:I:true", "lookup", "STRONG:I:true"],
    children: ["EM", "STRONG", "I", "B"],
  });
});
