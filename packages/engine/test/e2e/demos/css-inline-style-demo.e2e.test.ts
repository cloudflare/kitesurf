// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

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
  const plain = findById(doc.root, "plain");
  const empty = findById(doc.root, "empty");
  const simple = findById(doc.root, "simple");
  const shorthand = findById(doc.root, "shorthand");
  expect(!!(plain && empty && simple && shorthand), "located all four fixture nodes").toBeTruthy();

  const rPlain = await session.send("CSS.getInlineStylesForNode", {
    nodeId: plain.nodeId,
  });
  expect(
    rPlain && rPlain.inlineStyle === undefined,
    "#plain returns no inlineStyle (no style attr): " + JSON.stringify(rPlain).slice(0, 120),
  ).toBeTruthy();

  const rEmpty = await session.send("CSS.getInlineStylesForNode", {
    nodeId: empty.nodeId,
  });
  expect(
    !!rEmpty?.inlineStyle,
    "#empty returns inlineStyle object: " + JSON.stringify(rEmpty).slice(0, 120),
  ).toBeTruthy();
  expect(
    Array.isArray(rEmpty?.inlineStyle?.cssProperties) &&
      rEmpty.inlineStyle.cssProperties.length === 0,
    "#empty cssProperties is empty array",
  ).toBeTruthy();
  expect(
    Array.isArray(rEmpty?.inlineStyle?.shorthandEntries) &&
      rEmpty.inlineStyle.shorthandEntries.length === 0,
    "#empty shorthandEntries is empty array",
  ).toBeTruthy();
  expect(rEmpty?.inlineStyle?.cssText, "#empty cssText is the empty string").toBe("");

  const rSimple = await session.send("CSS.getInlineStylesForNode", {
    nodeId: simple.nodeId,
  });
  const simpleProps = rSimple?.inlineStyle?.cssProperties ?? [];
  expect(
    simpleProps.length === 3,
    `#simple has 3 declarations: got ${simpleProps.length}: ${JSON.stringify(simpleProps)}`,
  ).toBeTruthy();
  const findProp = (props, name) => props.find((p) => p.name === name);
  expect(
    findProp(simpleProps, "color")?.value === "rgb(0, 128, 0)",
    `#simple color = rgb(0, 128, 0): got ${JSON.stringify(findProp(simpleProps, "color"))}`,
  ).toBeTruthy();
  expect(
    findProp(simpleProps, "font-size")?.value === "14px",
    "#simple font-size = 14px",
  ).toBeTruthy();
  expect(findProp(simpleProps, "padding")?.value === "4px", "#simple padding = 4px").toBeTruthy();
  expect(
    simpleProps.every((p) => p.important !== true),
    "#simple no declaration is marked !important: " + JSON.stringify(simpleProps),
  ).toBeTruthy();
  expect(
    typeof rSimple?.inlineStyle?.cssText === "string" &&
      rSimple.inlineStyle.cssText.includes("rgb(0, 128, 0)") &&
      rSimple.inlineStyle.cssText.includes("14px"),
    "#simple cssText preserves the original attribute body: got " +
      JSON.stringify(rSimple?.inlineStyle?.cssText),
  ).toBeTruthy();

  const rShort = await session.send("CSS.getInlineStylesForNode", {
    nodeId: shorthand.nodeId,
  });
  const shortProps = rShort?.inlineStyle?.cssProperties ?? [];
  expect(
    shortProps.length === 2,
    `#shorthand has 2 declarations (margin + color, no expansion): got ${shortProps.length}: ${JSON.stringify(shortProps)}`,
  ).toBeTruthy();
  expect(
    !!findProp(shortProps, "margin"),
    "#shorthand keeps margin as a single shorthand entry: " +
      JSON.stringify(shortProps.map((p) => p.name)),
  ).toBeTruthy();
  expect(
    findProp(shortProps, "margin")?.value === "10px 20px",
    `#shorthand margin value = 10px 20px: got ${JSON.stringify(findProp(shortProps, "margin"))}`,
  ).toBeTruthy();
  expect(
    findProp(shortProps, "color")?.value === "blue" &&
      findProp(shortProps, "color")?.important === true,
    `#shorthand color = blue with !important flag: got ${JSON.stringify(findProp(shortProps, "color"))}`,
  ).toBeTruthy();
  expect(
    Array.isArray(rShort?.inlineStyle?.shorthandEntries) &&
      rShort.inlineStyle.shorthandEntries.length === 0,
    "#shorthand no shorthandEntries (we don't populate the field)",
  ).toBeTruthy();

  const rComputed = await session.send("CSS.getComputedStyleForNode", {
    nodeId: simple.nodeId,
  });
  const computed = rComputed?.computedStyle ?? [];
  const findComp = (name) => computed.find((p) => p.name === name)?.value;
  expect(
    findComp("color") === "rgb(0, 128, 0)",
    `Computed: #simple color reflects inline rgb(0, 128, 0): got ${JSON.stringify(findComp("color"))}`,
  ).toBeTruthy();
  expect(
    findComp("font-size") === "14px",
    "Computed: #simple font-size reflects inline 14px",
  ).toBeTruthy();
});
