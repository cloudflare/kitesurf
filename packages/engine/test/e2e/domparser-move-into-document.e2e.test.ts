// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("appending a DOMParser node moves its subtree out of the parsed document", async ({
  page,
}) => {
  await setContent(page, '<div id="dest"></div>');

  const result = await page.evaluate(() => {
    const parsed = new DOMParser().parseFromString(
      "<p>a<b>bold</b></p><!--note--><i>c</i>text",
      "text/html",
    );
    const source = parsed.body;
    const dest = document.getElementById("dest")!;
    // Bounded so a node that never leaves the parsed document fails the test instead of hanging.
    let moves = 0;
    while (source.firstChild && moves < 10) {
      dest.appendChild(source.firstChild);
      moves++;
    }
    const list = new DOMParser().parseFromString("<ul><li>1</li><li>2</li></ul>", "text/html");
    dest.appendChild(list.querySelector("li")!);
    return {
      moves,
      sourceLeft: source.childNodes.length,
      destHTML: dest.innerHTML,
      listLeft: list.querySelector("ul")!.outerHTML,
    };
  });

  expect(result).toEqual({
    moves: 4,
    sourceLeft: 0,
    destHTML: "<p>a<b>bold</b></p><!--note--><i>c</i>text<li>1</li>",
    listLeft: "<ul><li>2</li></ul>",
  });
});

test("a rejected appendChild leaves the parsed document unchanged", async ({ page }) => {
  await setContent(page, '<div id="host"></div>');

  const result = await page.evaluate(() => {
    const parsed = new DOMParser().parseFromString('<div id="a"><p>x</p></div>', "text/html");
    const div = parsed.querySelector("#a")!;
    let leafErr = "";
    try {
      document.createTextNode("t").appendChild(div);
    } catch (e) {
      leafErr = (e as Error).name;
    }
    const leftAfterLeaf = parsed.body.innerHTML;

    let docErr = "";
    try {
      document.appendChild(parsed.documentElement);
    } catch (e) {
      docErr = (e as Error).name;
    }
    return {
      leafErr,
      leftAfterLeaf,
      docErr,
      docStillHasRoot: parsed.documentElement !== null,
      leftAfterDoc: parsed.body?.innerHTML ?? "",
    };
  });

  expect(result).toEqual({
    leafErr: "HierarchyRequestError",
    leftAfterLeaf: '<div id="a"><p>x</p></div>',
    docErr: "HierarchyRequestError",
    docStillHasRoot: true,
    leftAfterDoc: '<div id="a"><p>x</p></div>',
  });
});
