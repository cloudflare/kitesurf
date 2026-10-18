// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { setTimeout as sleep } from "node:timers/promises";

import { expect, test } from "../harness";

test("transition-settles-demo", async ({ page }) => {
  const HTML = `<!doctype html>
<html>
<head>
  <style>
    #t {
      background-color: rgb(0, 255, 0);
      animation: go 10s linear;
    }
    @keyframes go {
      from { background-color: rgb(255, 0, 0); }
      to   { background-color: rgb(0, 0, 255); }
    }
  </style>
</head>
<body>
  <div id="t">x</div>
</body>
</html>`;

  const session = await page.target().createCDPSession();
  const tree = await session.send("Page.getFrameTree");
  await session.send("Page.setDocumentContent", {
    frameId: tree.frameTree.frame.id,
    html: HTML,
  });
  await sleep(80);

  const read1 = await page.evaluate(() => {
    const t = document.getElementById("t")!;
    return getComputedStyle(t).backgroundColor;
  });
  expect(read1, "animation must be applied at all").not.toBe("rgb(0, 255, 0)");

  await sleep(500);
  const read2 = await page.evaluate(() => {
    const t = document.getElementById("t")!;
    t.setAttribute("data-poke", "1");
    return getComputedStyle(t).backgroundColor;
  });
  expect(read2, "animation must still be applied").not.toBe("rgb(0, 255, 0)");

  expect(
    read2,
    "the animated value must progress between reads; a frozen animation " +
      "clock would keep it at the initial value: " +
      `read1=${read1} read2=${read2}`,
  ).not.toBe(read1);
});
