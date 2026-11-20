// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("appending to a parent with a listed child list keeps ends and records current", async ({
  page,
}) => {
  await setContent(page, '<div id="p"></div>');

  const result = await page.evaluate(() => {
    const parent = document.getElementById("p")!;
    const kids = parent.childNodes;
    const observer = new MutationObserver(() => {});
    observer.observe(parent, { childList: true });
    let endsMatch = true;
    for (let i = 0; i < 80; i++) {
      const child = i % 2 ? document.createTextNode(String(i)) : document.createElement("span");
      parent.appendChild(child);
      endsMatch &&= parent.lastChild === child && kids[kids.length - 1] === child;
    }
    const records = observer.takeRecords();
    observer.disconnect();
    const previousMatch = records.every(
      (r, i) => r.previousSibling === (i === 0 ? null : (records[i - 1]?.addedNodes[0] ?? null)),
    );
    return {
      endsMatch,
      firstIsSpan: parent.firstChild!.nodeName,
      length: kids.length,
      records: records.length,
      previousMatch,
    };
  });

  expect(result).toEqual({
    endsMatch: true,
    firstIsSpan: "SPAN",
    length: 80,
    records: 80,
    previousMatch: true,
  });
});
