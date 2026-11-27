// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { beforeEach, expect, it, vi } from "vitest";
import {
  COMMENT_NODE,
  DOCUMENT_FRAGMENT_NODE,
  DOCUMENT_NODE,
  ELEMENT_NODE,
  HTML_NS,
  TEXT_NODE,
} from "../src/constants.js";
import { DocumentImpl } from "../src/document.js";
import {
  Element,
  HTML_ELEMENT_INTERFACES,
  InternalElementCtorToken,
  resolveElementClass,
} from "../src/element/index.js";
import {
  CommentNode,
  GenericNode,
  type NodeBase,
  TextNode,
  type WrapperInfo,
} from "../src/node-base.js";
import { elemNs, resetRegistries } from "../src/registries.js";
import { setDocumentImpl, setNodeFor, setNodePeek } from "../src/state.js";

const holder = vi.hoisted(() => ({ dom: null as FakeDom | null }));

vi.mock("../src/state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/state.js")>();
  return {
    ...actual,
    get dom() {
      return holder.dom;
    },
  };
});

interface FakeNode {
  nodeType: number;
  nodeName: string;
  localName: string;
  nodeValue: string;
  namespaceURI?: string;
  parent: number;
  childIds: number[];
  attributes: string[];
}

// A minimal wasm DOM: ids, identity, child links and the create/clone calls the
// shim makes. It mirrors blitz's HTML lowercasing and XML case preservation.
class FakeDom {
  nodes: FakeNode[] = [];
  constructor() {
    this.nodes.push(this.node(DOCUMENT_NODE, "#document", ""));
  }
  private node(
    nodeType: number,
    nodeName: string,
    localName: string,
    nodeValue = "",
    namespaceURI?: string,
  ): FakeNode {
    return {
      nodeType,
      nodeName,
      localName,
      nodeValue,
      namespaceURI,
      parent: -1,
      childIds: [],
      attributes: [],
    };
  }
  documentNodeId(): number {
    return 0;
  }
  nodeInfo(id: number): WrapperInfo | null {
    return this.nodes[id] ?? null;
  }
  nodeIdentity(id: number): WrapperInfo | null {
    return this.nodes[id] ?? null;
  }
  attributeList(id: number): { attributes: string[]; attributeNamespaces: string[] } {
    return { attributes: this.nodes[id]?.attributes ?? [], attributeNamespaces: [] };
  }
  childIds(id: number): number[] {
    return this.nodes[id]?.childIds.slice() ?? [];
  }
  parentId(id: number): number {
    return this.nodes[id]?.parent ?? -1;
  }
  createElement(tag: string): number {
    return this.push(this.node(ELEMENT_NODE, tag.toUpperCase(), tag));
  }
  createElementNS(ns: string, localName: string): number {
    const isHtml = ns === HTML_NS;
    return this.push(
      this.node(
        ELEMENT_NODE,
        isHtml ? localName.toUpperCase() : localName,
        localName,
        "",
        ns || undefined,
      ),
    );
  }
  createTextNode(text: string): number {
    return this.push(this.node(TEXT_NODE, "#text", "", text));
  }
  createComment(data: string): number {
    return this.push(this.node(COMMENT_NODE, "#comment", "", data));
  }
  createDocumentFragment(): number {
    return this.push(this.node(DOCUMENT_FRAGMENT_NODE, "#document-fragment", ""));
  }
  appendChildNode(parent: number, child: number): void {
    const parentNode = this.nodes[parent];
    const childNode = this.nodes[child];
    if (!parentNode || !childNode) return;
    this.detach(child);
    parentNode.childIds.push(child);
    childNode.parent = parent;
  }
  removeNode(id: number): void {
    this.detach(id);
  }
  deepCloneNode(id: number): number {
    const source = this.nodes[id];
    if (!source) return 0;
    const copy = this.node(
      source.nodeType,
      source.nodeName,
      source.localName,
      source.nodeValue,
      source.namespaceURI,
    );
    copy.attributes = source.attributes.slice();
    const copyId = this.push(copy);
    for (const child of source.childIds) {
      this.appendChildNode(copyId, this.deepCloneNode(child));
    }
    return copyId;
  }
  querySelectorAllInSubtree(): number[] {
    return [];
  }
  querySelectorAll(): number[] {
    return [];
  }
  descendantsOf(id: number): number[] {
    const out: number[] = [];
    const walk = (nodeId: number) => {
      for (const child of this.nodes[nodeId]?.childIds ?? []) {
        out.push(child);
        walk(child);
      }
    };
    walk(id);
    return out;
  }
  private push(node: FakeNode): number {
    this.nodes.push(node);
    return this.nodes.length - 1;
  }
  private detach(id: number): void {
    const node = this.nodes[id];
    if (!node || node.parent < 0) return;
    const siblings = this.nodes[node.parent]?.childIds;
    if (siblings) {
      const index = siblings.indexOf(id);
      if (index >= 0) siblings.splice(index, 1);
    }
    node.parent = -1;
  }
}

let dom: FakeDom;
let page: DocumentImpl;
let wrappers: Map<number, NodeBase>;

function nodeFor(id: number): NodeBase | null {
  if (id < 0) return null;
  const cached = wrappers.get(id);
  if (cached) return cached;
  const info = dom.nodeIdentity(id);
  if (!info) return null;
  let node: NodeBase;
  if (info.nodeType === ELEMENT_NODE) {
    const entry = elemNs.get(id);
    const Cls = resolveElementClass(info.localName, entry ? entry.ns : HTML_NS);
    node = new Cls(id, info, InternalElementCtorToken);
  } else if (info.nodeType === TEXT_NODE) {
    node = new TextNode(id, info);
  } else if (info.nodeType === COMMENT_NODE) {
    node = new CommentNode(id, info);
  } else {
    node = new GenericNode(id, info);
  }
  wrappers.set(id, node);
  return node;
}

beforeEach(() => {
  resetRegistries();
  dom = new FakeDom();
  holder.dom = dom;
  wrappers = new Map();
  setNodeFor(nodeFor);
  setNodePeek((id) => wrappers.get(id) ?? null);
  page = new DocumentImpl();
  setDocumentImpl(page);
});

interface CloneableDocument {
  cloneNode(deep?: boolean): CloneableDocument;
  createElement(tag: string): Element;
}

function asCloneableDocument(doc: object): CloneableDocument {
  if (!("cloneNode" in doc) || typeof doc.cloneNode !== "function") {
    throw new Error("expected detached document with cloneNode");
  }
  return doc as CloneableDocument;
}

function cloneElement(el: unknown, deep: boolean): Element {
  if (!(el instanceof Element)) {
    throw new Error("expected Element");
  }
  const cloned = el.cloneNode(deep);
  if (!(cloned instanceof Element)) {
    throw new Error("expected cloned Element");
  }
  return cloned;
}

it("keeps an HTML document's element mode across a clone", () => {
  const doc = asCloneableDocument(page.implementation.createHTMLDocument("")).cloneNode();
  const div = doc.createElement("div");
  expect(div).toBeInstanceOf(HTML_ELEMENT_INTERFACES.HTMLDivElement);
  expect(div.namespaceURI).toBe(HTML_NS);
  expect(div.style).toBeDefined();
});

it("keeps createDocument's HTML namespace across a clone", () => {
  const doc = asCloneableDocument(page.implementation.createDocument(HTML_NS, "html")).cloneNode();
  expect(doc.createElement("div")).toBeInstanceOf(HTML_ELEMENT_INTERFACES.HTMLDivElement);
});

it.each([false, true])("preserves an XHTML element's case across a clone (deep: %s)", (deep) => {
  const doc = page.implementation.createDocument(HTML_NS, "html");
  expect(cloneElement(doc.createElement("Foo"), deep).localName).toBe("Foo");
});

it("leaves a null-namespace document's elements in no namespace", () => {
  const doc = asCloneableDocument(page.implementation.createDocument(null, "root")).cloneNode();
  expect(doc.createElement("div").namespaceURI).toBeNull();
});

it("still lowercases names in an HTML document", () => {
  expect(cloneElement(page.createElement("Foo"), false).localName).toBe("foo");
});
