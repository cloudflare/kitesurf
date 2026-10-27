// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import type { Protocol } from "devtools-protocol";

type CdpNode = Protocol.DOM.Node;
type CssProperty = { name: string; value?: string; important?: boolean };
type InlineStyles = {
  inlineStyle?: {
    cssProperties?: CssProperty[];
    shorthandEntries?: unknown[];
    cssText?: string;
  };
};
type ComputedStyles = { computedStyle?: Array<{ name: string; value: string }> };

function findById(root: CdpNode, wantId: string): CdpNode | null {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    const attributes = node.attributes || [];
    const index = attributes.indexOf("id");
    if (index >= 0 && attributes[index + 1] === wantId) return node;
    if (Array.isArray(node.children)) {
      for (const child of node.children) stack.push(child);
    }
  }
  return null;
}

function expectFourNodes<T>(
  nodes: readonly [T | null, T | null, T | null, T | null],
  message: string,
): asserts nodes is readonly [T, T, T, T] {
  expect(!!(nodes[0] && nodes[1] && nodes[2] && nodes[3]), message).toBeTruthy();
}

function inlineProperties(response: InlineStyles | null | undefined): CssProperty[] {
  return response?.inlineStyle?.cssProperties ?? [];
}

function computedProperties(response: ComputedStyles | null | undefined) {
  return response?.computedStyle ?? [];
}

function hasNoShorthandEntries(response: InlineStyles | null | undefined): boolean {
  const shorthandEntries = response?.inlineStyle?.shorthandEntries;
  return Array.isArray(shorthandEntries) && shorthandEntries.length === 0;
}

function findProperty(properties: CssProperty[], name: string): CssProperty | undefined {
  return properties.find((property) => property.name === name);
}

function expectPlainNodeStyles(response: InlineStyles | null | undefined): void {
  expect(
    response && response.inlineStyle === undefined,
    "#plain returns no inlineStyle (no style attr): " + JSON.stringify(response).slice(0, 120),
  ).toBeTruthy();
}

function expectEmptyInlineProperties(response: InlineStyles | null | undefined): void {
  expect(
    !!response?.inlineStyle,
    "#empty returns inlineStyle object: " + JSON.stringify(response).slice(0, 120),
  ).toBeTruthy();
  expect(
    Array.isArray(response?.inlineStyle?.cssProperties) &&
      response.inlineStyle.cssProperties.length === 0,
    "#empty cssProperties is empty array",
  ).toBeTruthy();
}

function expectEmptyShorthandEntries(response: InlineStyles | null | undefined): void {
  expect(hasNoShorthandEntries(response), "#empty shorthandEntries is empty array").toBeTruthy();
  expect(response?.inlineStyle?.cssText, "#empty cssText is the empty string").toBe("");
}

function expectSimpleDeclarations(properties: CssProperty[]): void {
  expect(
    properties.length === 3,
    `#simple has 3 declarations: got ${properties.length}: ${JSON.stringify(properties)}`,
  ).toBeTruthy();
  expect(
    findProperty(properties, "color")?.value === "rgb(0, 128, 0)",
    `#simple color = rgb(0, 128, 0): got ${JSON.stringify(findProperty(properties, "color"))}`,
  ).toBeTruthy();
  expect(
    findProperty(properties, "font-size")?.value === "14px",
    "#simple font-size = 14px",
  ).toBeTruthy();
  expect(
    findProperty(properties, "padding")?.value === "4px",
    "#simple padding = 4px",
  ).toBeTruthy();
  expect(
    properties.every((p) => p.important !== true),
    "#simple no declaration is marked !important: " + JSON.stringify(properties),
  ).toBeTruthy();
}

function expectSimpleCssText(response: InlineStyles | null | undefined): void {
  const cssText = response?.inlineStyle?.cssText;
  expect(
    typeof cssText === "string" && cssText.includes("rgb(0, 128, 0)") && cssText.includes("14px"),
    "#simple cssText preserves the original attribute body: got " + JSON.stringify(cssText),
  ).toBeTruthy();
}

function expectShorthandDeclarations(properties: CssProperty[]): void {
  expect(
    properties.length === 2,
    `#shorthand has 2 declarations (margin + color, no expansion): got ${properties.length}: ${JSON.stringify(properties)}`,
  ).toBeTruthy();
  expect(
    !!findProperty(properties, "margin"),
    "#shorthand keeps margin as a single shorthand entry: " +
      JSON.stringify(properties.map((p) => p.name)),
  ).toBeTruthy();
  expect(
    findProperty(properties, "margin")?.value === "10px 20px",
    `#shorthand margin value = 10px 20px: got ${JSON.stringify(findProperty(properties, "margin"))}`,
  ).toBeTruthy();
  expect(
    findProperty(properties, "color")?.value === "blue" &&
      findProperty(properties, "color")?.important === true,
    `#shorthand color = blue with !important flag: got ${JSON.stringify(findProperty(properties, "color"))}`,
  ).toBeTruthy();
}

function expectNoShorthandEntries(response: InlineStyles | null | undefined): void {
  expect(
    hasNoShorthandEntries(response),
    "#shorthand no shorthandEntries (we don't populate the field)",
  ).toBeTruthy();
}

function findComputedValue(response: ComputedStyles | null | undefined, name: string) {
  const computed = computedProperties(response);
  return computed.find((property) => property.name === name)?.value;
}

function expectComputedValues(response: ComputedStyles | null | undefined): void {
  expect(
    findComputedValue(response, "color") === "rgb(0, 128, 0)",
    `Computed: #simple color reflects inline rgb(0, 128, 0): got ${JSON.stringify(findComputedValue(response, "color"))}`,
  ).toBeTruthy();
  expect(
    findComputedValue(response, "font-size") === "14px",
    "Computed: #simple font-size reflects inline 14px",
  ).toBeTruthy();
}

test("css-inline-style-demo", async ({ page }) => {
  const HTML = `<!doctype html>
<html>
<body>
  <div id="plain">no style attr</div>
  <div id="empty" style="">empty style attr</div>
  <div id="simple" style="color: rgb(0, 128, 0); font-size: 14px; padding: 4px;">simple</div>
  <div id="shorthand" style="margin: 10px 20px; color: blue !important;">shorthand</div>
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
  const nodes = [
    findById(doc.root, "plain"),
    findById(doc.root, "empty"),
    findById(doc.root, "simple"),
    findById(doc.root, "shorthand"),
  ] as const;
  expectFourNodes(nodes, "located all four fixture nodes");
  const [plain, empty, simple, shorthand] = nodes;

  const rPlain = await session.send("CSS.getInlineStylesForNode", {
    nodeId: plain.nodeId,
  });
  expectPlainNodeStyles(rPlain);

  const rEmpty = await session.send("CSS.getInlineStylesForNode", {
    nodeId: empty.nodeId,
  });
  expectEmptyInlineProperties(rEmpty);
  expectEmptyShorthandEntries(rEmpty);

  const rSimple = await session.send("CSS.getInlineStylesForNode", {
    nodeId: simple.nodeId,
  });
  const simpleProps = inlineProperties(rSimple);
  expectSimpleDeclarations(simpleProps);
  expectSimpleCssText(rSimple);

  const rShort = await session.send("CSS.getInlineStylesForNode", {
    nodeId: shorthand.nodeId,
  });
  const shortProps = inlineProperties(rShort);
  expectShorthandDeclarations(shortProps);
  expectNoShorthandEntries(rShort);

  const rComputed = await session.send("CSS.getComputedStyleForNode", {
    nodeId: simple.nodeId,
  });
  expectComputedValues(rComputed);
});
