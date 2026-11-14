// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("css-computed-style-demo", async ({ page }) => {
  const HTML = `<!doctype html>
<html>
<head>
  <style>
    #target {
      color: rgb(255, 0, 0);
      font-size: 24px;
      margin-top: 10px;
      display: block;
    }
    #plain {
      /* deliberately empty so the diff between #target and
         #plain isolates "author CSS changes the resolved
         values" — anything here would just be UA defaults */
    }
  </style>
</head>
<body>
  <div id="target">styled</div>
  <div id="plain">plain</div>
</body>
</html>`;

  const session = await page.target().createCDPSession();

  const tree = await session.send("Page.getFrameTree");
  await session.send("Page.setDocumentContent", {
    frameId: tree.frameTree.frame.id,
    html: HTML,
  });
  await session.send("DOM.enable");
  await session.send("CSS.enable");

  const doc = await session.send("DOM.getDocument", { depth: -1 });
  function findById(root, wantId) {
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      if (!n) continue;
      const i = (n.attributes || []).indexOf("id");
      if (i >= 0 && (n.attributes || [])[i + 1] === wantId) return n;
      if (Array.isArray(n.children)) {
        for (const c of n.children) stack.push(c);
      }
    }
    return null;
  }
  const targetNode = findById(doc.root, "target");
  const plainNode = findById(doc.root, "plain");
  expect(!!targetNode, "#target located in tree: " + JSON.stringify(targetNode)).toBeTruthy();
  expect(!!plainNode, "#plain located in tree").toBeTruthy();

  const r = await session.send("CSS.getComputedStyleForNode", {
    nodeId: targetNode.nodeId,
  });
  const props = r?.computedStyle ?? [];
  expect(
    Array.isArray(props) && props.length > 100,
    `computedStyle is a non-empty array: got ${Array.isArray(props) ? props.length : "non-array"} entries`,
  ).toBeTruthy();

  const byName = new Map();
  for (const p of props) byName.set(p.name, p.value);

  expect(byName.get("color"), "color resolves to rgb(255, 0, 0)").toBe("rgb(255, 0, 0)");
  expect(byName.get("font-size"), "font-size resolves to 24px").toBe("24px");
  expect(byName.get("margin-top"), "margin-top resolves to 10px").toBe("10px");
  expect(byName.get("display"), "display resolves to block").toBe("block");

  const hasSpecCased =
    byName.has("background-color") && byName.has("text-align") && byName.has("box-sizing");
  expect(
    hasSpecCased,
    "spec-cased property names present: missing one of background-color / text-align / box-sizing",
  ).toBeTruthy();

  expect(r?.extraFields?.isAppearanceBase, "extraFields.isAppearanceBase is false").toBe(false);

  const r2 = await session.send("CSS.getComputedStyleForNode", {
    nodeId: plainNode.nodeId,
  });
  const props2 = r2?.computedStyle ?? [];
  expect(
    props2.length > 100,
    `plain node also returns >100 properties (UA cascade ran): got ${props2.length}`,
  ).toBeTruthy();
  const plainColor = (props2.find((p) => p.name === "color") || {}).value;
  expect(
    typeof plainColor === "string" && plainColor.length > 0,
    `plain color is a CSS color, not empty: got ${JSON.stringify(plainColor)}`,
  ).toBeTruthy();

  const inline = await session.send("CSS.getInlineStylesForNode", {
    nodeId: targetNode.nodeId,
  });
  expect(
    inline && typeof inline === "object" && inline.inlineStyle === undefined,
    "CSS.getInlineStylesForNode returns {} for a node with no style attribute: " +
      JSON.stringify(inline),
  ).toBeTruthy();
  const matched = await session.send("CSS.getMatchedStylesForNode", {
    nodeId: targetNode.nodeId,
  });
  const authorRules = (matched?.matchedCSSRules ?? []).filter((m) => m.rule.origin === "regular");
  const uaRules = (matched?.matchedCSSRules ?? []).filter((m) => m.rule.origin === "user-agent");
  expect(
    authorRules.length === 1 && authorRules[0].rule.selectorList.text === "#target",
    "CSS.getMatchedStylesForNode includes the #target author rule: " +
      JSON.stringify(authorRules).slice(0, 200),
  ).toBeTruthy();
  expect(
    uaRules.length > 0,
    `CSS.getMatchedStylesForNode includes UA rules (e.g. div { display: block }): got ${uaRules.length} UA rules`,
  ).toBeTruthy();
  const env = await session.send("CSS.getEnvironmentVariables");
  expect(
    env && typeof env.environmentVariables === "object",
    "CSS.getEnvironmentVariables returns an object",
  ).toBeTruthy();
  const fonts = await session.send("CSS.getPlatformFontsForNode", {
    nodeId: targetNode.nodeId,
  });
  expect(
    Array.isArray(fonts?.fonts) && fonts.fonts.length === 0,
    "CSS.getPlatformFontsForNode returns fonts: []",
  ).toBeTruthy();
});
