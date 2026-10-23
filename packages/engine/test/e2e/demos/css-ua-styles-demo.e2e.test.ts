// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { setTimeout as sleep } from "node:timers/promises";

import { expect, test } from "../harness";
import type { Protocol } from "devtools-protocol";

type CdpNode = Protocol.DOM.Node;
type MatchedStyles = Protocol.CSS.GetMatchedStylesForNodeResponse;

function nodeHasTag(node: CdpNode, tag: string): boolean {
  return (node.nodeName || "").toLowerCase() === tag;
}

function nodeChildren(node: CdpNode): CdpNode[] {
  return Array.isArray(node.children) ? node.children : [];
}

function findByTag(root: CdpNode, tag: string): CdpNode | null {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (nodeHasTag(node, tag)) return node;
    for (const child of nodeChildren(node)) stack.push(child);
  }
  return null;
}

function expectFound<T>(value: T | null, message: string): asserts value is T {
  expect(!!value, message).toBeTruthy();
}

function expectUaHeader(
  header: Protocol.CSS.CSSStyleSheetHeader | null,
): asserts header is Protocol.CSS.CSSStyleSheetHeader {
  expect(
    header !== null,
    "CSS.styleSheetAdded emitted with origin:'user-agent' (no UA header captured)",
  ).toBeTruthy();
  expect(header.isInline, "UA header isInline === false").toBe(false);
  expect(header.ownerNode, "UA header has no ownerNode (sheet has no DOM owner)").toBeUndefined();
  expect(header.length > 1000, `UA header length > 0: got: ${header.length}`).toBeTruthy();
}

function expectUaStylesheetText(text: string): void {
  expect(
    typeof text === "string" && text.length > 1000,
    `getStyleSheetText returns UA body: length: ${text?.length}`,
  ).toBeTruthy();
  expect(text.includes("@namespace"), "UA text contains @namespace declaration").toBeTruthy();
  expect(
    /body\s*\{[^}]*display:\s*block/s.test(text),
    "UA text contains the body { display: block } rule",
  ).toBeTruthy();
}

function expectBodyUaRules(response: MatchedStyles): void {
  const rules = (response.matchedCSSRules ?? []).filter(
    (match) => match.rule.origin === "user-agent",
  );
  expect(
    rules.length > 0,
    `<body> matched-rules include UA defaults: total: ${response.matchedCSSRules?.length}, UA: ${rules.length}`,
  ).toBeTruthy();
  expect(
    rules.some(
      (match) =>
        match.rule.selectorList.text === "body" &&
        match.rule.style.cssProperties.some(
          (property) => property.name === "display" && property.value === "block",
        ),
    ),
    "<body> UA rules include the `body { display: block; margin: 8px }` rule: selectors: " +
      JSON.stringify(rules.map((match) => match.rule.selectorList.text)),
  ).toBeTruthy();
}

function expectDivUaRules(response: MatchedStyles): void {
  const rules = (response.matchedCSSRules ?? []).filter(
    (match) => match.rule.origin === "user-agent",
  );
  expect(rules.length > 0, "<div> matched-rules include UA defaults").toBeTruthy();
  expect(
    rules.some((match) =>
      match.rule.style.cssProperties.some(
        (property) => property.name === "display" && property.value === "block",
      ),
    ),
    "<div> UA rules include a rule setting `display: block`: UA rules: " +
      JSON.stringify(rules.map((match) => match.rule.selectorList.text)),
  ).toBeTruthy();
}

test("css-ua-styles-demo", async ({ page }) => {
  const HTML = `<!doctype html>
<html><body><div id="x">hello</div></body></html>`;

  const session = await page.target().createCDPSession();

  let uaHeader: Protocol.CSS.CSSStyleSheetHeader | null = null;
  session.on("CSS.styleSheetAdded", (p) => {
    if (p.header.origin === "user-agent") uaHeader = p.header;
  });

  const tree = await session.send("Page.getFrameTree");
  await session.send("Page.setDocumentContent", {
    frameId: tree.frameTree.frame.id,
    html: HTML,
  });
  await sleep(150);
  await session.send("DOM.enable");
  await session.send("CSS.enable");
  const uaDeadline = Date.now() + 5000;
  while (uaHeader === null && Date.now() < uaDeadline) {
    await sleep(10);
  }

  expectUaHeader(uaHeader);

  const textR = await session.send("CSS.getStyleSheetText", {
    styleSheetId: uaHeader.styleSheetId,
  });
  expectUaStylesheetText(textR.text);

  const doc = await session.send("DOM.getDocument");
  const body = findByTag(doc.root, "body");
  const div = findByTag(doc.root, "div");
  expectFound(body, "located <body>");
  expectFound(div, "located <div>");

  const bodyMatched = await session.send("CSS.getMatchedStylesForNode", {
    nodeId: body.nodeId,
  });
  expectBodyUaRules(bodyMatched);

  const divMatched = await session.send("CSS.getMatchedStylesForNode", {
    nodeId: div.nodeId,
  });
  expectDivUaRules(divMatched);
});
