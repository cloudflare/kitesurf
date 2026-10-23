// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import type { Protocol } from "devtools-protocol";

type DomNode = Protocol.DOM.Node;

function hasId(node: DomNode, id: string): boolean {
  const attributes = node.attributes ?? [];
  const index = attributes.indexOf("id");
  return index >= 0 && attributes[index + 1] === id;
}

function findById(node: DomNode, id: string): DomNode | null {
  if (hasId(node, id)) return node;
  for (const child of node.children ?? []) {
    const found = findById(child, id);
    if (found) return found;
  }
  return null;
}

test("screencast-viewport-demo", async ({ page }) => {
  const HTML_URL =
    "data:text/html;charset=utf-8," +
    encodeURIComponent(`<!doctype html>
<html><head><style>
  body { margin: 0; font-family: sans-serif; }
  .full { width: 100vw; height: 100vh; background: #eef; position: relative; }
  .corner { position: absolute; right: 8px; bottom: 8px; padding: 4px 8px; background: #f88; }
  .center { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); padding: 4px 8px; background: #ff8; }
</style></head>
<body><div class="full">
  <span class="center" id="center">center</span>
  <span class="corner" id="corner">corner</span>
</div></body></html>`);

  await page.goto(HTML_URL, { timeout: 25000 });

  const session = await page.target().createCDPSession();

  async function cornerRect() {
    const { root } = await session.send("DOM.getDocument", { depth: -1 });
    const n = findById(root, "corner");
    if (!n) return null;
    const { model } = await session.send("DOM.getBoxModel", { nodeId: n.nodeId });
    return { x: model.content[0], y: model.content[1], w: model.width, h: model.height };
  }

  const defaultRect = await cornerRect();
  console.log("[viewport] default rect:", defaultRect);
  expect(defaultRect, "default-rect-exists").toBeTruthy();
  expect(
    defaultRect.x > 600 && defaultRect.x < 800,
    `default-rect-near-800x600 (x=${defaultRect.x})`,
  ).toBeTruthy();

  await session.send("Page.startScreencast", {
    format: "jpeg",
    quality: 80,
    maxWidth: 1280,
    maxHeight: 900,
    everyNthFrame: 1,
  });
  const wideRect = await cornerRect();
  console.log("[viewport] 1280x900 rect:", wideRect);
  expect(wideRect, "wide-rect-exists").toBeTruthy();
  expect(
    wideRect.x > 1100 && wideRect.x < 1280,
    `wide-rect-near-1280x900 (x=${wideRect.x})`,
  ).toBeTruthy();
  expect(Math.abs(wideRect.x - defaultRect.x), "wide-rect-different-from-default").toBeGreaterThan(
    100,
  );

  await session.send("Page.startScreencast", {
    format: "jpeg",
    quality: 80,
    maxWidth: 400,
    maxHeight: 300,
    everyNthFrame: 1,
  });
  const smallRect = await cornerRect();
  console.log("[viewport] 400x300 rect:", smallRect);
  expect(smallRect, "small-rect-exists").toBeTruthy();
  expect(
    smallRect.x > 200 && smallRect.x < 400,
    `small-rect-near-400x300 (x=${smallRect.x})`,
  ).toBeTruthy();

  await session.send("Page.startScreencast", {
    format: "jpeg",
    quality: 80,
    maxWidth: 400,
    maxHeight: 300,
    everyNthFrame: 1,
  });
  const smallRect2 = await cornerRect();
  expect({ x: smallRect2.x, y: smallRect2.y }, "idempotent-resize").toStrictEqual({
    x: smallRect.x,
    y: smallRect.y,
  });

  const { backendNodeId } = await session.send("DOM.getNodeForLocation", {
    x: 395,
    y: 295,
  });
  expect(
    typeof backendNodeId === "number" && backendNodeId > 0,
    `hit-test-at-new-corner (backendNodeId=${backendNodeId})`,
  ).toBeTruthy();

  await session.send("Page.stopScreencast");
});
