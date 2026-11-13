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

// A moved node is re-sent at depth 0, so the client rebuilds it without children. The old
// bindings must go, or a later query for a descendant returns an id the client cannot place.
const MOVE_HTML =
  "<div id=outer><section><p id=deep>deep</p><p>other</p></section><p id=sib>sib</p></div>";

async function movedNodeReSendsItsSubtree(
  page: Parameters<typeof setContent>[0],
  session: CDPSession,
  move: string,
): Promise<void> {
  await setContent(page, MOVE_HTML);
  await session.send("DOM.enable");
  const { root } = (await session.send("DOM.getDocument", { depth: -1 })) as { root: CdpNode };
  const inserted = record(session, "DOM.childNodeInserted");
  const setChildNodes = record(session, "DOM.setChildNodes") as Array<{
    parentId: number;
    nodes: CdpNode[];
  }>;

  await page.evaluate(move);
  await expect.poll(() => inserted.length).toBe(1);
  setChildNodes.length = 0;

  const { nodeId } = (await session.send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector: "#deep",
  })) as { nodeId: number };
  expect(nodeId).toBeGreaterThan(0);
  const pushed = setChildNodes.flatMap((event) => event.nodes);
  expect(pushed.some((node) => node.nodeId === nodeId)).toBe(true);
}

test("moving a node to another parent re-sends its descendants", async ({ page }) => {
  const session = await page.createCDPSession();
  try {
    await movedNodeReSendsItsSubtree(
      page,
      session,
      'document.body.append(document.querySelector("section"))',
    );
  } finally {
    await session.detach();
  }
});

test("reordering a node inside its own parent re-sends its descendants", async ({ page }) => {
  const session = await page.createCDPSession();
  try {
    await movedNodeReSendsItsSubtree(
      page,
      session,
      'document.getElementById("outer").appendChild(document.querySelector("section"))',
    );
  } finally {
    await session.detach();
  }
});
