// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import expectedSheetBody from "../../fixtures-worker/assets/external-sheet.css?raw";

test("exposes linked stylesheet text and matched rules", async ({ page }) => {
  const SHEET_URL = "https://ks.invalid/__fixtures/external-sheet.css";
  const session = await page.createCDPSession();

  try {
    const adds: Array<{
      isInline?: boolean;
      sourceURL?: string;
      length?: number;
      styleSheetId: string;
    }> = [];
    session.on("CSS.styleSheetAdded", (event) => {
      if (event.header.origin !== "user-agent") adds.push(event.header);
    });

    await page.goto("https://ks.invalid/__fixtures/external-sheet.html", {
      waitUntil: "load",
      timeout: 15_000,
    });
    await session.send("DOM.enable");
    await session.send("CSS.enable");
    await expect.poll(() => adds.length >= 1, { timeout: 10_000 }).toBe(true);

    const external = adds.find((header) => header.isInline === false);
    expect(!!external, "external sheet is emitted with isInline:false").toBe(true);
    expect(external?.sourceURL, "external sheet sourceURL matches the fixture").toBe(SHEET_URL);
    expect((external?.length ?? 0) > 0, "external sheet body has non-zero length").toBe(true);

    const text = await session.send("CSS.getStyleSheetText", {
      styleSheetId: external!.styleSheetId,
    });
    expect(text.text, "getStyleSheetText returns the external sheet body").toBe(expectedSheetBody);

    const doc = await session.send("DOM.getDocument");
    function findById(root: any, id: string): any {
      const stack = [root];
      while (stack.length) {
        const node = stack.pop();
        if (!node) continue;
        const index = (node.attributes || []).indexOf("id");
        if (index >= 0 && node.attributes[index + 1] === id) return node;
        if (Array.isArray(node.children)) {
          for (const child of node.children) stack.push(child);
        }
      }
      return null;
    }
    const pNode = findById(doc.root, "x");
    expect(!!pNode, "fixture contains the styled paragraph").toBe(true);

    const matched = await session.send("CSS.getMatchedStylesForNode", {
      nodeId: pNode!.nodeId,
    });
    const hasRule = (matched.matchedCSSRules ?? []).some(
      (entry) => entry.rule.selectorList.text === "p#x",
    );
    expect(hasRule, "matched styles include the external p#x rule").toBe(true);
  } finally {
    await session.detach();
  }
});
