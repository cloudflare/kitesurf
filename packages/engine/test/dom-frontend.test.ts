// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Protocol } from "devtools-protocol";
import { expect, it } from "vitest";

import { DomFrontendNodes } from "../src/cdp/dom-frontend.ts";

function element(
  nodeId: number,
  nodeName: string,
  extra: Partial<Protocol.DOM.Node> = {},
): Protocol.DOM.Node {
  return {
    nodeId,
    backendNodeId: nodeId,
    nodeType: 1,
    nodeName,
    localName: nodeName.toLowerCase(),
    nodeValue: "",
    ...extra,
  };
}

function shadowRoot(nodeId: number, children: Protocol.DOM.Node[]): Protocol.DOM.Node {
  return {
    nodeId,
    backendNodeId: nodeId,
    nodeType: 11,
    nodeName: "#document-fragment",
    localName: "",
    nodeValue: "",
    shadowRootType: "open",
    children,
  };
}

// `DOM.setChildNodes` replaces the client's `children` for a node; shadow roots are a separate
// field, so a shadow tree the client already holds must stay bound.
it("keeps a shadow tree when the host's light children are replaced", () => {
  const nodes = new DomFrontendNodes();
  nodes.bindTree(
    element(1, "DIV", { children: [], shadowRoots: [shadowRoot(2, [element(3, "SPAN")])] }),
  );
  expect(nodes.isBound(3)).toBe(true);

  nodes.bindChildren(1, []);

  expect(nodes.isBound(2)).toBe(true);
  expect(nodes.isBound(3)).toBe(true);
});

it("keeps a pushed shadow tree and drops replaced light children", () => {
  const nodes = new DomFrontendNodes();
  nodes.bindTree(element(1, "DIV", { children: [element(4, "P")] }));

  nodes.noteShadowRoot(1, shadowRoot(2, [element(3, "SPAN")]));
  expect(nodes.isBound(2)).toBe(true);
  expect(nodes.isBound(3)).toBe(true);

  nodes.bindChildren(1, []);
  expect(nodes.isBound(2)).toBe(true);
  expect(nodes.isBound(3)).toBe(true);
  expect(nodes.isBound(4)).toBe(false);
});
