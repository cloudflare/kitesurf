// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { CDPSession } from "@cloudflare/puppeteer";

import { expect, test } from "./harness";
import { setContent } from "./set-content";

type CdpNode = {
  nodeId: number;
  nodeName: string;
  childNodeCount?: number;
  children?: CdpNode[];
};

const HTML = "<div id=outer><section><p id=deep>deep</p><p>other</p></section></div>";

function child(node: CdpNode, name: string): CdpNode {
  const found = node.children?.find((c) => c.nodeName === name);
  if (!found) throw new Error(`${name} missing under ${node.nodeName}`);
  return found;
}

function record(session: CDPSession, method: string): unknown[] {
  const seen: unknown[] = [];
  session.on(method, (params: unknown) => seen.push(params));
  return seen;
}

test("DOM.getDocument describes two levels by default", async ({ page }) => {
  await setContent(page, HTML);
  const session = await page.createCDPSession();
  try {
    const { root } = (await session.send("DOM.getDocument")) as { root: CdpNode };
    const body = child(child(root, "HTML"), "BODY");
    expect(body.children).toBeUndefined();
    expect(body.childNodeCount).toBe(1);

    const zero = (await session.send("DOM.getDocument", { depth: 0 })) as { root: CdpNode };
    expect(zero.root.children).toBeUndefined();
  } finally {
    await session.detach();
  }
});

test("DOM.requestChildNodes sends one level unless asked and rejects depth 0", async ({ page }) => {
  await setContent(page, HTML);
  const session = await page.createCDPSession();
  try {
    const setChildNodes = record(session, "DOM.setChildNodes");
    const { root } = (await session.send("DOM.getDocument")) as { root: CdpNode };
    const body = child(child(root, "HTML"), "BODY");
    await session.send("DOM.requestChildNodes", { nodeId: body.nodeId });
    await expect.poll(() => setChildNodes.length).toBe(1);
    const [{ nodes }] = setChildNodes as [{ nodes: CdpNode[] }];
    expect(nodes.map((n) => n.nodeName)).toEqual(["DIV"]);
    expect(nodes[0]?.children).toBeUndefined();

    await expect(
      session.send("DOM.requestChildNodes", { nodeId: body.nodeId, depth: 0 }),
    ).rejects.toThrow(/positive integer as a depth/);
  } finally {
    await session.detach();
  }
});

test("a change under a parent the client has not expanded is a count update", async ({ page }) => {
  await setContent(page, HTML);
  const session = await page.createCDPSession();
  try {
    await session.send("DOM.enable");
    const inserted = record(session, "DOM.childNodeInserted");
    const counts = record(session, "DOM.childNodeCountUpdated");
    const setChildNodes = record(session, "DOM.setChildNodes");
    const { root } = (await session.send("DOM.getDocument")) as { root: CdpNode };
    const body = child(child(root, "HTML"), "BODY");

    await page.evaluate(() => document.body.append(document.createElement("span")));
    await expect.poll(() => counts).toContainEqual({ nodeId: body.nodeId, childNodeCount: 2 });
    expect(inserted).toEqual([]);

    await session.send("DOM.requestChildNodes", { nodeId: body.nodeId });
    await expect.poll(() => setChildNodes.length).toBe(1);
    await page.evaluate(() => document.body.append(document.createElement("em")));
    await expect
      .poll(() => inserted.map((e) => (e as { node: CdpNode }).node.nodeName))
      .toEqual(["EM"]);
  } finally {
    await session.detach();
  }
});

test("DOM.querySelector sends the path to the node it returns", async ({ page }) => {
  await setContent(page, HTML);
  const session = await page.createCDPSession();
  try {
    const setChildNodes = record(session, "DOM.setChildNodes") as Array<{
      parentId: number;
      nodes: CdpNode[];
    }>;
    const { root } = (await session.send("DOM.getDocument")) as { root: CdpNode };
    const { nodeId } = (await session.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: "#deep",
    })) as { nodeId: number };
    expect(nodeId).toBeGreaterThan(0);
    const sent = setChildNodes.flatMap((e) => e.nodes.map((n) => n.nodeName));
    // BODY's, DIV's and SECTION's children, outermost first.
    expect(sent).toEqual(["DIV", "SECTION", "P", "P"]);
    expect(setChildNodes.at(-1)?.nodes.some((n) => n.nodeId === nodeId)).toBe(true);
  } finally {
    await session.detach();
  }
});
