// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import type { Protocol } from "devtools-protocol";

type CdpNode = Protocol.DOM.Node;
type StyleProperty = { name: string; value: string };
type MatchedRule = { rule: { origin: string; selectorList: { text: string } } };

function nodeHasId(node: CdpNode, wantId: string): boolean {
  const i = (node.attributes || []).indexOf("id");
  return i >= 0 && (node.attributes || [])[i + 1] === wantId;
}

function nodeChildren(node: CdpNode): CdpNode[] {
  return Array.isArray(node.children) ? node.children : [];
}

function findById(root: CdpNode, wantId: string): CdpNode | null {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (nodeHasId(node, wantId)) return node;
    for (const child of nodeChildren(node)) stack.push(child);
  }
  return null;
}

function expectNode(node: CdpNode | null, message: string): asserts node is CdpNode {
  expect(!!node, message).toBeTruthy();
}

function computedProperties(
  response: { computedStyle?: StyleProperty[] } | undefined,
): StyleProperty[] {
  return response?.computedStyle ?? [];
}

function expectPropertyArray(props: StyleProperty[]): void {
  expect(
    Array.isArray(props) && props.length > 100,
    `computedStyle is a non-empty array: got ${Array.isArray(props) ? props.length : "non-array"} entries`,
  ).toBeTruthy();
}

function matchedRules(response: { matchedCSSRules?: MatchedRule[] } | undefined): MatchedRule[] {
  return response?.matchedCSSRules ?? [];
}

function expectTargetStyles(
  props: StyleProperty[],
  byName: Map<string, string>,
  response: { extraFields?: { isAppearanceBase?: boolean } } | undefined,
): void {
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
  expect(response?.extraFields?.isAppearanceBase, "extraFields.isAppearanceBase is false").toBe(
    false,
  );
}

function expectPlainStyles(props: StyleProperty[]): void {
  expect(
    props.length > 100,
    `plain node also returns >100 properties (UA cascade ran): got ${props.length}`,
  ).toBeTruthy();
  const color = (props.find((p) => p.name === "color") || {}).value;
  expect(
    typeof color === "string" && color.length > 0,
    `plain color is a CSS color, not empty: got ${JSON.stringify(color)}`,
  ).toBeTruthy();
}

function expectNoInlineStyle(inline: { inlineStyle?: unknown } | null | undefined): void {
  expect(
    inline && typeof inline === "object" && inline.inlineStyle === undefined,
    "CSS.getInlineStylesForNode returns {} for a node with no style attribute: " +
      JSON.stringify(inline),
  ).toBeTruthy();
}

function expectMatchedStyleRules(authorRules: MatchedRule[], uaRules: MatchedRule[]): void {
  expect(
    authorRules.length === 1 && authorRules[0].rule.selectorList.text === "#target",
    "CSS.getMatchedStylesForNode includes the #target author rule: " +
      JSON.stringify(authorRules).slice(0, 200),
  ).toBeTruthy();
  expect(
    uaRules.length > 0,
    `CSS.getMatchedStylesForNode includes UA rules (e.g. div { display: block }): got ${uaRules.length} UA rules`,
  ).toBeTruthy();
}

function expectEnvironmentVariables(
  env: { environmentVariables?: unknown } | null | undefined,
): void {
  expect(
    env && typeof env.environmentVariables === "object",
    "CSS.getEnvironmentVariables returns an object",
  ).toBeTruthy();
}

function expectPlatformFonts(fonts: { fonts?: unknown[] } | null | undefined): void {
  expect(
    Array.isArray(fonts?.fonts) && fonts.fonts.length === 0,
    "CSS.getPlatformFontsForNode returns fonts: []",
  ).toBeTruthy();
}

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

  const doc = await session.send("DOM.getDocument");
  const targetNode = findById(doc.root, "target");
  const plainNode = findById(doc.root, "plain");
  expectNode(targetNode, "#target located in tree: " + JSON.stringify(targetNode));
  expectNode(plainNode, "#plain located in tree");

  const r = await session.send("CSS.getComputedStyleForNode", {
    nodeId: targetNode.nodeId,
  });
  const props = computedProperties(r);
  expectPropertyArray(props);

  const byName = new Map();
  for (const p of props) byName.set(p.name, p.value);
  expectTargetStyles(props, byName, r);

  const r2 = await session.send("CSS.getComputedStyleForNode", {
    nodeId: plainNode.nodeId,
  });
  const props2 = computedProperties(r2);
  expectPlainStyles(props2);

  const inline = await session.send("CSS.getInlineStylesForNode", {
    nodeId: targetNode.nodeId,
  });
  expectNoInlineStyle(inline);
  const matched = await session.send("CSS.getMatchedStylesForNode", {
    nodeId: targetNode.nodeId,
  });
  const authorRules = matchedRules(matched).filter((m) => m.rule.origin === "regular");
  const uaRules = matchedRules(matched).filter((m) => m.rule.origin === "user-agent");
  expectMatchedStyleRules(authorRules, uaRules);
  const env = await session.send("CSS.getEnvironmentVariables");
  expectEnvironmentVariables(env);
  const fonts = await session.send("CSS.getPlatformFontsForNode", {
    nodeId: targetNode.nodeId,
  });
  expectPlatformFonts(fonts);
});
