// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { setTimeout as sleep } from "node:timers/promises";

import { expect, test } from "../harness";
import type { Protocol } from "devtools-protocol";

type CdpNode = Protocol.DOM.Node;
type MatchedRule = {
  rule: {
    origin: string;
    selectorList: { text: string };
    style: { cssProperties: Array<{ name: string }> };
  };
};
type InheritedEntry = { matchedCSSRules: MatchedRule[] };

function findById(root: CdpNode, id: string): CdpNode | null {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    const attributes = node.attributes || [];
    const index = attributes.indexOf("id");
    if (index >= 0 && attributes[index + 1] === id) return node;
    if (Array.isArray(node.children)) {
      for (const child of node.children) stack.push(child);
    }
  }
  return null;
}

function expectNode(node: CdpNode | null, message: string): asserts node is CdpNode {
  expect(!!node, message).toBeTruthy();
}

function onlyAuthor(entry: InheritedEntry): MatchedRule[] {
  return entry.matchedCSSRules.filter((m) => m.rule.origin === "regular");
}

function expectAuthorDirect(authorDirect: MatchedRule[]): void {
  expect(
    authorDirect.length === 1 && authorDirect[0].rule.selectorList.text === "p#x",
    `author matchedCSSRules has the p#x rule: got: ${JSON.stringify(authorDirect.map((m) => m.rule.selectorList.text))}`,
  ).toBeTruthy();
}

function expectContainerInherited(div: { matchedCSSRules: MatchedRule[] }): void {
  expect(
    div.matchedCSSRules.length === 1 &&
      div.matchedCSSRules[0].rule.selectorList.text === ".container" &&
      div.matchedCSSRules[0].rule.style.cssProperties.some((p) => p.name === "font-size"),
    `inherited[0] has .container { font-size } only (padding filtered): got: ${JSON.stringify(div.matchedCSSRules.map((m) => ({ sel: m.rule.selectorList.text, props: m.rule.style.cssProperties.map((p) => p.name) })))}`,
  ).toBeTruthy();
}

function expectBodyInherited(body: { matchedCSSRules: MatchedRule[] }): void {
  expect(
    body.matchedCSSRules.length === 2,
    `inherited[1] has body{color} and .bb{line-height}: got: ${JSON.stringify(body.matchedCSSRules.map((m) => ({ sel: m.rule.selectorList.text, props: m.rule.style.cssProperties.map((p) => p.name) })))}`,
  ).toBeTruthy();
  const bodyRuleNames = body.matchedCSSRules.map((m) => m.rule.selectorList.text);
  expect(
    bodyRuleNames.includes("body") && bodyRuleNames.includes(".bb"),
    "inherited[1] body rule that survived is the one with color",
  ).toBeTruthy();
}

function expectHtmlInherited(html: { matchedCSSRules: MatchedRule[] }): void {
  expect(
    html.matchedCSSRules.length === 1 &&
      html.matchedCSSRules[0].rule.selectorList.text === "html" &&
      html.matchedCSSRules[0].rule.style.cssProperties.some((p) => p.name === "font-family"),
    `inherited[2] has html { font-family }: got: ${JSON.stringify(html.matchedCSSRules.map((m) => ({ sel: m.rule.selectorList.text, props: m.rule.style.cssProperties.map((p) => p.name) })))}`,
  ).toBeTruthy();
}

function expectThreeInheritedEntries(
  inherited: InheritedEntry[] | undefined,
): inherited is [InheritedEntry, InheritedEntry, InheritedEntry] {
  expect(Array.isArray(inherited), `inherited is an array: got: ${typeof inherited}`).toBeTruthy();
  const count = inherited?.length;
  const hasThreeEntries = count === 3;
  expect(
    hasThreeEntries,
    `inherited has 3 ancestor entries: got ${count} entries: ${JSON.stringify(inherited?.map((i) => i.matchedCSSRules.map((m) => m.rule.selectorList.text)))}`,
  ).toBeTruthy();
  return hasThreeEntries;
}

function expectInheritedStyles(inherited: InheritedEntry[] | undefined): void {
  if (!expectThreeInheritedEntries(inherited)) return;
  const [div, body, html] = inherited.map((entry) => ({ matchedCSSRules: onlyAuthor(entry) }));
  expectContainerInherited(div);
  expectBodyInherited(body);
  expectHtmlInherited(html);
}

test("css-inherited-styles-demo", async ({ page }) => {
  const STYLE_TEXT =
    "html { font-family: serif; }\n" +
    "body { background-color: yellow; }\n" +
    "body { color: rgb(0, 128, 0); }\n" +
    ".bb { line-height: 1.5; }\n" +
    ".container { padding: 10px; }\n" +
    ".container { font-size: 16px; }\n" +
    "p#x { margin-top: 5px; }";
  const HTML = `<!doctype html>
<html><head><style>${STYLE_TEXT}</style></head>
<body class="bb"><div class="container"><p id="x">hello</p></div></body>
</html>`;

  const session = await page.target().createCDPSession();

  let authorSheetSeen = false;
  session.on("CSS.styleSheetAdded", (p) => {
    if (p.header.origin === "regular") authorSheetSeen = true;
  });

  const tree = await session.send("Page.getFrameTree");
  await session.send("Page.setDocumentContent", {
    frameId: tree.frameTree.frame.id,
    html: HTML,
  });
  await sleep(150);
  await session.send("DOM.enable");
  await session.send("CSS.enable");
  const sheetDeadline = Date.now() + 5000;
  while (!authorSheetSeen && Date.now() < sheetDeadline) {
    await sleep(10);
  }

  const doc = await session.send("DOM.getDocument");
  const pNode = findById(doc.root, "x");
  expectNode(pNode, "located <p id=x>");

  const r = await session.send("CSS.getMatchedStylesForNode", {
    nodeId: pNode.nodeId,
  });

  const authorDirect = (r.matchedCSSRules ?? []).filter((m) => m.rule.origin === "regular");
  expectAuthorDirect(authorDirect);
  expectInheritedStyles(r.inherited);
});
