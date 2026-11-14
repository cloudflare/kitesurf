// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

for (const depth of [500, 2_000]) {
  test(`Accessibility.getFullAXTree handles ${depth} nested elements with layout off`, async ({
    page,
    cdpSession,
  }) => {
    await setContent(page, "<main></main>");
    await cdpSession.send("Kitesurf.setLayoutMode", { mode: "off" });
    await page.evaluate((depth) => {
      const main = document.querySelector("main");
      if (!main) throw new Error("main element missing");
      let parent: Element = main;
      for (let index = 0; index < depth; index++) {
        const child = document.createElement("div");
        child.setAttribute("role", "group");
        child.setAttribute("aria-label", `level ${index}`);
        parent.append(child);
        parent = child;
      }
      parent.textContent = "deep";
    }, depth);

    const { nodes } = await cdpSession.send("Accessibility.getFullAXTree");
    expect(nodes.length).toBeGreaterThanOrEqual(depth);
  });
}
