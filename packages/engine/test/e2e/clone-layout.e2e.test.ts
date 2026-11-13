// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("a shaped subtree clone uses its new parent's layout without changing the source", async ({
  page,
}) => {
  await setContent(
    page,
    `<!DOCTYPE html>
    <style>
      p { margin: 0; }
      #left { font: 16px/20px monospace; }
      #right { font: 32px/40px monospace; }
    </style>
    <div id="left"><p id="source"><span>Alpha beta</span></p></div>
    <div id="right"></div>`,
  );

  const observed = await page.evaluate(() => {
    const source = document.getElementById("source")!;
    const sourceHeight = source.getBoundingClientRect().height;
    const clone = source.cloneNode(true) as HTMLElement;
    clone.id = "cloned";
    const detachedRect = clone.getBoundingClientRect();
    document.getElementById("right")!.appendChild(clone);
    return {
      sourceHeight,
      detached: [detachedRect.width, detachedRect.height],
      cloneHeight: clone.getBoundingClientRect().height,
      sourceAfter: source.getBoundingClientRect().height,
      text: clone.textContent,
    };
  });

  expect(observed).toEqual({
    sourceHeight: 20,
    detached: [0, 0],
    cloneHeight: 40,
    sourceAfter: 20,
    text: "Alpha beta",
  });
});
