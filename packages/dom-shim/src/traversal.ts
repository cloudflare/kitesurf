// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements TreeWalker and NodeIterator over shim nodes, including removal-point updates.

import type * as Idl from "./idl/types.generated.js";
// Weak references let pre-removal updates reach live iterators without retaining abandoned ones.
const nodeIterators: WeakRef<NodeIterator>[] = [];

const NodeFilter = Object.freeze({
  FILTER_ACCEPT: 1,
  FILTER_REJECT: 2,
  FILTER_SKIP: 3,
  SHOW_ALL: 0xffffffff,
  SHOW_ELEMENT: 0x1,
  SHOW_ATTRIBUTE: 0x2,
  SHOW_TEXT: 0x4,
  SHOW_CDATA_SECTION: 0x8,
  SHOW_ENTITY_REFERENCE: 0x10,
  SHOW_ENTITY: 0x20,
  SHOW_PROCESSING_INSTRUCTION: 0x40,
  SHOW_COMMENT: 0x80,
  SHOW_DOCUMENT: 0x100,
  SHOW_DOCUMENT_TYPE: 0x200,
  SHOW_DOCUMENT_FRAGMENT: 0x400,
  SHOW_NOTATION: 0x800,
});

function traversalFilterThrow(node: Idl.Node | null, whatToShow: number, filter: unknown): number {
  if (!node) return NodeFilter.FILTER_REJECT;
  const nt = node.nodeType;
  if (nt == null) return NodeFilter.FILTER_REJECT;
  const bit = 1 << (nt - 1);
  if ((whatToShow & bit) === 0) return NodeFilter.FILTER_SKIP;
  if (filter == null) return NodeFilter.FILTER_ACCEPT;
  let result: unknown;
  if (typeof filter === "function") {
    result = filter(node);
  } else if (typeof filter === "object") {
    const accept = (filter as { acceptNode?: unknown }).acceptNode;
    if (typeof accept !== "function") {
      throw new TypeError("TreeWalker/NodeIterator filter.acceptNode is not callable");
    }
    result = accept.call(filter, node);
  } else {
    throw new TypeError("TreeWalker/NodeIterator filter is not callable");
  }
  return Number(result) | 0;
}

type StoredFilter = Idl.NodeFilter | null;

function isTraversalBoundary(parent: Idl.Node | null, root: Idl.Node, stopAt: Idl.Node): boolean {
  return parent == null || parent === root || parent === stopAt;
}

function hasSiblingTraversalParent(
  parent: Idl.Node | null | undefined,
  root: Idl.Node,
): parent is Idl.Node {
  return parent != null && parent !== root;
}

function hasPreviousTraversalParent(parent: Idl.Node | null, root: Idl.Node): parent is Idl.Node {
  return parent !== null && parent !== root;
}

class TreeWalker implements Idl.TreeWalker {
  readonly #root: Idl.Node;
  readonly #whatToShow: number;
  readonly #filter: StoredFilter;
  #current: Idl.Node;
  #active = false;
  constructor(root: Idl.Node, whatToShow: number, filter: StoredFilter) {
    this.#root = root;
    this.#whatToShow = whatToShow >>> 0 || 0;
    this.#filter = filter ?? null;
    this.#current = root;
  }
  get root() {
    return this.#root;
  }
  get whatToShow() {
    return this.#whatToShow;
  }
  get filter() {
    return this.#filter;
  }
  #accept(node: Idl.Node): number {
    if (this.#active) {
      throw new DOMException("TreeWalker: filter must not be reentrant", "InvalidStateError");
    }
    this.#active = true;
    try {
      return traversalFilterThrow(node, this.#whatToShow, this.#filter);
    } finally {
      this.#active = false;
    }
  }
  get currentNode() {
    return this.#current;
  }
  set currentNode(node: Idl.Node) {
    if (node == null || typeof node.nodeType !== "number") {
      throw new TypeError("currentNode must be a Node");
    }
    this.#current = node;
  }

  parentNode() {
    let node: Idl.Node | null = this.#current;
    while (node !== null && node !== this.#root) {
      node = node.parentNode;
      if (node == null) return null;
      if (this.#accept(node) === NodeFilter.FILTER_ACCEPT) {
        this.#current = node;
        return node;
      }
    }
    return null;
  }

  firstChild() {
    return this.#traverseChildren("first");
  }
  lastChild() {
    return this.#traverseChildren("last");
  }
  previousSibling() {
    return this.#traverseSiblings("prev");
  }
  nextSibling() {
    return this.#traverseSiblings("next");
  }

  #traverseChildren(dir: "first" | "last"): Idl.Node | null {
    const startCurrent = this.#current;
    let node = this.#childAt(startCurrent, dir);
    while (node != null) {
      const result = this.#accept(node);
      if (result === NodeFilter.FILTER_ACCEPT) {
        this.#current = node;
        return node;
      }
      if (result === NodeFilter.FILTER_SKIP) {
        const child = this.#childAt(node, dir);
        if (child != null) {
          node = child;
          continue;
        }
      }
      node = this.#nextChildTraversalNode(node, startCurrent, dir);
    }
    return null;
  }

  #childAt(node: Idl.Node, dir: "first" | "last"): Idl.Node | null {
    return dir === "first" ? node.firstChild : node.lastChild;
  }

  #nextChildTraversalNode(
    start: Idl.Node,
    stopAt: Idl.Node,
    dir: "first" | "last",
  ): Idl.Node | null {
    let node: Idl.Node | null = start;
    while (node != null) {
      const sibling = dir === "first" ? node.nextSibling : node.previousSibling;
      if (sibling != null) return sibling;
      const parent: Idl.Node | null = node.parentNode;
      if (isTraversalBoundary(parent, this.#root, stopAt)) return null;
      node = parent;
    }
    return null;
  }

  #traverseSiblings(dir: "next" | "prev"): Idl.Node | null {
    let node = this.#current;
    while (node !== this.#root) {
      const sibling = this.#acceptedSibling(node, dir);
      if (sibling) {
        this.#current = sibling;
        return sibling;
      }
      const parent = node.parentNode;
      if (!hasSiblingTraversalParent(parent, this.#root)) return null;
      if (this.#accept(parent) === NodeFilter.FILTER_ACCEPT) return null;
      node = parent;
    }
    return null;
  }

  #acceptedSibling(node: Idl.Node, dir: "next" | "prev"): Idl.Node | null {
    let sibling = dir === "next" ? node.nextSibling : node.previousSibling;
    while (sibling != null) {
      const result = this.#accept(sibling);
      if (result === NodeFilter.FILTER_ACCEPT) return sibling;
      sibling = this.#nextSiblingCandidate(sibling, result, dir);
    }
    return null;
  }

  #nextSiblingCandidate(node: Idl.Node, result: number, dir: "next" | "prev"): Idl.Node | null {
    const child = dir === "next" ? node.firstChild : node.lastChild;
    if (result !== NodeFilter.FILTER_REJECT && child != null) return child;
    return dir === "next" ? node.nextSibling : node.previousSibling;
  }

  nextNode() {
    let node: Idl.Node = this.#current;
    let result: number = NodeFilter.FILTER_ACCEPT;
    while (true) {
      const descent = this.#descendAcceptedNode(node, result);
      if (descent.accepted) return descent.accepted;
      const next = this.#nextSiblingOutsideSubtree(descent.node);
      if (next === null) return null;
      node = next;
      result = this.#accept(node);
      if (result === NodeFilter.FILTER_ACCEPT) {
        this.#current = node;
        return node;
      }
    }
  }

  #descendAcceptedNode(
    start: Idl.Node,
    startResult: number,
  ): { node: Idl.Node; result: number; accepted: Idl.Node | null } {
    let node = start;
    let result = startResult;
    while (result !== NodeFilter.FILTER_REJECT && node.firstChild) {
      node = node.firstChild;
      result = this.#accept(node);
      if (result === NodeFilter.FILTER_ACCEPT) {
        this.#current = node;
        return { node, result, accepted: node };
      }
    }
    return { node, result, accepted: null };
  }

  #nextSiblingOutsideSubtree(start: Idl.Node): Idl.Node | null {
    let node: Idl.Node | null = start;
    while (node !== null) {
      if (node === this.#root) return null;
      if (node.nextSibling) return node.nextSibling;
      node = node.parentNode;
    }
    return null;
  }

  previousNode() {
    let node: Idl.Node = this.#current;
    while (node !== this.#root) {
      const previous = this.#previousAcceptedSibling(node);
      if (previous) {
        this.#current = previous;
        return previous;
      }
      const parent = node.parentNode;
      if (!hasPreviousTraversalParent(parent, this.#root)) return null;
      node = parent;
      if (this.#accept(node) === NodeFilter.FILTER_ACCEPT) {
        this.#current = node;
        return node;
      }
    }
    return null;
  }

  #previousAcceptedSibling(node: Idl.Node): Idl.Node | null {
    let sibling: Idl.Node | null = node.previousSibling;
    while (sibling != null) {
      let candidate = sibling;
      let result = this.#accept(candidate);
      while (result !== NodeFilter.FILTER_REJECT && candidate.lastChild) {
        candidate = candidate.lastChild;
        result = this.#accept(candidate);
      }
      if (result === NodeFilter.FILTER_ACCEPT) return candidate;
      sibling = candidate.previousSibling;
    }
    return null;
  }
}

let preRemoveIterator!: (iterator: NodeIterator, removedNode: Idl.Node) => void;
class NodeIterator implements Idl.NodeIterator {
  readonly #root: Idl.Node;
  readonly #whatToShow: number;
  readonly #filter: StoredFilter;
  #reference: Idl.Node;
  #pointerBefore = true;
  #active = false;
  static {
    preRemoveIterator = (iterator, removedNode) => iterator.#preRemove(removedNode);
  }
  constructor(root: Idl.Node, whatToShow: number, filter: StoredFilter) {
    this.#root = root;
    this.#whatToShow = whatToShow >>> 0 || 0;
    this.#filter = filter ?? null;
    this.#reference = root;
    try {
      nodeIterators.push(new WeakRef(this));
    } catch {}
  }
  get root() {
    return this.#root;
  }
  get whatToShow() {
    return this.#whatToShow;
  }
  get filter() {
    return this.#filter;
  }
  get referenceNode() {
    return this.#reference;
  }
  get pointerBeforeReferenceNode() {
    return this.#pointerBefore;
  }

  detach() {}

  #accept(node: Idl.Node): number {
    if (this.#active) {
      throw new DOMException("NodeIterator: filter must not be reentrant", "InvalidStateError");
    }
    this.#active = true;
    try {
      return traversalFilterThrow(node, this.#whatToShow, this.#filter);
    } finally {
      this.#active = false;
    }
  }

  nextNode() {
    let node = this.#reference;
    let beforeNode = this.#pointerBefore;
    while (true) {
      if (beforeNode) {
        beforeNode = false;
      } else {
        const next = nextInSubtree(node, this.#root);
        if (next === null) return null;
        node = next;
      }
      const filterResult = this.#accept(node);
      if (filterResult === NodeFilter.FILTER_ACCEPT) {
        this.#reference = node;
        this.#pointerBefore = false;
        return node;
      }
    }
  }

  previousNode() {
    let node = this.#reference;
    let beforeNode = this.#pointerBefore;
    while (true) {
      if (!beforeNode) {
        beforeNode = true;
      } else {
        const prev = prevInSubtree(node, this.#root);
        if (prev === null) return null;
        node = prev;
      }
      const filterResult = this.#accept(node);
      if (filterResult === NodeFilter.FILTER_ACCEPT) {
        this.#reference = node;
        this.#pointerBefore = true;
        return node;
      }
    }
  }

  // Reposition before detach while the removed subtree's old neighbors are still available.
  #preRemove(removedNode: Idl.Node): void {
    if (removedNode === this.#root) return;
    if (!isInclusiveAncestor(removedNode, this.#reference)) return;
    if (isInclusiveAncestor(removedNode, this.#root)) return;
    if (!this.#pointerBefore) {
      const p = previousNodeFlat(removedNode);
      if (p) this.#reference = p;
      return;
    }
    const next = nextNodeAfterDescendants(removedNode);
    if (next) {
      this.#reference = next;
      return;
    }
    const p = previousNodeFlat(removedNode);
    if (p) {
      this.#reference = p;
      this.#pointerBefore = false;
    }
  }
}

function nextInSubtree(node: Idl.Node, root: Idl.Node): Idl.Node | null {
  if (node.firstChild) return node.firstChild;
  let n: Idl.Node | null = node;
  while (n) {
    if (n === root) return null;
    if (n.nextSibling) return n.nextSibling;
    n = n.parentNode;
  }
  return null;
}
function prevInSubtree(node: Idl.Node, root: Idl.Node): Idl.Node | null {
  if (node === root) return null;
  if (node.previousSibling) {
    let n = node.previousSibling;
    while (n.lastChild) n = n.lastChild;
    return n;
  }
  return node.parentNode || null;
}

function isInclusiveAncestor(node: Idl.Node, candidate: Idl.Node | null): boolean {
  let n: Idl.Node | null = candidate;
  while (n) {
    if (n === node) return true;
    n = n.parentNode;
  }
  return false;
}
function previousNodeFlat(node: Idl.Node | null): Idl.Node | null {
  if (!node) return null;
  if (node.previousSibling) {
    let n = node.previousSibling;
    while (n.lastChild) n = n.lastChild;
    return n;
  }
  return node.parentNode || null;
}
function nextNodeAfterDescendants(node: Idl.Node): Idl.Node | null {
  let n: Idl.Node | null = node;
  while (n) {
    if (n.nextSibling) return n.nextSibling;
    n = n.parentNode;
  }
  return null;
}
function runIteratorPreRemove(removedNode: Idl.Node | null): void {
  if (!removedNode) return;
  // Sweep + filter the registry, dropping dead WeakRefs as we go.
  const live: WeakRef<NodeIterator>[] = [];
  for (const ref of nodeIterators) {
    const iter = ref.deref();
    if (!iter) continue;
    live.push(ref);
    preRemoveIterator(iter, removedNode);
  }
  nodeIterators.length = 0;
  for (const ref of live) nodeIterators.push(ref);
}

export {
  NodeFilter,
  TreeWalker,
  NodeIterator,
  traversalFilterThrow,
  runIteratorPreRemove,
  nextInSubtree,
  prevInSubtree,
  isInclusiveAncestor,
  previousNodeFlat,
  nextNodeAfterDescendants,
};
