// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import type { Protocol } from "devtools-protocol";

type CdpNode = Protocol.DOM.Node;

function findNode(n: CdpNode | undefined, pred: (n: CdpNode) => boolean): CdpNode | null {
  if (!n) return null;
  if (pred(n)) return n;
  return findChildNode(n, pred);
}

function findChildNode(n: CdpNode, pred: (n: CdpNode) => boolean): CdpNode | null {
  for (const c of n.children ?? []) {
    const hit = findNode(c, pred);
    if (hit) return hit;
  }
  return null;
}

test("oopif-elements-panel", async ({ page, cdpSession }) => {
  await page.goto("http://localhost:8787/__fixtures/oopif-host-quads.html", {
    waitUntil: "load",
    timeout: 60000,
  });
  await new Promise((r) => setTimeout(r, 200));

  const { root } = await cdpSession.send("DOM.getDocument", {
    depth: -1,
  });
  const iframeNode = findNode(root, (n) => n.nodeName === "IFRAME");
  expect(iframeNode, "iframe node missing from parent tree").toBeTruthy();
  const frameId = iframeNode!.frameId;
  if (!frameId) {
    throw new Error("cross-origin iframe node must be stamped with its frameId");
  }

  const { targetInfos } = await cdpSession.send("Target.getTargets");
  const childTarget = targetInfos.find((t) => t.targetId === frameId);
  expect(childTarget, `no target for frameId ${frameId}`).toBeTruthy();
  expect(childTarget!.type).toBe("iframe");

  const { sessionId } = await cdpSession.send("Target.attachToTarget", {
    targetId: frameId,
    flatten: true,
  });
  const child = cdpSession.connection()?.session(sessionId);
  if (!child) throw new Error(`no session ${sessionId} on the connection`);
  const childDoc = await child.send("DOM.getDocument", { depth: -1 });
  expect(childDoc.root.documentURL).toContain("oopif-child-quads");

  const divs: CdpNode[] = [];
  const collect = (n: CdpNode) => {
    if (n.nodeName === "DIV") divs.push(n);
    (n.children ?? []).forEach(collect);
  };
  collect(childDoc.root);
  expect(divs.length).toBeGreaterThanOrEqual(5);

  const quad = divs.find((d) => (d.attributes ?? []).some((a) => a.includes("#ff0000")));
  expect(quad, "red quad div missing").toBeTruthy();
  const outer = await child.send("DOM.getOuterHTML", {
    nodeId: quad!.nodeId,
  });
  expect(outer.outerHTML).toContain("#ff0000");
  const attrs = await child.send("DOM.getAttributes", {
    nodeId: quad!.nodeId,
  });
  expect(attrs.attributes.join(" ")).toContain("background:#ff0000");

  const parentQuad = findNode(root, (n) => (n.attributes ?? []).some((a) => a.includes("#ff0000")));
  expect(parentQuad).toBeNull();

  const owner = await cdpSession.send("DOM.getFrameOwner", {
    frameId,
  });
  expect(owner.backendNodeId).toBe(iframeNode!.backendNodeId);
  expect(owner.nodeId).toBe(iframeNode!.nodeId);

  await expect(
    cdpSession.send("DOM.getFrameOwner", {
      frameId: "deadbeef".repeat(4),
    }),
  ).rejects.toThrow(/not found/i);

  const sawDocUpdated = new Promise<void>((resolveWait) => {
    child.on("DOM.documentUpdated", () => resolveWait());
  });
  await child.send("DOM.enable");
  await Promise.race([
    sawDocUpdated,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error("no DOM.documentUpdated within 3s")), 3000),
    ),
  ]);
});
