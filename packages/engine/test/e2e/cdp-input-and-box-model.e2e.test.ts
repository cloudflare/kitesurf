// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

interface Box {
  content: number[];
  width: number;
  height: number;
}

test("DOM.getBoxModel: inline anchors report real boxes, boxless errors", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/inline-box-model.html", {
    waitUntil: "domcontentloaded",
  });
  const session = await page.createCDPSession();
  await session.send("DOM.enable");
  const { root } = (await session.send("DOM.getDocument", { depth: -1 })) as {
    root: { nodeId: number };
  };

  const boxFor = async (selector: string) => {
    const { nodeId } = (await session.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector,
    })) as { nodeId: number };
    expect(nodeId, `${selector} must resolve`).toBeGreaterThan(0);
    return session.send("DOM.getBoxModel", { nodeId }) as Promise<{ model: Box }>;
  };
  const jsRect = (selector: string) =>
    page.evaluate((sel: string) => {
      const r = document.querySelector(sel)!.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }, selector);

  const plain = await boxFor("#plain");
  const plainJs = await jsRect("#plain");
  expect(plain.model.width).toBeGreaterThan(0);
  expect(plain.model.height).toBeGreaterThan(0);
  expect(plain.model.width).toBe(Math.round(plainJs.width));
  expect(plain.model.height).toBe(Math.round(plainJs.height));
  expect(Number.isInteger(plain.model.width)).toBe(true);
  expect(Number.isInteger(plain.model.height)).toBe(true);
  expect(plain.model.content[0]).toBeGreaterThan(20);
  expect(plain.model.content[1]).toBeGreaterThan(10);

  for (const selector of ["#padded", "#blocky"]) {
    const box = await boxFor(selector);
    const js = await jsRect(selector);
    expect(box.model.width, selector).toBe(Math.round(js.width));
    expect(box.model.height, selector).toBe(Math.round(js.height));
  }

  await expect(boxFor("#hidden")).rejects.toThrow(/could not compute box model/i);
});

// A text node has no layout box of its own, and blitz panicked
// ("`final_layout` is not available on this node kind") when a CDP
// client measured one. It now gets the
// box of its laid-out text; a comment has none.
test("DOM.getContentQuads / getBoxModel on text and comment nodes", async ({
  page,
  cdpSession: session,
}) => {
  await setContent(
    page,
    '<p id="p" style="font:16px/20px sans-serif"><b>bold</b>tail<!-- note --></p>',
  );
  await session.send("DOM.enable");
  const { root } = await session.send("DOM.getDocument", { depth: -1 });
  const { nodeId: pId } = await session.send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector: "#p",
  });
  type DomNode = typeof root;
  const find = (n: DomNode): DomNode | undefined =>
    n.nodeId === pId ? n : (n.children ?? []).map(find).find(Boolean);
  const kids = find(root)?.children ?? [];
  // DOM nodeType values; the test runs in workerd, which has no Node.
  const TEXT_NODE = 3;
  const COMMENT_NODE = 8;
  const tail = kids.find((k) => k.nodeType === TEXT_NODE);
  const comment = kids.find((k) => k.nodeType === COMMENT_NODE);
  if (!tail || !comment) throw new Error("#p must have a text and a comment child");

  const { quads } = await session.send("DOM.getContentQuads", { nodeId: tail.nodeId });
  expect(quads).toHaveLength(1);
  // A quad is four corners from the top-left, clockwise.
  const [left, , right] = quads[0] ?? [];
  const bold = await page.evaluate(`document.querySelector("b").getBoundingClientRect().right`);
  if (typeof left !== "number" || typeof right !== "number" || typeof bold !== "number") {
    throw new Error(`unexpected quad ${JSON.stringify(quads)} or <b> edge ${String(bold)}`);
  }
  // Right of "bold", on the paragraph's first line.
  expect(left).toBeGreaterThanOrEqual(bold - 0.5);
  expect(right - left).toBeGreaterThan(0);
  const { model } = await session.send("DOM.getBoxModel", { nodeId: tail.nodeId });
  expect(model.height).toBeGreaterThan(0);

  const none = await session.send("DOM.getContentQuads", { nodeId: comment.nodeId });
  expect(none.quads).toEqual([]);
  await expect(session.send("DOM.getBoxModel", { nodeId: comment.nodeId })).rejects.toThrow(
    /could not compute box model/i,
  );
});

// Playwright measures elements by the Runtime objectId of its handle, never by nodeId.
test("DOM.getBoxModel / getContentQuads accept a Runtime objectId", async ({
  page,
  cdpSession: session,
}) => {
  await setContent(
    page,
    '<div id="box" style="position:absolute;left:30px;top:40px;width:120px;height:50px"></div>',
  );
  const { result } = await session.send("Runtime.evaluate", {
    expression: 'document.getElementById("box")',
  });
  const objectId = result.objectId;
  if (!objectId) throw new Error(`evaluate returned no objectId: ${JSON.stringify(result)}`);

  const { model } = await session.send("DOM.getBoxModel", { objectId });
  expect(model.content).toEqual([30, 40, 150, 40, 150, 90, 30, 90]);
  expect([model.width, model.height]).toEqual([120, 50]);

  const { quads } = await session.send("DOM.getContentQuads", { objectId });
  expect(quads).toEqual([[30, 40, 150, 40, 150, 90, 30, 90]]);

  await expect(session.send("DOM.getBoxModel", { objectId: "ps:999999" })).rejects.toThrow(
    /could not compute box model/i,
  );
});

test("Input.insertText: inserts strings longer than a few chars", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/keyboard.html", {
    waitUntil: "domcontentloaded",
  });
  const session = await page.createCDPSession();

  const value = () => page.evaluate(() => (document.querySelector("#i") as any).value);
  await page.evaluate(() => (document.querySelector("#i") as any).focus());

  await session.send("Input.insertText", { text: "hello@example.com" });
  expect(await value()).toBe("hello@example.com");

  await session.send("Input.insertText", { text: "/inbox" });
  expect(await value()).toBe("hello@example.com/inbox");

  await session.send("Input.insertText", { text: "\r" });
  expect(await value()).toBe("hello@example.com/inbox");
  await session.send("Input.insertText", { text: "\t" });
  expect(await value()).toBe("hello@example.com/inbox\t");
});
