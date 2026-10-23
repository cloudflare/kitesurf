// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import type { Protocol } from "devtools-protocol";

type CdpNode = Protocol.DOM.Node;
type RuleMatch = Protocol.CSS.RuleMatch;
type MatchedStyles = Protocol.CSS.GetMatchedStylesForNodeResponse;

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

function captureFirstAuthorSheet(
  currentId: string | null,
  header: Protocol.CSS.CSSStyleSheetHeader,
): string | null {
  if (header.origin === "user-agent") return currentId;
  if (!currentId) return header.styleSheetId;
  return currentId;
}

function ruleMatches(response: MatchedStyles): RuleMatch[] {
  return response.matchedCSSRules ?? [];
}

function hasThreeRules(rules: RuleMatch[]): rules is [RuleMatch, RuleMatch, RuleMatch] {
  return rules.length === 3;
}

function expectRuleZeroSelectors(rule: RuleMatch): void {
  expect(
    rule.rule.selectorList.text === "p#x",
    `rule[0].selectorList.text === 'p#x': got: ${JSON.stringify(rule.rule.selectorList.text)}`,
  ).toBeTruthy();
  expect(
    Array.isArray(rule.matchingSelectors) &&
      rule.matchingSelectors.length === 1 &&
      rule.matchingSelectors[0] === 0,
    `rule[0].matchingSelectors === [0]: got: ${JSON.stringify(rule.matchingSelectors)}`,
  ).toBeTruthy();
}

function expectRuleZeroStyle(rule: RuleMatch): void {
  expect(
    rule.rule.style.cssProperties?.length === 3,
    `rule[0].style.cssProperties has 3 entries (color, font-size, margin-top): got: ${JSON.stringify(rule.rule.style.cssProperties)}`,
  ).toBeTruthy();
  expect(
    rule.rule.style.cssProperties[0]?.name === "color",
    "rule[0].style.cssProperties[0].name === 'color'",
  ).toBeTruthy();
  expect(
    typeof rule.rule.style.cssProperties[0]?.value === "string" &&
      rule.rule.style.cssProperties[0].value.includes("0, 128, 0"),
    "rule[0].style.cssProperties[0].value contains '0, 128, 0'",
  ).toBeTruthy();
}

function expectRuleTwo(rule: RuleMatch): void {
  expect(
    rule.rule.selectorList.selectors?.length === 2,
    `rule[2].selectorList has 2 selectors: got: ${JSON.stringify(rule.rule.selectorList.selectors)}`,
  ).toBeTruthy();
  expect(
    Array.isArray(rule.matchingSelectors) &&
      rule.matchingSelectors.length === 1 &&
      rule.matchingSelectors[0] === 0,
    `rule[2].matchingSelectors === [0]: got: ${JSON.stringify(rule.matchingSelectors)}`,
  ).toBeTruthy();
}

function everyRangeIsValid(rules: RuleMatch[]): boolean {
  let allRangesValid = true;
  for (const match of rules) {
    const range = match.rule.style.range;
    if (!range) {
      allRangesValid = false;
      break;
    }
    if (range.endLine < range.startLine) {
      allRangesValid = false;
      break;
    }
  }
  return allRangesValid;
}

function expectRuleRanges(rules: RuleMatch[]): void {
  expect(
    everyRangeIsValid(rules),
    `every matched rule has a valid body range: ranges: ${JSON.stringify(rules.map((m) => m.rule.style.range))}`,
  ).toBeTruthy();
}

function hasNumericSpecificityComponent(
  selector: Protocol.CSS.Value | undefined,
  component: "a" | "b" | "c",
): boolean {
  return typeof selector?.specificity?.[component] === "number";
}

function expectSelectorSpecificity(selector: Protocol.CSS.Value | undefined): void {
  expect(
    hasNumericSpecificityComponent(selector, "a") &&
      hasNumericSpecificityComponent(selector, "b") &&
      hasNumericSpecificityComponent(selector, "c"),
    `rule[2].selectors[0].specificity has 3 components: got: ${JSON.stringify(selector?.specificity)}`,
  ).toBeTruthy();
}

function expectAuthorRuleDetails(
  rules: RuleMatch[],
  allRules: RuleMatch[],
  firstSheetId: string | null,
): void {
  if (!hasThreeRules(rules)) return;
  const [rule0, _rule1, rule2] = rules;
  expectRuleZeroSelectors(rule0);
  expectRuleZeroStyle(rule0);
  expect(
    rule0.rule.styleSheetId === firstSheetId,
    "rule[0] uses the captured author sheet id",
  ).toBeTruthy();
  expect(rule0.rule.origin === "regular", "rule[0].rule.origin === 'regular'").toBeTruthy();
  expectRuleTwo(rule2);
  expectRuleRanges(allRules);
  const selector = rule2.rule.selectorList.selectors[0];
  expect(
    selector?.text === "body p",
    `rule[2].selectors[0].text === 'body p': got: ${JSON.stringify(selector)}`,
  ).toBeTruthy();
  expectSelectorSpecificity(selector);
}

function expectNoUnmatchedSelector(rules: RuleMatch[]): void {
  const selectorTexts = rules.map((match) => match.rule.selectorList.text);
  expect(
    !selectorTexts.includes(".nope"),
    "'.nope' rule is NOT matched (selector doesn't apply)",
  ).toBeTruthy();
}

function expectPseudoAndInheritedShapes(response: MatchedStyles): void {
  expect(
    Array.isArray(response.pseudoElements) && response.pseudoElements.length === 0,
    "pseudoElements is empty array",
  ).toBeTruthy();
  expect(
    Array.isArray(response.inherited) && response.inherited.length === 2,
    `inherited array has one entry per element ancestor: got ${response.inherited?.length}: ${JSON.stringify(response.inherited)}`,
  ).toBeTruthy();
  expect(
    Array.isArray(response.inherited) &&
      response.inherited.every(
        (entry) => Array.isArray(entry.matchedCSSRules) && entry.matchedCSSRules.length === 0,
      ),
    `inherited entries have zero matchedCSSRules (no inheritable rules match body/html here): got: ${JSON.stringify(response.inherited)}`,
  ).toBeTruthy();
}

test("css-matched-styles-demo", async ({ page }) => {
  const STYLE_TEXT =
    "p#x { color: rgb(0, 128, 0); font-size: 24px; margin-top: 10px; }\n" +
    "p.foo { font-weight: bold; }\n" +
    "body p, body span { padding: 5px; }\n" +
    ".nope { display: none; }";
  const HTML = `<!doctype html>
<html><head><style>${STYLE_TEXT}</style></head>
<body><p id="x" class="foo">hello</p></body></html>`;

  const session = await page.target().createCDPSession();

  let firstSheetId: string | null = null;
  session.on("CSS.styleSheetAdded", (p) => {
    firstSheetId = captureFirstAuthorSheet(firstSheetId, p.header);
  });

  const tree = await session.send("Page.getFrameTree");
  await session.send("Page.setDocumentContent", {
    frameId: tree.frameTree.frame.id,
    html: HTML,
  });
  await session.send("DOM.enable");
  await session.send("CSS.enable");
  await expect
    .poll(() => firstSheetId, { timeout: 10_000 })
    .toBeTruthy()
    .catch(() => {});

  expect(
    typeof firstSheetId === "string" && firstSheetId.length > 0,
    "captured styleSheetId from CSS.styleSheetAdded",
  ).toBeTruthy();

  const doc = await session.send("DOM.getDocument");
  const pNode = findById(doc.root, "x");
  expectNode(pNode, "located <p id=x> in DOM");

  const r = await session.send("CSS.getMatchedStylesForNode", {
    nodeId: pNode.nodeId,
  });

  expect(
    Array.isArray(r.matchedCSSRules),
    `matchedCSSRules is an array: got: ${typeof r.matchedCSSRules}`,
  ).toBeTruthy();
  const rules = ruleMatches(r);
  const authorRules = rules.filter((m) => m.rule.origin === "regular");
  expect(
    authorRules.length === 3,
    `3 author matched rules (p#x, p.foo, body p,body span): got ${authorRules.length}: ${JSON.stringify(authorRules.map((m) => m.rule.selectorList.text))}`,
  ).toBeTruthy();

  const uaRules = rules.filter((m) => m.rule.origin === "user-agent");
  expect(
    uaRules.length > 0,
    `UA rules also matched (paragraph defaults): got ${uaRules.length} UA rules`,
  ).toBeTruthy();

  expectAuthorRuleDetails(authorRules, rules, firstSheetId);
  expectNoUnmatchedSelector(rules);
  expectPseudoAndInheritedShapes(r);
});
