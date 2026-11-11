// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements Range, StaticRange, and Selection and updates boundary points after DOM mutations.

import type * as Idl from "./idl/types.generated.js";
import {
  documentImpl as document,
  liveDocument,
  dom,
  createDocumentFragmentInternal,
  parseFragmentInContext,
  isCharacterDataNode,
  isDocumentNode,
  isShadowRootNode,
  isTextNode,
  isElementNode,
} from "./state.js";
import { KsEvent } from "./events/event.js";
import { dispatchTrustedEvent } from "./events/dispatch.js";
import { bumpMutationSeq } from "./mutations/seq.js";
import { getInternalState } from "./internal-state.js";
import { markRuntimeCreatedScript } from "./mutations/observer.js";
import { hasParsedHandle, nodeListGetters, nodeOwnerDoc } from "./registries.js";
import { makeDomRect, makeDomRectList } from "./element/rect.js";
import { cloneWrapper, type NodeBase } from "./node-base.js";
import {
  ATTRIBUTE_NODE,
  CDATA_SECTION_NODE,
  COMMENT_NODE,
  DOCUMENT_NODE,
  DOCUMENT_FRAGMENT_NODE,
  DOCTYPE_NODE,
  ELEMENT_NODE,
  HTML_NS,
  TEXT_NODE,
} from "./constants.js";
import type { DetachedDocument } from "./document.js";
import type { ParsedDocument } from "./parser.js";
import type { DocumentFragmentImpl, ShadowRootImpl } from "./collections.js";
import type { Element } from "./element/element.js";
type LiveRangeEntry = RangeBounds<BoundaryNode | null> & { composedSel?: boolean };

const MAX_COMPOSED_ANCESTOR_HOPS = 4096;
const MAX_SELECTION_ANCESTOR_HOPS = 1024;

// Weak references let mutation hooks adjust live endpoints without retaining unused ranges.
const liveRangeRefs = new Set<WeakRef<LiveRangeEntry>>();
const rangeFinalizer =
  typeof FinalizationRegistry !== "undefined"
    ? new FinalizationRegistry((ref: WeakRef<LiveRangeEntry>) => {
        liveRangeRefs.delete(ref);
      })
    : null;
const liveRanges = {
  get size() {
    return liveRangeRefs.size;
  },
  add(range: LiveRangeEntry): void {
    const ref = new WeakRef(range);
    liveRangeRefs.add(ref);
    if (rangeFinalizer) rangeFinalizer.register(range, ref);
  },
  *[Symbol.iterator](): IterableIterator<LiveRangeEntry> {
    for (const ref of liveRangeRefs) {
      const range = ref.deref();
      if (!range) {
        liveRangeRefs.delete(ref);
        continue;
      }
      yield range;
    }
  },
};

function nodeLength(node: BoundaryNode | null | undefined): number {
  if (!node) return 0;
  const t = node.nodeType;
  if (isCharacterDataNode(node)) {
    const d = node.data;
    return typeof d === "string" ? d.length : 0;
  }
  if (t === DOCTYPE_NODE) return 0;
  const kids = node.childNodes;
  return kids ? kids.length : 0;
}

function nodeIndexOf(node: BoundaryNode | null | undefined): number {
  const parent = node?.parentNode;
  return parent ? Array.prototype.indexOf.call(childArray(parent), node) : -1;
}

function childArray(node: NodeBase | DetachedDocument): ArrayLike<NodeBase> {
  const kids = node.childNodes;
  const get = nodeListGetters.get(kids);
  return get ? get() : kids;
}

function rootOf(node: BoundaryNode | null | undefined): BoundaryNode | null | undefined {
  let cur: BoundaryNode | null | undefined = node;
  while (cur && cur.parentNode) cur = cur.parentNode;
  return cur;
}

function isInclusiveDescendant(
  ancestor: BoundaryNode | null | undefined,
  node: BoundaryNode | null | undefined,
): boolean {
  // A DetachedDocument has no _id.
  const ancestorId = ancestor && "_id" in ancestor ? ancestor._id : undefined;
  const nodeId = node && "_id" in node ? node._id : undefined;
  if (
    ancestor !== node &&
    typeof ancestorId === "number" &&
    typeof nodeId === "number" &&
    ancestorId >= 0 &&
    nodeId >= 0
  ) {
    try {
      return dom.isInclusiveAncestor(ancestorId, nodeId) === true;
    } catch {}
  }
  let cur = node;
  while (cur) {
    if (cur === ancestor) return true;
    cur = cur.parentNode;
  }
  return false;
}

function compareBoundary(aN: BoundaryNode, aO: number, bN: BoundaryNode, bO: number): number {
  if (aN === bN) {
    if (aO < bO) return -1;
    if (aO > bO) return 1;
    return 0;
  }
  if (rootOf(aN) !== rootOf(bN)) return NaN;
  if (isInclusiveDescendant(bN, aN) && aN !== bN) {
    let cur = aN;
    while (cur.parentNode && cur.parentNode !== bN) cur = cur.parentNode;
    const idx = nodeIndexOf(cur);
    return idx < bO ? -1 : 1;
  }
  if (isInclusiveDescendant(aN, bN) && aN !== bN) {
    let cur = bN;
    while (cur.parentNode && cur.parentNode !== aN) cur = cur.parentNode;
    const idx = nodeIndexOf(cur);
    return idx < aO ? 1 : -1;
  }
  const aAncestors: BoundaryNode[] = [];
  let cur: BoundaryNode | null = aN;
  while (cur) {
    aAncestors.push(cur);
    cur = cur.parentNode;
  }
  let bCur: BoundaryNode | null = bN;
  while (bCur) {
    const i = aAncestors.indexOf(bCur);
    if (i >= 0) {
      const aChild = i === 0 ? null : aAncestors[i - 1];
      let bChild = bN;
      while (bChild.parentNode && bChild.parentNode !== bCur) bChild = bChild.parentNode;
      const aIdx = aChild ? nodeIndexOf(aChild) : -1;
      const bIdx = nodeIndexOf(bChild);
      if (aIdx === bIdx) return 0;
      return aIdx < bIdx ? -1 : 1;
    }
    bCur = bCur.parentNode;
  }
  return NaN;
}

function rangeAssertNotDoctype(node: BoundaryNode | null | undefined, opName: string): void {
  if (node && node.nodeType === DOCTYPE_NODE) {
    throw new DOMException(
      opName + ": doctype is not a valid boundary point node",
      "InvalidNodeTypeError",
    );
  }
}

function rangeAssertOffsetInBounds(node: BoundaryNode, offset: number, opName: string): void {
  const u = offset >>> 0;
  const len = nodeLength(node);
  if (u > len) {
    throw new DOMException(
      opName + ": offset " + u + " exceeds node length " + len,
      "IndexSizeError",
    );
  }
}

function nodeIsContainedBy(node: BoundaryNode, range: object): boolean {
  const parent = node.parentNode;
  if (!parent) return false;
  const idx = nodeIndexOf(node);
  const startVsBefore = compareBoundary(
    rangeBounds(range).startContainer,
    rangeBounds(range).startOffset,
    parent,
    idx,
  );
  const endVsAfter = compareBoundary(
    rangeBounds(range).endContainer,
    rangeBounds(range).endOffset,
    parent,
    idx + 1,
  );
  return startVsBefore <= 0 && endVsAfter >= 0;
}
function nodeIsPartiallyContained(node: BoundaryNode, range: object) {
  const startInSubtree = isInclusiveDescendant(node, rangeBounds(range).startContainer);
  const endInSubtree = isInclusiveDescendant(node, rangeBounds(range).endContainer);
  return startInSubtree !== endInSubtree;
}
function isInclusiveAncestorOf(
  ancestor: BoundaryNode | null | undefined,
  other: BoundaryNode | null | undefined,
): boolean {
  return isInclusiveDescendant(ancestor, other);
}

function makeDOMException(name: string, msg: string): Error {
  try {
    return new DOMException(msg, name);
  } catch {
    return Object.assign(new Error(msg), { name });
  }
}

function rangePartiallyContainedNonTextNodes(range: object) {
  function isText(t: number) {
    return t === TEXT_NODE || t === CDATA_SECTION_NODE;
  }
  function walk(node: BoundaryNode): boolean {
    if (
      node !== rangeBounds(range).startContainer &&
      node !== rangeBounds(range).endContainer &&
      nodeIsPartiallyContained(node, range) &&
      !isText(node.nodeType)
    ) {
      return true;
    }
    const kids = node.childNodes;
    if (kids) {
      for (let i = 0; i < kids.length; i++) {
        if (walk(kids[i])) return true;
      }
    }
    return false;
  }
  let common: BoundaryNode | null = rangeBounds(range).startContainer;
  while (common && !isInclusiveDescendant(common, rangeBounds(range).endContainer)) {
    common = common.parentNode;
  }
  if (!common) return false;
  return walk(common);
}

function rangeCommonAncestor(range: object) {
  let n: BoundaryNode | null = rangeBounds(range).startContainer;
  while (n && !isInclusiveDescendant(n, rangeBounds(range).endContainer)) {
    n = n.parentNode;
  }
  return n;
}

function makeTransientRange(
  sN: BoundaryNode,
  sO: number,
  eN: BoundaryNode,
  eO: number,
): AbstractRangeImpl {
  return new AbstractRangeImpl(ABSTRACT_RANGE_TOKEN, sN, sO, eN, eO);
}

function rangeCloneOrExtract(
  range: AbstractRangeImpl,
  mode: "clone" | "extract",
): DocumentFragmentImpl {
  const frag = liveDocument().createDocumentFragment();
  if (range.collapsed) return frag;

  const origStartN = rangeBounds(range).startContainer;
  const origStartO = rangeBounds(range).startOffset;
  const origEndN = rangeBounds(range).endContainer;
  const origEndO = rangeBounds(range).endOffset;
  const isCharData = isCharacterDataNode;

  if (origStartN === origEndN && isCharacterDataNode(origStartN)) {
    const clone = cloneWrapper(origStartN, false);
    try {
      clone.data = origStartN.substringData(origStartO, origEndO - origStartO);
    } catch {
      const d = origStartN.data || "";
      clone.data = d.slice(origStartO, origEndO);
    }
    frag.appendChild(clone);
    if (mode === "extract") {
      if (typeof origStartN.replaceData === "function") {
        origStartN.replaceData(origStartO, origEndO - origStartO, "");
      } else {
        const d = origStartN.data || "";
        origStartN.data = d.slice(0, origStartO) + d.slice(origEndO);
      }
      rangeBounds(range).endContainer = origStartN;
      rangeBounds(range).endOffset = origStartO;
    }
    return frag;
  }

  const commonAncestor = rangeCommonAncestor(range);
  // Both boundary points share a root, so this only fails on a corrupt range.
  if (!commonAncestor) throw new TypeError("Range has no common ancestor");

  let firstPartiallyContainedChild: NodeBase | null = null;
  if (!isInclusiveAncestorOf(origStartN, origEndN)) {
    const kids = commonAncestor.childNodes;
    for (let i = 0; i < kids.length; i++) {
      if (nodeIsPartiallyContained(kids[i], range)) {
        firstPartiallyContainedChild = kids[i];
        break;
      }
    }
  }
  let lastPartiallyContainedChild: NodeBase | null = null;
  if (!isInclusiveAncestorOf(origEndN, origStartN)) {
    const kids = commonAncestor.childNodes;
    for (let i = kids.length - 1; i >= 0; i--) {
      if (nodeIsPartiallyContained(kids[i], range)) {
        lastPartiallyContainedChild = kids[i];
        break;
      }
    }
  }

  const containedChildren: NodeBase[] = [];
  {
    const kids = commonAncestor.childNodes;
    for (let i = 0; i < kids.length; i++) {
      if (nodeIsContainedBy(kids[i], range)) containedChildren.push(kids[i]);
    }
  }
  for (const c of containedChildren) {
    if (c.nodeType === DOCTYPE_NODE) {
      throw makeDOMException(
        "HierarchyRequestError",
        "Range." +
          (mode === "clone" ? "cloneContents" : "extractContents") +
          ": cannot include a DocumentType",
      );
    }
  }

  let newNode = origStartN;
  let newOffset = origStartO;
  if (!isInclusiveAncestorOf(origStartN, origEndN)) {
    let reference = origStartN;
    while (reference.parentNode && !isInclusiveAncestorOf(reference.parentNode, origEndN)) {
      reference = reference.parentNode;
    }
    if (reference.parentNode) {
      newNode = reference.parentNode;
      newOffset = nodeIndexOf(reference) + 1;
    }
  }

  // A character-data first partially contained child is origStartN.
  if (isCharData(firstPartiallyContainedChild) && isCharacterDataNode(origStartN)) {
    const clone = cloneWrapper(origStartN, false);
    const len = nodeLength(origStartN);
    try {
      clone.data = origStartN.substringData(origStartO, len - origStartO);
    } catch {
      const d = origStartN.data || "";
      clone.data = d.slice(origStartO, len);
    }
    frag.appendChild(clone);
    if (mode === "extract") {
      if (typeof origStartN.replaceData === "function") {
        origStartN.replaceData(origStartO, len - origStartO, "");
      } else {
        const d = origStartN.data || "";
        origStartN.data = d.slice(0, origStartO);
      }
    }
  } else if (firstPartiallyContainedChild) {
    const clone = cloneWrapper(firstPartiallyContainedChild, false);
    frag.appendChild(clone);
    const subrange = makeTransientRange(
      origStartN,
      origStartO,
      firstPartiallyContainedChild,
      nodeLength(firstPartiallyContainedChild),
    );
    const subFrag = rangeCloneOrExtract(subrange, mode);
    clone.appendChild(subFrag);
  }

  for (const c of containedChildren) {
    if (mode === "clone") {
      frag.appendChild(cloneWrapper(c, true));
    } else {
      frag.appendChild(c);
    }
  }

  // A character-data last partially contained child is origEndN.
  if (isCharData(lastPartiallyContainedChild) && isCharacterDataNode(origEndN)) {
    const clone = cloneWrapper(origEndN, false);
    try {
      clone.data = origEndN.substringData(0, origEndO);
    } catch {
      const d = origEndN.data || "";
      clone.data = d.slice(0, origEndO);
    }
    frag.appendChild(clone);
    if (mode === "extract") {
      if (typeof origEndN.replaceData === "function") {
        origEndN.replaceData(0, origEndO, "");
      } else {
        const d = origEndN.data || "";
        origEndN.data = d.slice(origEndO);
      }
    }
  } else if (lastPartiallyContainedChild) {
    const clone = cloneWrapper(lastPartiallyContainedChild, false);
    frag.appendChild(clone);
    const subrange = makeTransientRange(lastPartiallyContainedChild, 0, origEndN, origEndO);
    const subFrag = rangeCloneOrExtract(subrange, mode);
    clone.appendChild(subFrag);
  }

  if (mode === "extract") {
    rangeBounds(range).startContainer = newNode;
    rangeBounds(range).startOffset = newOffset;
    rangeBounds(range).endContainer = newNode;
    rangeBounds(range).endOffset = newOffset;
  }
  return frag;
}

function rangeExtractOrDelete(range: AbstractRangeImpl): void {
  if (range.collapsed) return;
  rangeCloneOrExtract(range, "extract");
}

// A DetachedDocument (createDocument, DOMParser-free XML documents) can hold
// a boundary point too.
type BoundaryNode = NodeBase | DetachedDocument;
interface RangeBounds<N = BoundaryNode> {
  startContainer: N;
  startOffset: number;
  endContainer: N;
  endOffset: number;
}
let boundsOf!: (range: object) => RangeBounds | undefined;
function rangeBounds(range: object): RangeBounds {
  const bounds = boundsOf(range);
  if (!bounds) throw new TypeError("Illegal invocation");
  return bounds;
}

const ABSTRACT_RANGE_TOKEN = Symbol("kitesurfAbstractRange");

class AbstractRangeImpl implements Idl.AbstractRange {
  readonly #bounds: RangeBounds;
  static {
    boundsOf = (range) => (#bounds in range ? range.#bounds : undefined);
  }
  constructor(
    token: symbol,
    startContainer: BoundaryNode,
    startOffset: number,
    endContainer: BoundaryNode,
    endOffset: number,
  ) {
    if (token !== ABSTRACT_RANGE_TOKEN) throw new TypeError("Illegal constructor");
    this.#bounds = { startContainer, startOffset, endContainer, endOffset };
  }
  get startContainer() {
    return this.#bounds.startContainer;
  }
  get startOffset() {
    return this.#bounds.startOffset;
  }
  get endContainer() {
    return this.#bounds.endContainer;
  }
  get endOffset() {
    return this.#bounds.endOffset;
  }
  get collapsed() {
    const b = this.#bounds;
    return b.startContainer === b.endContainer && b.startOffset === b.endOffset;
  }
}

class RangeImpl extends AbstractRangeImpl implements Idl.Range {
  static START_TO_START = 0;
  static START_TO_END = 1;
  static END_TO_END = 2;
  static END_TO_START = 3;

  // createRange passes its document. A DOMParser ParsedDocument is not a
  // BoundaryNode: the Range code reads it only through the node members it
  // shares (nodeType, childNodes, parentNode), as it always has.
  constructor(ownerDoc?: BoundaryNode | ParsedDocument | null) {
    const def = (ownerDoc != null ? ownerDoc : liveDocument()) as BoundaryNode;
    super(ABSTRACT_RANGE_TOKEN, def, 0, def, 0);
    liveRanges.add(rangeBounds(this));
  }

  get commonAncestorContainer() {
    let cur: BoundaryNode | null = rangeBounds(this).startContainer;
    while (cur && !isInclusiveDescendant(cur, rangeBounds(this).endContainer)) {
      cur = cur.parentNode;
    }
    return cur || rangeBounds(this).startContainer;
  }

  _setStartInternal(node: BoundaryNode, offset: number): void {
    rangeAssertNotDoctype(node, "setStart");
    rangeAssertOffsetInBounds(node, offset, "setStart");
    // Ranges cannot span roots; setting an endpoint in another root collapses the other endpoint.
    const sameRoot = rootOf(node) === rootOf(rangeBounds(this).endContainer);
    const order = sameRoot
      ? compareBoundary(node, offset, rangeBounds(this).endContainer, rangeBounds(this).endOffset)
      : NaN;
    rangeBounds(this).startContainer = node;
    rangeBounds(this).startOffset = offset >>> 0;
    if (!sameRoot || order > 0) {
      rangeBounds(this).endContainer = node;
      rangeBounds(this).endOffset = offset >>> 0;
    }
    selNotifyRangeMutated(this, "start");
  }
  _setEndInternal(node: BoundaryNode, offset: number): void {
    rangeAssertNotDoctype(node, "setEnd");
    rangeAssertOffsetInBounds(node, offset, "setEnd");
    const sameRoot = rootOf(node) === rootOf(rangeBounds(this).startContainer);
    const order = sameRoot
      ? compareBoundary(
          rangeBounds(this).startContainer,
          rangeBounds(this).startOffset,
          node,
          offset,
        )
      : NaN;
    rangeBounds(this).endContainer = node;
    rangeBounds(this).endOffset = offset >>> 0;
    if (!sameRoot || order > 0) {
      rangeBounds(this).startContainer = node;
      rangeBounds(this).startOffset = offset >>> 0;
    }
    selNotifyRangeMutated(this, "end");
  }

  setStart(node: BoundaryNode, offset: number) {
    this._setStartInternal(node, offset >>> 0);
  }
  setEnd(node: BoundaryNode, offset: number) {
    this._setEndInternal(node, offset >>> 0);
  }
  setStartBefore(node: BoundaryNode) {
    const parent = node && node.parentNode;
    if (!parent) {
      throw new DOMException("setStartBefore: node has no parent", "InvalidNodeTypeError");
    }
    this._setStartInternal(parent, nodeIndexOf(node));
  }
  setStartAfter(node: BoundaryNode) {
    const parent = node && node.parentNode;
    if (!parent) {
      throw new DOMException("setStartAfter: node has no parent", "InvalidNodeTypeError");
    }
    this._setStartInternal(parent, nodeIndexOf(node) + 1);
  }
  setEndBefore(node: BoundaryNode) {
    const parent = node && node.parentNode;
    if (!parent) {
      throw new DOMException("setEndBefore: node has no parent", "InvalidNodeTypeError");
    }
    this._setEndInternal(parent, nodeIndexOf(node));
  }
  setEndAfter(node: BoundaryNode) {
    const parent = node && node.parentNode;
    if (!parent) {
      throw new DOMException("setEndAfter: node has no parent", "InvalidNodeTypeError");
    }
    this._setEndInternal(parent, nodeIndexOf(node) + 1);
  }
  collapse(toStart?: boolean) {
    if (toStart) {
      rangeBounds(this).endContainer = rangeBounds(this).startContainer;
      rangeBounds(this).endOffset = rangeBounds(this).startOffset;
    } else {
      rangeBounds(this).startContainer = rangeBounds(this).endContainer;
      rangeBounds(this).startOffset = rangeBounds(this).endOffset;
    }
    selNotifyRangeMutated(this);
  }
  selectNode(node: BoundaryNode) {
    const parent = node && node.parentNode;
    if (!parent) {
      throw new DOMException("selectNode: node has no parent", "InvalidNodeTypeError");
    }
    rangeAssertNotDoctype(parent, "selectNode");
    const idx = nodeIndexOf(node);
    rangeBounds(this).startContainer = parent;
    rangeBounds(this).startOffset = idx;
    rangeBounds(this).endContainer = parent;
    rangeBounds(this).endOffset = idx + 1;
    selNotifyRangeMutated(this);
  }
  selectNodeContents(node: BoundaryNode) {
    rangeAssertNotDoctype(node, "selectNodeContents");
    rangeBounds(this).startContainer = node;
    rangeBounds(this).startOffset = 0;
    rangeBounds(this).endContainer = node;
    rangeBounds(this).endOffset = nodeLength(node);
    selNotifyRangeMutated(this);
  }
  cloneRange() {
    const clone = new RangeImpl();
    rangeBounds(clone).startContainer = rangeBounds(this).startContainer;
    rangeBounds(clone).startOffset = rangeBounds(this).startOffset;
    rangeBounds(clone).endContainer = rangeBounds(this).endContainer;
    rangeBounds(clone).endOffset = rangeBounds(this).endOffset;
    return clone;
  }
  createContextualFragment(markup: Idl.TrustedHTML | string): Idl.DocumentFragment {
    const node = rangeBounds(this).startContainer;
    const doc = isDocumentNode(node) ? node : node.ownerDocument;
    // Only a document has no owner document, and that took the first arm.
    if (!doc) throw new TypeError("createContextualFragment: start container has no document");
    let element = isElementNode(node)
      ? node
      : node.nodeType === TEXT_NODE || node.nodeType === COMMENT_NODE
        ? node.parentElement
        : null;
    if (!element || (element.localName === "html" && element.namespaceURI === HTML_NS)) {
      element = null;
    }
    const ns = element ? element.namespaceURI : HTML_NS;
    const localName = element ? element.localName : "body";
    const html = String(markup);
    if (hasParsedHandle(doc)) {
      // A DOMParser document owns the private parsed handle; a DetachedDocument
      // takes the live route below and keeps its own backing.
      const detached = doc as DetachedDocument;
      const context = detached.createElementNS(ns, localName);
      context.innerHTML = html;
      const fragment = detached.createDocumentFragment();
      while (context.firstChild) fragment.appendChild(context.firstChild);
      return fragment;
    }
    const fragment = createDocumentFragmentInternal();
    if (doc !== document) nodeOwnerDoc.set(fragment, doc);
    parseFragmentInContext(fragment, ns, localName, html);
    for (const id of dom.querySelectorAllInSubtree(fragment._id, "script")) {
      markRuntimeCreatedScript(id);
    }
    return fragment;
  }
  detach() {}
  getClientRects() {
    const rect = this._approxRangeRect();
    return makeDomRectList(rect ? [rect] : []);
  }
  getBoundingClientRect() {
    const rect = this._approxRangeRect();
    return rect || makeDomRect(0, 0, 0, 0);
  }
  _approxRangeRect(): Idl.DOMRect | null {
    let node: BoundaryNode | null = rangeBounds(this).startContainer;
    if (node && node.nodeType === TEXT_NODE) {
      node = node.parentNode;
    }
    if (
      !node ||
      !("getBoundingClientRect" in node) ||
      typeof node.getBoundingClientRect !== "function"
    ) {
      return null;
    }
    try {
      return node.getBoundingClientRect();
    } catch {
      return null;
    }
  }

  compareBoundaryPoints(how: number, other: Idl.Range) {
    how = (how >>> 0) & 0xffff;
    if (!other || !(other instanceof RangeImpl)) {
      throw new TypeError("compareBoundaryPoints: source range is not a Range");
    }
    if (how !== 0 && how !== 1 && how !== 2 && how !== 3) {
      throw new DOMException("compareBoundaryPoints: invalid how " + how, "NotSupportedError");
    }
    if (rootOf(rangeBounds(this).startContainer) !== rootOf(rangeBounds(other).startContainer)) {
      throw new DOMException(
        "compareBoundaryPoints: ranges in different documents",
        "WrongDocumentError",
      );
    }
    let aN: BoundaryNode, aO: number, bN: BoundaryNode, bO: number;
    switch (how) {
      case 0:
        aN = rangeBounds(this).startContainer;
        aO = rangeBounds(this).startOffset;
        bN = rangeBounds(other).startContainer;
        bO = rangeBounds(other).startOffset;
        break;
      case 1:
        aN = rangeBounds(this).endContainer;
        aO = rangeBounds(this).endOffset;
        bN = rangeBounds(other).startContainer;
        bO = rangeBounds(other).startOffset;
        break;
      case 2:
        aN = rangeBounds(this).endContainer;
        aO = rangeBounds(this).endOffset;
        bN = rangeBounds(other).endContainer;
        bO = rangeBounds(other).endOffset;
        break;
      case 3:
        aN = rangeBounds(this).startContainer;
        aO = rangeBounds(this).startOffset;
        bN = rangeBounds(other).endContainer;
        bO = rangeBounds(other).endOffset;
        break;
    }
    return compareBoundary(aN, aO, bN, bO);
  }

  comparePoint(node: BoundaryNode, offset: number) {
    if (!node || typeof node !== "object" || typeof node.nodeType !== "number") {
      throw new TypeError("comparePoint: argument must be a Node");
    }
    if (rootOf(node) !== rootOf(rangeBounds(this).startContainer)) {
      throw new DOMException("comparePoint: node is in a different tree", "WrongDocumentError");
    }
    rangeAssertNotDoctype(node, "comparePoint");
    rangeAssertOffsetInBounds(node, offset, "comparePoint");
    if (
      compareBoundary(
        node,
        offset,
        rangeBounds(this).startContainer,
        rangeBounds(this).startOffset,
      ) < 0
    )
      return -1;
    if (
      compareBoundary(node, offset, rangeBounds(this).endContainer, rangeBounds(this).endOffset) > 0
    )
      return 1;
    return 0;
  }
  isPointInRange(node: BoundaryNode, offset: number) {
    if (!node || typeof node !== "object" || typeof node.nodeType !== "number") {
      throw new TypeError("isPointInRange: argument must be a Node");
    }
    if (rootOf(node) !== rootOf(rangeBounds(this).startContainer)) return false;
    rangeAssertNotDoctype(node, "isPointInRange");
    const u = offset >>> 0;
    if (u > nodeLength(node)) {
      throw new DOMException(
        "isPointInRange: offset " + u + " exceeds node length",
        "IndexSizeError",
      );
    }
    const a = compareBoundary(
      node,
      u,
      rangeBounds(this).startContainer,
      rangeBounds(this).startOffset,
    );
    const b = compareBoundary(node, u, rangeBounds(this).endContainer, rangeBounds(this).endOffset);
    return a >= 0 && b <= 0;
  }
  intersectsNode(node: BoundaryNode) {
    if (
      node === undefined ||
      node === null ||
      typeof node !== "object" ||
      typeof node.nodeType !== "number"
    ) {
      throw new TypeError("intersectsNode: argument must be a Node");
    }
    if (rootOf(node) !== rootOf(rangeBounds(this).startContainer)) return false;
    const parent = node.parentNode;
    if (!parent) {
      return true;
    }
    const offsetBefore = nodeIndexOf(node);
    const aStart = compareBoundary(
      parent,
      offsetBefore,
      rangeBounds(this).endContainer,
      rangeBounds(this).endOffset,
    );
    const bEnd = compareBoundary(
      parent,
      offsetBefore + 1,
      rangeBounds(this).startContainer,
      rangeBounds(this).startOffset,
    );
    return aStart < 0 && bEnd > 0;
  }

  toString() {
    const sN = rangeBounds(this).startContainer;
    const sO = rangeBounds(this).startOffset;
    const eN = rangeBounds(this).endContainer;
    const eO = rangeBounds(this).endOffset;
    if (sN === eN && isTextNode(sN)) {
      const d = sN.data || "";
      return d.slice(sO, eO);
    }
    let out = "";
    const isText = isTextNode;
    if (isText(sN)) out += (sN.data || "").slice(sO);
    const ca = this.commonAncestorContainer;
    function* dfs(root: BoundaryNode): Generator<BoundaryNode> {
      yield root;
      const kids = root.childNodes;
      if (kids) for (let i = 0; i < kids.length; i++) yield* dfs(kids[i]);
    }
    let startAnchor: BoundaryNode | null;
    if (isText(sN)) {
      startAnchor = sN;
    } else {
      const kids = sN.childNodes;
      startAnchor = sO < kids.length ? kids[sO] : null;
    }
    let endAnchor: BoundaryNode | null;
    if (isText(eN)) {
      endAnchor = eN;
    } else {
      const kids = eN.childNodes;
      endAnchor = eO < kids.length ? kids[eO] : null;
    }
    let collecting = false;
    for (const n of dfs(ca)) {
      if (n === startAnchor) collecting = true;
      if (n === sN && isText(sN)) {
        continue;
      }
      if (n === eN && isText(eN)) {
        out += (eN.data || "").slice(0, eO);
        collecting = false;
        break;
      }
      if (n === endAnchor) break;
      if (collecting && isText(n)) {
        out += n.data || "";
      }
    }
    return out;
  }

  deleteContents() {
    rangeExtractOrDelete(this);
  }
  cloneContents() {
    return rangeCloneOrExtract(this, "clone");
  }
  extractContents() {
    return rangeCloneOrExtract(this, "extract");
  }
  insertNode(node: NodeBase) {
    if (!node || typeof node !== "object" || typeof node.nodeType !== "number") {
      throw new TypeError("insertNode: argument is not a Node");
    }
    const sN = rangeBounds(this).startContainer;
    const sO = rangeBounds(this).startOffset;
    const startType = sN.nodeType;
    if (startType === 7 || startType === 8) {
      throw makeDOMException(
        "HierarchyRequestError",
        "insertNode: start container is a ProcessingInstruction/Comment",
      );
    }
    let referenceChild: NodeBase | null = null;
    let parent: NodeBase | DetachedDocument;
    if (isTextNode(sN)) {
      const textParent = sN.parentNode;
      if (!textParent) {
        throw makeDOMException(
          "HierarchyRequestError",
          "insertNode: start container is a parentless Text",
        );
      }
      parent = textParent;
      // A DOMParser text node (nodeType 3, no splitText) can be the
      // boundary too; it inserts before the next sibling instead.
      referenceChild = typeof sN.splitText === "function" ? sN.splitText(sO) : sN.nextSibling;
    } else {
      parent = sN;
      const kids = sN.childNodes;
      referenceChild = sO < kids.length ? kids[sO] : null;
    }
    if (referenceChild === node) {
      referenceChild = node.nextSibling;
    }
    if (node.parentNode) {
      try {
        node.parentNode.removeChild(node);
      } catch {}
    }
    parent.insertBefore(node, referenceChild);
    if (this.collapsed) {
      const idx = nodeIndexOf(node);
      rangeBounds(this).endContainer = parent;
      rangeBounds(this).endOffset = idx + 1;
    }
  }
  surroundContents(newParent: NodeBase) {
    if (!newParent) throw new TypeError("surroundContents: argument is not a Node");
    const range = this;
    const partial = rangePartiallyContainedNonTextNodes(range);
    if (partial) {
      throw makeDOMException(
        "InvalidStateError",
        "surroundContents: range partially selects a non-Text node",
      );
    }
    const nt = newParent.nodeType;
    if (nt === DOCUMENT_NODE || nt === DOCTYPE_NODE || nt === DOCUMENT_FRAGMENT_NODE) {
      throw makeDOMException(
        "HierarchyRequestError",
        "surroundContents: newParent must not be Document/DocumentType/DocumentFragment",
      );
    }
    const contents = this.extractContents();
    while (newParent.firstChild) newParent.removeChild(newParent.firstChild);
    this.insertNode(newParent);
    newParent.appendChild(contents);
    this.selectNode(newParent);
  }

  get [Symbol.toStringTag](): string {
    return "Range";
  }
}

function selAssertNode(v: Idl.Node, opName: string): asserts v is BoundaryNode {
  // Duck-typed like the Range guards: anything with a numeric nodeType.
  if (!v || typeof v !== "object" || typeof Reflect.get(v, "nodeType") !== "number") {
    throw new TypeError(
      "Failed to execute '" + opName + "' on 'Selection': parameter is not of type 'Node'.",
    );
  }
}

let notifyRangeMutated!: (
  selection: SelectionImpl,
  range: Idl.Range,
  changedEndpoint?: string,
) => void;
function selNotifyRangeMutated(range: Idl.Range, changedEndpoint?: string) {
  if (selectionImpl) notifyRangeMutated(selectionImpl, range, changedEndpoint);
}

function composedSteps(node: BoundaryNode): { root: BoundaryNode; steps: number[] } {
  const steps: number[] = [];
  let cur: BoundaryNode = node;
  let hops = 0;
  while (cur && hops++ < MAX_COMPOSED_ANCESTOR_HOPS) {
    const p = cur.parentNode;
    if (p) {
      steps.push(nodeIndexOf(cur));
      cur = p;
      continue;
    }
    if (isHostedShadowRoot(cur)) {
      steps.push(-1);
      cur = cur.host;
      continue;
    }
    break;
  }
  steps.reverse();
  return { root: cur, steps };
}

function compareComposed(
  aN: BoundaryNode | null,
  aO: number,
  bN: BoundaryNode | null,
  bO: number,
): number {
  if (aN === bN) return aO < bO ? -1 : aO > bO ? 1 : 0;
  if (!aN || !bN) return NaN;
  const A = composedSteps(aN);
  const B = composedSteps(bN);
  if (A.root !== B.root) return NaN;
  const n = Math.min(A.steps.length, B.steps.length);
  for (let i = 0; i < n; i++) {
    if (A.steps[i] !== B.steps[i]) return A.steps[i] < B.steps[i] ? -1 : 1;
  }
  if (A.steps.length === B.steps.length) return 0;
  if (A.steps.length < B.steps.length) return aO <= B.steps[n] ? -1 : 1;
  return bO <= A.steps[n] ? 1 : -1;
}

// A shadow root whose host is still there.
function isHostedShadowRoot(
  v: BoundaryNode | null | undefined,
): v is ShadowRootImpl & { host: Element } {
  return isShadowRootNode(v) && !!v.host;
}

function composedRootOf(node: BoundaryNode | null): BoundaryNode | null {
  let cur = node;
  while (cur && cur.parentNode) cur = cur.parentNode;
  return cur;
}

function isShadowIncludingInclusiveAncestor(
  anc: BoundaryNode | null,
  of: BoundaryNode | null,
): boolean {
  let cur: BoundaryNode | null = of;
  let hops = 0;
  while (cur && hops++ < MAX_COMPOSED_ANCESTOR_HOPS) {
    if (cur === anc) return true;
    const p = cur.parentNode;
    if (!p && isHostedShadowRoot(cur)) {
      cur = cur.host;
      continue;
    }
    cur = p;
  }
  return false;
}

function selComposedRootIsDocument(node: BoundaryNode | null): boolean {
  let cur: BoundaryNode | null = node;
  let hops = 0;
  while (cur && hops++ < MAX_SELECTION_ANCESTOR_HOPS) {
    if (cur === document) return true;
    const p = cur.parentNode;
    if (!p && isHostedShadowRoot(cur)) {
      cur = cur.host;
      continue;
    }
    cur = p;
  }
  return false;
}

function selRescope(
  node: BoundaryNode | null,
  offset: number,
  roots: ShadowRootImpl[],
  bias: number,
): [BoundaryNode, number] | null {
  let cur = node;
  let off = offset;
  let hops = 0;
  while (cur && hops++ < MAX_COMPOSED_ANCESTOR_HOPS) {
    const root = composedRootOf(cur);
    if (!isHostedShadowRoot(root)) break;
    let opted = false;
    for (const candidateRoot of roots) {
      if (isShadowIncludingInclusiveAncestor(root, candidateRoot)) {
        opted = true;
        break;
      }
    }
    if (opted) break;
    const host = root.host;
    const parent = host && host.parentNode;
    if (!parent) break;
    off = nodeIndexOf(host) + bias;
    cur = parent;
  }
  return cur ? [cur, off] : null;
}

const SEL_SKIP_TAGS = /^(SCRIPT|STYLE|HEAD|TEMPLATE|NOSCRIPT|TITLE|TEXTAREA|SELECT|OPTION)$/;

const SEL_BLOCK_TAGS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "BODY",
  "DD",
  "DETAILS",
  "DIALOG",
  "DIV",
  "DL",
  "DT",
  "FIELDSET",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "FORM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HGROUP",
  "HR",
  "LI",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
  "TD",
  "TH",
  "TR",
  "UL",
]);

// Selection.modify walks a DOM-derived text stream because this shim has no line boxes.
// One text node or <br> of the run, at its offset in the run's text.
interface TextRunEntry {
  node: NodeBase;
  start: number;
  len: number;
  text: boolean;
}
type TextRun = NonNullable<ReturnType<typeof selBuildTextRun>>;
function selBuildTextRun() {
  const body = document && (document.body || document.documentElement);
  if (!body) return null;
  const entries: TextRunEntry[] = [];
  const starts = new Map<BoundaryNode, number>();
  const extents = new Map<BoundaryNode, number[]>();
  const breaks = new Set<number>([0]);
  let text = "";
  const visit = (node: NodeBase | null | undefined) => {
    if (!node) return;
    const t = node.nodeType;
    if (t === TEXT_NODE) {
      const data = typeof node.data === "string" ? node.data : "";
      starts.set(node, text.length);
      entries.push({ node, start: text.length, len: data.length, text: true });
      text += data;
      return;
    }
    if (t !== ELEMENT_NODE) return;
    if (!isElementNode(node)) return;
    const tag = node.tagName;
    if (typeof tag === "string" && SEL_SKIP_TAGS.test(tag)) return;
    starts.set(node, text.length);
    if (tag === "BR") {
      breaks.add(text.length);
      entries.push({ node, start: text.length, len: 1, text: false });
      text += "\n";
      breaks.add(text.length);
      return;
    }
    const block = typeof tag === "string" && SEL_BLOCK_TAGS.has(tag);
    if (block) breaks.add(text.length);
    const from = text.length;
    const kids = node.childNodes;
    for (let i = 0; kids && i < kids.length; i++) visit(kids[i]);
    if (block) breaks.add(text.length);
    extents.set(node, [from, text.length]);
  };
  visit(body);
  breaks.add(text.length);
  return { entries, starts, text, breaks, extents };
}

function selEditingHostOf(node: BoundaryNode | null) {
  let cur = node && node.nodeType === ELEMENT_NODE ? node : node && node.parentNode;
  let hops = 0;
  let host: Element | null = null;
  while (cur && hops++ < MAX_SELECTION_ANCESTOR_HOPS) {
    if (isElementNode(cur) && typeof cur.getAttribute === "function") {
      const ce = cur.getAttribute("contenteditable");
      if (ce === "" || ce === "true") host = cur;
      else if (ce === "false") break;
    }
    cur = cur.parentNode;
  }
  return host;
}

function selRunLineBoundary(run: TextRun, p: number, forward: boolean) {
  let best = forward ? run.text.length : 0;
  for (const b of run.breaks) {
    if (forward) {
      if (b > p && b < best) best = b;
    } else if (b <= p && b > best) best = b;
  }
  return best;
}

function selDirectionAt(node: BoundaryNode | null) {
  let cur = node;
  let hops = 0;
  while (cur && hops++ < MAX_SELECTION_ANCESTOR_HOPS) {
    if (isElementNode(cur) && typeof cur.getAttribute === "function") {
      const d = cur.getAttribute("dir");
      if (d === "rtl" || d === "ltr") return d;
    }
    cur = cur.parentNode;
  }
  return "ltr";
}

function selRunPositionOf(run: TextRun, node: BoundaryNode | null, offset: number) {
  if (!node) return -1;
  if (node.nodeType === TEXT_NODE) {
    const s = run.starts.get(node);
    return s === undefined ? -1 : s + Math.min(offset, nodeLength(node));
  }
  const kids = node.childNodes;
  if (kids && offset < kids.length) {
    const s = run.starts.get(kids[offset]);
    if (s !== undefined) return s;
  }
  const self = run.starts.get(node);
  if (self === undefined) return -1;
  let end = self;
  for (const e of run.entries) {
    if (e.start >= self) end = Math.max(end, e.start + e.len);
    if (kids && kids.length && e.node === kids[kids.length - 1]) break;
  }
  return end;
}

function selRunResolve(run: TextRun, p: number, forward: boolean): [NodeBase, number] | null {
  let before: TextRunEntry | null = null;
  let after: TextRunEntry | null = null;
  for (const e of run.entries) {
    if (!e.text) continue;
    if (e.start < p && p <= e.start + e.len) before = e;
    if (e.start === p && !after) after = e;
  }
  if (!forward && before && after) return [after.node, 0];
  if (before) return [before.node, p - before.start];
  if (after) return [after.node, 0];
  for (let i = run.entries.length - 1; i >= 0; i--) {
    const e = run.entries[i];
    if (e.text) return [e.node, e.len];
  }
  return null;
}

function selRunWordBoundary(run: TextRun, p: number, forward: boolean) {
  const s = run.text;
  const ws = (i: number) => /\s/.test(s.charAt(i));
  if (forward) {
    let i = p;
    while (i < s.length && ws(i)) i++;
    while (i < s.length && !ws(i)) i++;
    return i;
  }
  let i = p;
  while (i > 0 && ws(i - 1)) i--;
  while (i > 0 && !ws(i - 1)) i--;
  return i;
}

function selAssertArgs(n: number, got: number, opName: string) {
  if (got < n) {
    throw new TypeError(
      "Failed to execute '" +
        opName +
        "' on 'Selection': " +
        n +
        " argument" +
        (n === 1 ? "" : "s") +
        " required, but only " +
        got +
        " present.",
    );
  }
}

let selectionchangeScheduled = false;

class SelectionImpl implements Idl.Selection {
  #range: RangeImpl | null = null;
  #backward = false;
  #composed: LiveRangeEntry;

  static {
    notifyRangeMutated = (selection, range, changedEndpoint) => {
      if (selection.#range !== range) return;
      selection.#syncComposedFromRange(changedEndpoint);
      selection.#changed();
      selection.#pushToWasm();
    };
  }

  constructor() {
    if (!selConstructing) throw new TypeError("Illegal constructor");
    this.#composed = {
      startContainer: null,
      startOffset: 0,
      endContainer: null,
      endOffset: 0,
      composedSel: true,
    };
    liveRanges.add(this.#composed);
  }

  #live() {
    const range = this.#range;
    if (!range) return null;
    const composedRange = this.#composed;
    const hasComposedRange = this.#hasComposed();
    const outsideDocument = hasComposedRange
      ? !selComposedRootIsDocument(composedRange.startContainer) ||
        !selComposedRootIsDocument(composedRange.endContainer)
      : !selComposedRootIsDocument(rangeBounds(range).startContainer);
    if (outsideDocument) {
      this.#range = null;
      this.#backward = false;
      this.#clearComposed();
      this.#pushToWasm();
      return null;
    }
    // hasComposedRange means both composed containers are set.
    const { startContainer: composedStart, endContainer: composedEnd } = composedRange;
    if (
      hasComposedRange &&
      composedStart &&
      composedEnd &&
      !selComposedRootIsDocument(rangeBounds(range).startContainer)
    ) {
      try {
        const updatedRange = new RangeImpl(document);
        updatedRange._setStartInternal(composedStart, composedRange.startOffset);
        updatedRange._setEndInternal(composedEnd, composedRange.endOffset);
        this.#range = updatedRange;
        return updatedRange;
      } catch {}
    }
    return range;
  }

  get rangeCount() {
    return this.#live() ? 1 : 0;
  }
  get isCollapsed() {
    const range = this.#live();
    return range ? range.collapsed : true;
  }
  get type() {
    const range = this.#live();
    if (!range) return "None";
    return range.collapsed ? "Caret" : "Range";
  }
  get direction() {
    if (!this.#live()) return "none";
    return this.#backward ? "backward" : "forward";
  }
  get anchorNode() {
    const range = this.#live();
    if (!range) return null;
    const b = rangeBounds(range);
    return this.#backward ? b.endContainer : b.startContainer;
  }
  get anchorOffset() {
    const range = this.#live();
    if (!range) return 0;
    return this.#backward ? rangeBounds(range).endOffset : rangeBounds(range).startOffset;
  }
  get focusNode() {
    const range = this.#live();
    if (!range) return null;
    const b = rangeBounds(range);
    return this.#backward ? b.startContainer : b.endContainer;
  }
  get focusOffset() {
    const range = this.#live();
    if (!range) return 0;
    return this.#backward ? rangeBounds(range).startOffset : rangeBounds(range).endOffset;
  }

  #changed() {
    if (selectionchangeScheduled) return;
    selectionchangeScheduled = true;
    setTimeout(() => {
      selectionchangeScheduled = false;
      try {
        dispatchTrustedEvent(document, new KsEvent("selectionchange"));
      } catch {}
    }, 0);
  }

  #apply(
    range: RangeImpl | null,
    backward: boolean,
    composed?: [BoundaryNode, number, BoundaryNode, number],
  ) {
    this.#range = range;
    this.#backward = backward;
    if (composed) {
      this.#composed.startContainer = composed[0];
      this.#composed.startOffset = composed[1];
      this.#composed.endContainer = composed[2];
      this.#composed.endOffset = composed[3];
    } else if (range) {
      this.#composed.startContainer = rangeBounds(range).startContainer;
      this.#composed.startOffset = rangeBounds(range).startOffset;
      this.#composed.endContainer = rangeBounds(range).endContainer;
      this.#composed.endOffset = rangeBounds(range).endOffset;
    } else {
      this.#clearComposed();
    }
    this.#changed();
    this.#pushToWasm();
  }

  #clearComposed() {
    const c = this.#composed;
    c.startContainer = null;
    c.startOffset = 0;
    c.endContainer = null;
    c.endOffset = 0;
  }

  #hasComposed() {
    return this.#composed.startContainer !== null;
  }

  #applyAnchorFocus(
    anchorNode: BoundaryNode,
    anchorOffset: number,
    focusNode: BoundaryNode,
    focusOffset: number,
  ) {
    const comparison = compareComposed(anchorNode, anchorOffset, focusNode, focusOffset);
    const backward = comparison > 0;
    const startNode = backward ? focusNode : anchorNode;
    const startOffset = backward ? focusOffset : anchorOffset;
    const endNode = backward ? anchorNode : focusNode;
    const endOffset = backward ? anchorOffset : focusOffset;
    const range = new RangeImpl(document);
    range._setStartInternal(startNode, startOffset);
    range._setEndInternal(endNode, endOffset);
    this.#apply(range, backward, [startNode, startOffset, endNode, endOffset]);
  }

  #syncComposedFromRange(changedEndpoint?: string) {
    const range = this.#range;
    const composedRange = this.#composed;
    if (!range) return;
    if (!this.#hasComposed() || !changedEndpoint) {
      composedRange.startContainer = rangeBounds(range).startContainer;
      composedRange.startOffset = rangeBounds(range).startOffset;
      composedRange.endContainer = rangeBounds(range).endContainer;
      composedRange.endOffset = rangeBounds(range).endOffset;
      return;
    }
    if (changedEndpoint === "start") {
      composedRange.startContainer = rangeBounds(range).startContainer;
      composedRange.startOffset = rangeBounds(range).startOffset;
    } else {
      composedRange.endContainer = rangeBounds(range).endContainer;
      composedRange.endOffset = rangeBounds(range).endOffset;
    }
    const comparison = compareComposed(
      composedRange.startContainer,
      composedRange.startOffset,
      composedRange.endContainer,
      composedRange.endOffset,
    );
    if (comparison > 0) {
      if (changedEndpoint === "start") {
        composedRange.endContainer = composedRange.startContainer;
        composedRange.endOffset = composedRange.startOffset;
      } else {
        composedRange.startContainer = composedRange.endContainer;
        composedRange.startOffset = composedRange.endOffset;
      }
    }
  }

  getComposedRanges(options?: Idl.GetComposedRangesOptions) {
    const roots: ShadowRootImpl[] = [];
    if (options !== undefined && options !== null) {
      if (typeof options !== "object") {
        throw new TypeError(
          "Failed to execute 'getComposedRanges' on 'Selection': parameter is not an object.",
        );
      }
      const sr = options.shadowRoots;
      if (sr !== undefined && sr !== null) {
        // for-of throws the page's TypeError for a non-iterable, as before.
        for (const root of sr as Iterable<BoundaryNode | null>) {
          if (!isHostedShadowRoot(root)) {
            throw new TypeError(
              "Failed to execute 'getComposedRanges' on 'Selection': " +
                "parameter is not of type 'ShadowRoot'.",
            );
          }
          roots.push(root);
        }
      }
    }
    if (!this.#live() || !this.#hasComposed()) return [];
    const composedRange = this.#composed;
    const startPoint = selRescope(
      composedRange.startContainer,
      composedRange.startOffset,
      roots,
      0,
    );
    const endPoint = selRescope(composedRange.endContainer, composedRange.endOffset, roots, 1);
    if (!startPoint || !endPoint) return [];
    return [
      new StaticRangeImpl({
        startContainer: startPoint[0],
        startOffset: startPoint[1],
        endContainer: endPoint[0],
        endOffset: endPoint[1],
      }),
    ];
  }

  #pushToWasm() {
    try {
      if (!dom) return;
      try {
        getInternalState().layoutDirtySinceRecord = true;
      } catch {}
      // Paint composed endpoints; a single-tree Range cannot represent a cross-shadow selection.
      const composedRange = this.#hasComposed() ? this.#composed : null;
      const range = this.#range;
      let startNode: BoundaryNode | null = null,
        startOffset = 0,
        endNode: BoundaryNode | null = null,
        endOffset = 0;
      if (composedRange) {
        startNode = composedRange.startContainer;
        startOffset = composedRange.startOffset;
        endNode = composedRange.endContainer;
        endOffset = composedRange.endOffset;
      } else if (range && !range.collapsed) {
        startNode = rangeBounds(range).startContainer;
        startOffset = rangeBounds(range).startOffset;
        endNode = rangeBounds(range).endContainer;
        endOffset = rangeBounds(range).endOffset;
      }
      const startNodeId = startNode && "_id" in startNode ? startNode._id : undefined;
      const endNodeId = endNode && "_id" in endNode ? endNode._id : undefined;
      if (
        typeof startNodeId === "number" &&
        typeof endNodeId === "number" &&
        !(startNode === endNode && startOffset === endOffset)
      ) {
        dom.setDomSelection(startNodeId, startOffset, endNodeId, endOffset);
      } else {
        dom.clearDomSelection();
      }
      bumpMutationSeq("paint");
    } catch {}
  }

  addRange(range: Idl.Range) {
    selAssertArgs(1, arguments.length, "addRange");
    if (!(range instanceof RangeImpl)) {
      throw new TypeError(
        "Failed to execute 'addRange' on 'Selection': parameter is not of type 'Range'.",
      );
    }
    if (!selComposedRootIsDocument(rangeBounds(range).startContainer)) return;
    if (this.#live()) return;
    this.#apply(range, false);
  }
  removeAllRanges() {
    this.#apply(null, false);
  }
  empty() {
    this.removeAllRanges();
  }
  removeRange(range: Idl.Range) {
    selAssertArgs(1, arguments.length, "removeRange");
    if (!(range instanceof RangeImpl)) {
      throw new TypeError(
        "Failed to execute 'removeRange' on 'Selection': parameter is not of type 'Range'.",
      );
    }
    if (this.#live() !== range) {
      throw new DOMException(
        "removeRange: the given Range is not in the selection",
        "NotFoundError",
      );
    }
    this.#apply(null, false);
  }
  getRangeAt(index: number) {
    selAssertArgs(1, arguments.length, "getRangeAt");
    const range = this.#live();
    if (!range || index >>> 0 !== 0) {
      throw new DOMException("Selection.getRangeAt: index out of range", "IndexSizeError");
    }
    return range;
  }

  collapse(node: Idl.Node | null, offset?: number) {
    selAssertArgs(1, arguments.length, "collapse");
    if (node === null) {
      this.removeAllRanges();
      return;
    }
    selAssertNode(node, "collapse");
    const o = (offset ?? 0) >>> 0;
    if (node.nodeType === DOCTYPE_NODE) {
      throw new DOMException(
        "collapse: doctype is not a valid boundary point node",
        "InvalidNodeTypeError",
      );
    }
    if (o > nodeLength(node)) {
      throw new DOMException("collapse: offset out of bounds", "IndexSizeError");
    }
    if (!selComposedRootIsDocument(node)) return;
    const range = new RangeImpl(document);
    range._setStartInternal(node, o);
    range._setEndInternal(node, o);
    this.#apply(range, false, [node, o, node, o]);
  }
  setPosition(node: Idl.Node | null, offset?: number) {
    selAssertArgs(1, arguments.length, "setPosition");
    return this.collapse(node, offset);
  }
  collapseToStart() {
    const live = this.#live();
    if (!live) {
      throw new DOMException("collapseToStart: there is no selection", "InvalidStateError");
    }
    const { startContainer: node, startOffset: offset } = rangeBounds(live);
    const range = new RangeImpl(document);
    range._setStartInternal(node, offset);
    range._setEndInternal(node, offset);
    this.#apply(range, false);
  }
  collapseToEnd() {
    const live = this.#live();
    if (!live) {
      throw new DOMException("collapseToEnd: there is no selection", "InvalidStateError");
    }
    const { endContainer: node, endOffset: offset } = rangeBounds(live);
    const range = new RangeImpl(document);
    range._setStartInternal(node, offset);
    range._setEndInternal(node, offset);
    this.#apply(range, false);
  }

  extend(node: Idl.Node, offset?: number) {
    selAssertArgs(1, arguments.length, "extend");
    selAssertNode(node, "extend");
    const o = (offset ?? 0) >>> 0;
    if (!selComposedRootIsDocument(node)) return;
    if (!this.#live()) {
      throw new DOMException("extend: there is no selection", "InvalidStateError");
    }
    if (node.nodeType === DOCTYPE_NODE) {
      throw new DOMException(
        "extend: doctype is not a valid boundary point node",
        "InvalidNodeTypeError",
      );
    }
    if (o > nodeLength(node)) {
      throw new DOMException("extend: offset out of bounds", "IndexSizeError");
    }
    const composedRange = this.#composed;
    const isBackward = this.#backward;
    const anchorNode = this.#hasComposed()
      ? isBackward
        ? composedRange.endContainer
        : composedRange.startContainer
      : this.anchorNode;
    const anchorOffset = this.#hasComposed()
      ? isBackward
        ? composedRange.endOffset
        : composedRange.startOffset
      : this.anchorOffset;
    if (composedRootOf(anchorNode) !== composedRootOf(node)) {
      this.#applyAnchorFocus(node, o, node, o);
      return;
    }
    // #live() above found a range, so there is an anchor.
    if (!anchorNode) return;
    this.#applyAnchorFocus(anchorNode, anchorOffset, node, o);
  }

  setBaseAndExtent(
    anchorNode: Idl.Node,
    anchorOffset: number,
    focusNode: Idl.Node,
    focusOffset: number,
  ) {
    selAssertArgs(4, arguments.length, "setBaseAndExtent");
    selAssertNode(anchorNode, "setBaseAndExtent");
    selAssertNode(focusNode, "setBaseAndExtent");
    const normalizedAnchorOffset = anchorOffset >>> 0;
    const normalizedFocusOffset = focusOffset >>> 0;
    if (
      normalizedAnchorOffset > nodeLength(anchorNode) ||
      normalizedFocusOffset > nodeLength(focusNode)
    ) {
      throw new DOMException("setBaseAndExtent: offset out of bounds", "IndexSizeError");
    }
    if (!selComposedRootIsDocument(anchorNode) || !selComposedRootIsDocument(focusNode)) {
      return;
    }
    this.#applyAnchorFocus(anchorNode, normalizedAnchorOffset, focusNode, normalizedFocusOffset);
  }

  selectAllChildren(node: Idl.Node) {
    selAssertArgs(1, arguments.length, "selectAllChildren");
    selAssertNode(node, "selectAllChildren");
    if (node.nodeType === DOCTYPE_NODE) {
      throw new DOMException(
        "selectAllChildren: doctype is not a valid boundary point node",
        "InvalidNodeTypeError",
      );
    }
    if (!selComposedRootIsDocument(node)) return;
    const kids = node.childNodes;
    const childCount = kids ? kids.length : 0;
    const range = new RangeImpl(document);
    range._setStartInternal(node, 0);
    range._setEndInternal(node, childCount);
    this.#apply(range, false, [node, 0, node, childCount]);
  }

  containsNode(node: Idl.Node, allowPartialContainment?: boolean) {
    selAssertArgs(1, arguments.length, "containsNode");
    selAssertNode(node, "containsNode");
    const range = this.#live();
    if (!range) return false;
    if (!selComposedRootIsDocument(node)) return false;
    const len = nodeLength(node);
    if (allowPartialContainment) {
      const beforeRangeEnd = compareBoundary(
        node,
        0,
        rangeBounds(range).endContainer,
        rangeBounds(range).endOffset,
      );
      const afterRangeStart = compareBoundary(
        node,
        len,
        rangeBounds(range).startContainer,
        rangeBounds(range).startOffset,
      );
      return beforeRangeEnd < 0 && afterRangeStart > 0;
    }
    const startsBeforeNode = compareBoundary(
      rangeBounds(range).startContainer,
      rangeBounds(range).startOffset,
      node,
      0,
    );
    const endsAfterNode = compareBoundary(
      node,
      len,
      rangeBounds(range).endContainer,
      rangeBounds(range).endOffset,
    );
    return startsBeforeNode <= 0 && endsAfterNode <= 0;
  }

  modify(alter?: string, direction?: string, granularity?: string) {
    const alt = String(alter == null ? "" : alter).toLowerCase();
    const dir = String(direction == null ? "" : direction).toLowerCase();
    const gran = String(granularity == null ? "" : granularity).toLowerCase();
    if (alt !== "extend" && alt !== "move") return;
    if (dir !== "forward" && dir !== "backward" && dir !== "left" && dir !== "right") {
      return;
    }
    if (
      gran !== "character" &&
      gran !== "word" &&
      gran !== "lineboundary" &&
      gran !== "documentboundary" &&
      gran !== "line" &&
      gran !== "sentence" &&
      gran !== "paragraph" &&
      gran !== "sentenceboundary" &&
      gran !== "paragraphboundary"
    ) {
      return;
    }
    if (!this.#live()) return;
    if (
      gran !== "character" &&
      gran !== "word" &&
      gran !== "lineboundary" &&
      gran !== "documentboundary"
    ) {
      return;
    }
    const rtl = (dir === "left" || dir === "right") && selDirectionAt(this.focusNode) === "rtl";
    const forward = dir === "forward" || (dir === "right" && !rtl) || (dir === "left" && rtl);
    const run = selBuildTextRun();
    if (!run) return;
    const fN = this.focusNode,
      fO = this.focusOffset;
    let p = selRunPositionOf(run, fN, fO);
    if (p < 0) return;
    if (gran === "documentboundary") {
      p = forward ? run.text.length : 0;
    } else if (gran === "lineboundary") {
      p = selRunLineBoundary(run, p, forward);
    } else if (gran === "character") {
      p = forward ? Math.min(p + 1, run.text.length) : Math.max(p - 1, 0);
    } else {
      p = selRunWordBoundary(run, p, forward);
    }
    const host = selEditingHostOf(fN);
    const extent = host && run.extents.get(host);
    if (extent) p = Math.min(Math.max(p, extent[0]), extent[1]);
    const point = selRunResolve(run, p, forward);
    if (!point) return;
    if (alt === "move") {
      this.#applyAnchorFocus(point[0], point[1], point[0], point[1]);
    } else {
      // #live() above found a range, so there is an anchor.
      const anchor = this.anchorNode;
      if (anchor) this.#applyAnchorFocus(anchor, this.anchorOffset, point[0], point[1]);
    }
  }

  deleteFromDocument() {
    const range = this.#live();
    if (!range) return;
    range.deleteContents();
    this.#syncComposedFromRange();
    this.#changed();
    this.#pushToWasm();
  }

  toString() {
    const live = this.#live();
    if (!live) return "";
    try {
      return String(live);
    } catch {
      return "";
    }
  }
}
let selectionImpl: SelectionImpl | null = null;
let selConstructing = false;
function getSelection(): SelectionImpl {
  if (!selectionImpl) {
    selConstructing = true;
    try {
      selectionImpl = new SelectionImpl();
    } finally {
      selConstructing = false;
    }
  }
  return selectionImpl;
}

// StaticRange requires all four init members; DocumentType and Attr boundaries throw.
type StaticRangeShimInit = Omit<Idl.StaticRangeInit, "startContainer" | "endContainer"> & {
  startContainer: BoundaryNode;
  endContainer: BoundaryNode;
};

class StaticRangeImpl extends AbstractRangeImpl implements Idl.StaticRange {
  constructor(init: StaticRangeShimInit) {
    if (init == null || typeof init !== "object") {
      throw new TypeError("StaticRange: argument must be a dictionary");
    }
    const { startContainer, startOffset, endContainer, endOffset } = init;
    if (
      startContainer === undefined ||
      endContainer === undefined ||
      startOffset === undefined ||
      endOffset === undefined
    ) {
      throw new TypeError("Failed to construct 'StaticRange': required member missing");
    }
    if (!startContainer || !endContainer) {
      throw new TypeError("StaticRange: startContainer and endContainer are required");
    }
    rangeAssertNotDoctype(startContainer, "StaticRange");
    rangeAssertNotDoctype(endContainer, "StaticRange");
    if (startContainer && startContainer.nodeType === ATTRIBUTE_NODE) {
      throw new DOMException(
        "Failed to construct 'StaticRange': Attr nodes are not allowed as boundary container.",
        "InvalidNodeTypeError",
      );
    }
    if (endContainer && endContainer.nodeType === ATTRIBUTE_NODE) {
      throw new DOMException(
        "Failed to construct 'StaticRange': Attr nodes are not allowed as boundary container.",
        "InvalidNodeTypeError",
      );
    }
    super(ABSTRACT_RANGE_TOKEN, startContainer, startOffset >>> 0, endContainer, endOffset >>> 0);
  }
}

function rangeAfterInsert(parent: BoundaryNode, refIndex: number, count: number): void {
  if (liveRanges.size === 0) return;
  for (const range of liveRanges) {
    if (range.startContainer === parent && range.startOffset > refIndex) {
      range.startOffset += count;
    }
    if (range.endContainer === parent && range.endOffset > refIndex) {
      range.endOffset += count;
    }
  }
}

function rangeBeforeRemove(parent: BoundaryNode, index: number, child: BoundaryNode): void {
  if (liveRanges.size === 0) return;
  for (const range of liveRanges) {
    // Composed selection endpoints follow shadow hosts; ordinary Range endpoints remain tree-local.
    const contains = range.composedSel ? isShadowIncludingInclusiveAncestor : isInclusiveDescendant;
    if (contains(child, range.startContainer)) {
      range.startContainer = parent;
      range.startOffset = index;
    } else if (range.startContainer === parent && range.startOffset > index) {
      range.startOffset -= 1;
    }
    if (contains(child, range.endContainer)) {
      range.endContainer = parent;
      range.endOffset = index;
    } else if (range.endContainer === parent && range.endOffset > index) {
      range.endOffset -= 1;
    }
  }
}

function rangeBeforeReplaceData(
  node: BoundaryNode,
  offset: number,
  count: number,
  insertedLength: number,
): void {
  if (liveRanges.size === 0) return;
  const delta = insertedLength - count;
  const cutEnd = offset + count;
  for (const range of liveRanges) {
    if (range.startContainer === node) {
      if (range.startOffset > offset && range.startOffset <= cutEnd) {
        range.startOffset = offset;
      } else if (range.startOffset > cutEnd) {
        range.startOffset += delta;
      }
    }
    if (range.endContainer === node) {
      if (range.endOffset > offset && range.endOffset <= cutEnd) {
        range.endOffset = offset;
      } else if (range.endOffset > cutEnd) {
        range.endOffset += delta;
      }
    }
  }
}

function rangeAfterSplitText(node: BoundaryNode, offset: number, newNode: BoundaryNode): void {
  if (liveRanges.size === 0) return;
  const parent = node.parentNode || null;
  const newIdx = parent ? nodeIndexOf(newNode) : -1;
  for (const range of liveRanges) {
    if (parent) {
      if (range.startContainer === node && range.startOffset > offset) {
        range.startContainer = newNode;
        range.startOffset -= offset;
      } else if (range.startContainer === parent && range.startOffset === newIdx) {
        range.startOffset += 1;
      }
      if (range.endContainer === node && range.endOffset > offset) {
        range.endContainer = newNode;
        range.endOffset -= offset;
      } else if (range.endContainer === parent && range.endOffset === newIdx) {
        range.endOffset += 1;
      }
    } else {
      if (range.startContainer === node && range.startOffset > offset) {
        range.startOffset = offset;
      }
      if (range.endContainer === node && range.endOffset > offset) {
        range.endOffset = offset;
      }
    }
  }
}

export {
  AbstractRangeImpl,
  RangeImpl,
  StaticRangeImpl,
  SelectionImpl,
  getSelection,
  nodeIndexOf,
  childArray,
  rangeAfterInsert,
  rangeBeforeRemove,
  rangeBeforeReplaceData,
  rangeAfterSplitText,
  nodeLength,
  rootOf,
  isInclusiveDescendant,
  compareBoundary,
  makeDOMException,
};
