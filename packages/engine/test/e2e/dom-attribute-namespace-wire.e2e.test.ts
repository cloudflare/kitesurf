// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("DOM.describeNode exposes qualified attributes without internal namespace metadata", async ({
  page,
}) => {
  await setContent(
    page,
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
      '<path xlink:href="#source"></path></svg>',
  );
  const session = await page.createCDPSession();
  try {
    const { root } = (await session.send("DOM.getDocument", { depth: -1 })) as {
      root: { nodeId: number };
    };
    const { nodeId } = (await session.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: "path",
    })) as { nodeId: number };
    expect(nodeId).toBeGreaterThan(0);

    const { node } = (await session.send("DOM.describeNode", { nodeId })) as {
      node: { attributes?: string[]; attributeNamespaces?: unknown };
    };
    expect(node.attributes).toContain("xlink:href");
    expect("attributeNamespaces" in node).toBe(false);
  } finally {
    await session.detach();
  }
});

test("DOM.getDocument omits internal namespace metadata in shadow roots", async ({ page }) => {
  await setContent(page, "<div id=host></div>");
  await page.evaluate(() => {
    const host = document.querySelector("#host");
    if (!(host instanceof HTMLElement)) throw new Error("shadow host is missing");
    host.attachShadow({ mode: "open" }).innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
      '<path xlink:href="#source"></path></svg>';
  });

  const session = await page.createCDPSession();
  try {
    type CdpNode = {
      nodeName: string;
      attributeNamespaces?: unknown;
      children?: CdpNode[];
      shadowRoots?: CdpNode[];
    };
    const { root } = (await session.send("DOM.getDocument", { depth: -1, pierce: true })) as {
      root: CdpNode;
    };
    const findPath = (node: CdpNode): CdpNode | null => {
      if (node.nodeName.toLowerCase() === "path") return node;
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
        const match = findPath(child);
        if (match) return match;
      }
      return null;
    };
    const path = findPath(root);
    if (!path) throw new Error("shadow path was missing from DOM.getDocument");
    expect("attributeNamespaces" in path).toBe(false);
  } finally {
    await session.detach();
  }
});

test("DOM.childNodeInserted omits internal attribute namespace metadata", async ({ page }) => {
  await setContent(
    page,
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"></svg>',
  );
  const session = await page.createCDPSession();
  try {
    await session.send("DOM.enable");
    // Insert events reach only a client that holds the parent's children.
    await session.send("DOM.getDocument", { depth: -1 });
    type CdpNode = {
      nodeName: string;
      attributes?: string[];
      attributeNamespaces?: unknown;
    };
    const insertedPath = new Promise<CdpNode>((resolve) => {
      const onInserted = ({ node }: { node: CdpNode }) => {
        if (node.nodeName !== "path") return;
        session.off("DOM.childNodeInserted", onInserted);
        resolve(node);
      };
      session.on("DOM.childNodeInserted", onInserted);
    });

    await page.evaluate(() => {
      const svg = document.querySelector("svg");
      if (!svg) throw new Error("svg is missing");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", "#source");
      svg.appendChild(path);
    });

    const path = await insertedPath;
    expect(path.attributes).toContain("xlink:href");
    expect("attributeNamespaces" in path).toBe(false);
  } finally {
    await session.detach();
  }
});

test("the first setAttributeNS write retains its namespace", async ({ page }) => {
  await setContent(page, "<p>Namespace mutation</p>");

  const actual = await page.evaluate(() => {
    const element = document.createElement("div");
    element.setAttributeNS("urn:test", "p:name", "yes");
    const attribute = element.getAttributeNode("p:name");
    return {
      value: element.getAttributeNS("urn:test", "name"),
      namespaceURI: attribute?.namespaceURI ?? null,
      localName: attribute?.localName ?? null,
    };
  });

  expect(actual).toEqual({
    value: "yes",
    namespaceURI: "urn:test",
    localName: "name",
  });
});
