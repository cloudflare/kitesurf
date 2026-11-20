// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Protocol } from "devtools-protocol";

import { expect, test } from "../harness";

function findNode(
  node: Protocol.DOM.Node | undefined,
  predicate: (node: Protocol.DOM.Node) => boolean,
): Protocol.DOM.Node | null {
  if (!node) return null;
  if (predicate(node)) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return null;
}

test("OOPIF DOM.getDocument rejects an over-budget child document", async ({
  page,
  cdpSession,
}) => {
  await page.goto("http://localhost:8787/__fixtures/oopif-host-subtree-budget.html", {
    waitUntil: "load",
    timeout: 60_000,
  });
  const { root } = await cdpSession.send("DOM.getDocument", { depth: -1 });
  const iframe = findNode(root, (node) => node.nodeName === "IFRAME");
  if (!iframe?.frameId) throw new Error("OOPIF frame missing");

  const { sessionId } = await cdpSession.send("Target.attachToTarget", {
    targetId: iframe.frameId,
    flatten: true,
  });
  const child = cdpSession.connection()?.session(sessionId);
  if (!child) throw new Error(`no session ${sessionId} on the connection`);

  await expect(child.send("DOM.getDocument", { depth: -1 })).rejects.toThrow(
    /DOM\.getDocument.*nodes.*bytes.*budget.*DOM\.requestChildNodes/,
  );
});
