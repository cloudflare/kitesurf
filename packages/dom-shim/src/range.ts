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
} from "./state.js";
import { KsEvent } from "./events/event.js";
import { dispatchTrustedEvent } from "./events/dispatch.js";
import { bumpMutationSeq } from "./mutations/seq.js";
import { getInternalState } from "./internal-state.js";
import { markRuntimeCreatedScript } from "./mutations/observer.js";
import { nodeListGetters, nodeOwnerDoc } from "./registries.js";
import { makeDomRect, makeDomRectList } from "./element/rect.js";
import type { NodeBase } from "./node-base.js";
import type { DetachedDocument } from "./document.js";
import type { Element } from "./element/element.js";
import {
  ATTRIBUTE_NODE,
  CDATA_SECTION_NODE,
  COMMENT_NODE,
  DOCUMENT_NODE,
  DOCUMENT_FRAGMENT_NODE,
  DOCTYPE_NODE,
  ELEMENT_NODE,
  HTML_NS,
  PROCESSING_INSTRUCTION_NODE,
  TEXT_NODE,
} from "./constants.js";
type RangeBoundaryContainer = NodeBase | DetachedDocument;
type LiveRangeEntry = RangeBounds<RangeBoundaryContainer | null> & { composedSel?: boolean };

const MAX_COMPOSED_ANCESTOR_HOPS = 4096;
const MAX_SELECTION_ANCESTOR_HOPS = 1024;
const CHARACTER_DATA_NODE_TYPES = new Set([
  TEXT_NODE,
  CDATA_SECTION_NODE,
  PROCESSING_INSTRUCTION_NODE,
  COMMENT_NODE,
]);

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

type RangeCharacterDataNode = NodeBase &
  Partial<Pick<Idl.CharacterData, "replaceData" | "substringData">>;

function isCharacterDataNode(node: NodeBase | null | undefined): node is RangeCharacterDataNode {
  return node != null && CHARACTER_DATA_NODE_TYPES.has(node.nodeType);
}

function nodeLength(node: NodeBase | null | undefined): number {
  if (!node) return 0;
  const t = node.nodeType;
  if (
    t === TEXT_NODE ||
    t === CDATA_SECTION_NODE ||
    t === PROCESSING_INSTRUCTION_NODE ||
    t === COMMENT_NODE
  ) {
    const d = node.data;
    return typeof d === "string" ? d.length : 0;
  }
  if (t === DOCTYPE_NODE) return 0;
  const kids = node.childNodes;
  return kids ? kids.length : 0;
}

function nodeIndexOf(node): number {
  const parent = node?.parentNode;
  return parent ? Array.prototype.indexOf.call(childArray(parent), node) : -1;
}

function childArray(node: NodeBase): ArrayLike<NodeBase> {
  const kids = node.childNodes;
  const get = nodeListGetters.get(kids);
  return get ? get() : kids;
}

function rootOf(node): NodeBase {
  let cur = node;
  while (cur && cur.parentNode) cur = cur.parentNode;
  return cur;
}

function hasDomNodeId(node: any): boolean {
  return !!node && typeof node._id === "number" && node._id >= 0;
}

function wasmInclusiveAncestorAvailable(ancestor: any, node: any): boolean {
  if (ancestor === node) return false;
  if (!hasDomNodeId(ancestor) || !hasDomNodeId(node)) return false;
  return typeof (dom as any).isInclusiveAncestor === "function";
}

function isInclusiveDescendant(ancestor, node): boolean {
  if (wasmInclusiveAncestorAvailable(ancestor, node)) {
    try {
      return (dom as any).isInclusiveAncestor(ancestor._id, node._id) === true;
    } catch {}
  }
  let cur = node;
  while (cur) {
    if (cur === ancestor) return true;
    cur = cur.parentNode;
  }
  return false;
}

function childBelowAncestor(node: NodeBase, ancestor: NodeBase): NodeBase {
  let current = node;
  while (current.parentNode && current.parentNode !== ancestor) current = current.parentNode;
  return current;
}

function compareDescendantBeforeAncestor(
  descendant: NodeBase,
  ancestor: NodeBase,
  ancestorOffset: number,
): number {
  const index = nodeIndexOf(childBelowAncestor(descendant, ancestor));
  return index < ancestorOffset ? -1 : 1;
}

function compareAncestorBeforeDescendant(
  ancestor: NodeBase,
  descendant: NodeBase,
  ancestorOffset: number,
): number {
  const index = nodeIndexOf(childBelowAncestor(descendant, ancestor));
  return index < ancestorOffset ? 1 : -1;
}

function boundaryAncestorChain(node: NodeBase): NodeBase[] {
  const ancestors: NodeBase[] = [];
  let current = node;
  while (current) {
    ancestors.push(current);
    current = current.parentNode;
  }
  return ancestors;
}

function boundaryChildAtAncestor(node: NodeBase, ancestor: NodeBase): NodeBase {
  let current = node;
  while (current.parentNode && current.parentNode !== ancestor) current = current.parentNode;
  return current;
}

function commonBoundaryAncestor(
  ancestors: NodeBase[],
  node: NodeBase,
): { index: number; ancestor: NodeBase } | null {
  let current = node;
  while (current) {
    const index = ancestors.indexOf(current);
    if (index >= 0) return { index, ancestor: current };
    current = current.parentNode;
  }
  return null;
}

function compareBoundaryChildren(
  ancestors: NodeBase[],
  common: { index: number; ancestor: NodeBase },
  node: NodeBase,
): number {
  const firstChild = common.index === 0 ? null : ancestors[common.index - 1];
  const secondChild = boundaryChildAtAncestor(node, common.ancestor);
  const firstIndex = firstChild ? nodeIndexOf(firstChild) : -1;
  const secondIndex = nodeIndexOf(secondChild);
  if (firstIndex === secondIndex) return 0;
  return firstIndex < secondIndex ? -1 : 1;
}

function compareUnrelatedBoundaries(aNode: NodeBase, bNode: NodeBase): number {
  const ancestors = boundaryAncestorChain(aNode);
  const common = commonBoundaryAncestor(ancestors, bNode);
  if (!common) return NaN;
  return compareBoundaryChildren(ancestors, common, bNode);
}

function compareOffsets(aOffset: number, bOffset: number): number {
  return aOffset < bOffset ? -1 : aOffset > bOffset ? 1 : 0;
}

function compareBoundary(aN, aO, bN, bO): number {
  if (aN === bN) return compareOffsets(aO, bO);
  if (rootOf(aN) !== rootOf(bN)) return NaN;
  if (isInclusiveDescendant(bN, aN)) return compareDescendantBeforeAncestor(aN, bN, bO);
  if (isInclusiveDescendant(aN, bN)) return compareAncestorBeforeDescendant(aN, bN, aO);
  return compareUnrelatedBoundaries(aN, bN);
}

function rangeAssertNotDoctype(node, opName) {
  if (node && node.nodeType === DOCTYPE_NODE) {
    throw new DOMException(
      opName + ": doctype is not a valid boundary point node",
      "InvalidNodeTypeError",
    );
  }
}

function rangeAssertOffsetInBounds(node, offset, opName) {
  const u = offset >>> 0;
  const len = nodeLength(node);
  if (u > len) {
    throw new DOMException(
      opName + ": offset " + u + " exceeds node length " + len,
      "IndexSizeError",
    );
  }
}

function nodeIsContainedBy(node, range) {
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
function nodeIsPartiallyContained(node, range) {
  const startInSubtree = isInclusiveDescendant(node, rangeBounds(range).startContainer);
  const endInSubtree = isInclusiveDescendant(node, rangeBounds(range).endContainer);
  return startInSubtree !== endInSubtree;
}
function isInclusiveAncestorOf(ancestor, other) {
  return isInclusiveDescendant(ancestor, other);
}

function makeDOMException(name, msg): Error {
  try {
    return new DOMException(msg, name);
  } catch {
    const e = new Error(msg);
    (e as any).name = name;
    return e;
  }
}

function isRangeTextNode(node: NodeBase): boolean {
  const nodeType = node && node.nodeType;
  return nodeType === TEXT_NODE || nodeType === CDATA_SECTION_NODE;
}

function rangePartiallyContainedNonTextNodes(range) {
  const isText = function isText(nodeType: number): boolean {
    return nodeType === TEXT_NODE || nodeType === CDATA_SECTION_NODE;
  };
  const walk = function walk(node: NodeBase): boolean {
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
  };
  const ca = rangeBounds(range).startContainer;
  let common = ca;
  while (common && !isInclusiveDescendant(common, rangeBounds(range).endContainer)) {
    common = common.parentNode;
  }
  if (!common) return false;
  return walk(common);
}

function rangeCommonAncestor(range) {
  let n = rangeBounds(range).startContainer;
  while (n && !isInclusiveDescendant(n, rangeBounds(range).endContainer)) {
    n = n.parentNode;
  }
  return n;
}

function makeTransientRange(sN, sO, eN, eO): AbstractRangeImpl {
  return new AbstractRangeImpl(ABSTRACT_RANGE_TOKEN, sN, sO, eN, eO);
}

type RangeCloneMode = "clone" | "extract";

interface RangeClonePoints {
  startNode: NodeBase;
  startOffset: number;
  endNode: NodeBase;
  endOffset: number;
}

interface PartialRangeChildren {
  first: NodeBase | null;
  last: NodeBase | null;
}

function rangeClonePoints(range: AbstractRangeImpl): RangeClonePoints {
  const bounds = rangeBounds(range);
  return {
    startNode: bounds.startContainer,
    startOffset: bounds.startOffset,
    endNode: bounds.endContainer,
    endOffset: bounds.endOffset,
  };
}

function cloneCharacterDataRange(node: RangeCharacterDataNode, start: number, end: number) {
  const clone = node.cloneNode(false);
  try {
    const substringData = node.substringData;
    if (typeof substringData !== "function") throw new TypeError("substringData is unavailable");
    clone.data = Reflect.apply(substringData, node, [start, end - start]);
  } catch {
    const data = node.data || "";
    clone.data = data.slice(start, end);
  }
  return clone;
}

function removeCharacterDataRange(node: RangeCharacterDataNode, start: number, end: number): void {
  if (typeof node.replaceData === "function") {
    node.replaceData(start, end - start, "");
    return;
  }
  const data = node.data || "";
  node.data = data.slice(0, start) + data.slice(end);
}

function collapseRange(range: AbstractRangeImpl, node: NodeBase, offset: number): void {
  const bounds = rangeBounds(range);
  bounds.startContainer = node;
  bounds.startOffset = offset;
  bounds.endContainer = node;
  bounds.endOffset = offset;
}

function cloneSingleCharacterDataRange(
  range: AbstractRangeImpl,
  mode: RangeCloneMode,
  points: RangeClonePoints,
  frag: Idl.DocumentFragment,
): boolean {
  if (points.startNode !== points.endNode || !isCharacterDataNode(points.startNode)) return false;
  frag.appendChild(cloneCharacterDataRange(points.startNode, points.startOffset, points.endOffset));
  if (mode === "extract") {
    removeCharacterDataRange(points.startNode, points.startOffset, points.endOffset);
    collapseRange(range, points.startNode, points.startOffset);
  }
  return true;
}

function firstPartiallyContainedChild(
  commonAncestor: NodeBase,
  range: AbstractRangeImpl,
): NodeBase | null {
  const kids = commonAncestor.childNodes;
  for (let i = 0; i < kids.length; i++) {
    if (nodeIsPartiallyContained(kids[i], range)) return kids[i];
  }
  return null;
}

function lastPartiallyContainedChild(
  commonAncestor: NodeBase,
  range: AbstractRangeImpl,
): NodeBase | null {
  const kids = commonAncestor.childNodes;
  for (let i = kids.length - 1; i >= 0; i--) {
    if (nodeIsPartiallyContained(kids[i], range)) return kids[i];
  }
  return null;
}

function partiallyContainedRangeChildren(
  range: AbstractRangeImpl,
  points: RangeClonePoints,
  commonAncestor: NodeBase,
): PartialRangeChildren {
  const first = isInclusiveAncestorOf(points.startNode, points.endNode)
    ? null
    : firstPartiallyContainedChild(commonAncestor, range);
  const last = isInclusiveAncestorOf(points.endNode, points.startNode)
    ? null
    : lastPartiallyContainedChild(commonAncestor, range);
  return { first, last };
}

function containedRangeChildren(
  commonAncestor: NodeBase,
  range: AbstractRangeImpl,
  mode: RangeCloneMode,
): NodeBase[] {
  const contained: NodeBase[] = [];
  const kids = commonAncestor.childNodes;
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i];
    if (!nodeIsContainedBy(child, range)) continue;
    if (child.nodeType === DOCTYPE_NODE) {
      const operation = mode === "clone" ? "cloneContents" : "extractContents";
      throw makeDOMException(
        "HierarchyRequestError",
        "Range." + operation + ": cannot include a DocumentType",
      );
    }
    contained.push(child);
  }
  return contained;
}

function rangeExtractionBoundary(points: RangeClonePoints): { node: NodeBase; offset: number } {
  let node = points.startNode;
  let offset = points.startOffset;
  if (isInclusiveAncestorOf(points.startNode, points.endNode)) return { node, offset };
  let reference = points.startNode;
  while (reference.parentNode && !isInclusiveAncestorOf(reference.parentNode, points.endNode)) {
    reference = reference.parentNode;
  }
  if (reference.parentNode) {
    node = reference.parentNode;
    offset = nodeIndexOf(reference) + 1;
  }
  return { node, offset };
}

function appendStartPartial(
  frag: Idl.DocumentFragment,
  mode: RangeCloneMode,
  range: AbstractRangeImpl,
  points: RangeClonePoints,
  child: NodeBase | null,
): void {
  if (isCharacterDataNode(child)) {
    const end = nodeLength(points.startNode);
    frag.appendChild(cloneCharacterDataRange(points.startNode, points.startOffset, end));
    if (mode === "extract") removeCharacterDataRange(points.startNode, points.startOffset, end);
    return;
  }
  if (!child) return;
  const clone = child.cloneNode(false);
  frag.appendChild(clone);
  const subrange = makeTransientRange(
    points.startNode,
    points.startOffset,
    child,
    nodeLength(child),
  );
  clone.appendChild(rangeCloneOrExtract(subrange, mode));
}

function appendContainedChildren(
  frag: Idl.DocumentFragment,
  children: NodeBase[],
  mode: RangeCloneMode,
): void {
  for (const child of children) {
    frag.appendChild(mode === "clone" ? child.cloneNode(true) : child);
  }
}

function appendEndPartial(
  frag: Idl.DocumentFragment,
  mode: RangeCloneMode,
  points: RangeClonePoints,
  child: NodeBase | null,
): void {
  if (isCharacterDataNode(child)) {
    frag.appendChild(cloneCharacterDataRange(points.endNode, 0, points.endOffset));
    if (mode === "extract") removeCharacterDataRange(points.endNode, 0, points.endOffset);
    return;
  }
  if (!child) return;
  const clone = child.cloneNode(false);
  frag.appendChild(clone);
  const subrange = makeTransientRange(child, 0, points.endNode, points.endOffset);
  clone.appendChild(rangeCloneOrExtract(subrange, mode));
}

function rangeCloneOrExtract(range: AbstractRangeImpl, mode: RangeCloneMode) {
  const frag = liveDocument().createDocumentFragment();
  if (range.collapsed) return frag;
  const points = rangeClonePoints(range);
  if (cloneSingleCharacterDataRange(range, mode, points, frag)) return frag;

  const commonAncestor = rangeCommonAncestor(range);
  const partial = partiallyContainedRangeChildren(range, points, commonAncestor);
  const contained = containedRangeChildren(commonAncestor, range, mode);
  const extractionBoundary = rangeExtractionBoundary(points);
  appendStartPartial(frag, mode, range, points, partial.first);
  appendContainedChildren(frag, contained, mode);
  appendEndPartial(frag, mode, points, partial.last);
  if (mode === "extract") collapseRange(range, extractionBoundary.node, extractionBoundary.offset);
  return frag;
}

function isRangeElementNode(node: NodeBase | null | undefined): node is Element {
  return node != null && node.nodeType === ELEMENT_NODE;
}

function contextualFragmentElement(node: NodeBase): Element | null {
  if (isRangeElementNode(node)) return node;
  if (node.nodeType === TEXT_NODE || node.nodeType === COMMENT_NODE) {
    const parent = node.parentElement;
    return isRangeElementNode(parent) ? parent : null;
  }
  return null;
}

function fragmentFromDocumentDom(
  doc: any,
  namespace: string | null,
  localName: string,
  html: string,
) {
  const context = doc.createElementNS(namespace, localName);
  context.innerHTML = html;
  const fragment = doc.createDocumentFragment();
  while (context.firstChild) fragment.appendChild(context.firstChild);
  return fragment;
}

function fragmentFromWasmContext(
  doc: any,
  namespace: string | null,
  localName: string,
  html: string,
) {
  const fragment = createDocumentFragmentInternal();
  if (doc !== document) nodeOwnerDoc.set(fragment, doc);
  parseFragmentInContext(fragment, namespace, localName, html);
  for (const id of dom.querySelectorAllInSubtree(fragment._id, "script")) {
    markRuntimeCreatedScript(id);
  }
  return fragment;
}

function fragmentInDocumentContext(
  doc: any,
  namespace: string | null,
  localName: string,
  html: string,
) {
  return "_dom" in doc && doc._dom
    ? fragmentFromDocumentDom(doc, namespace, localName, html)
    : fragmentFromWasmContext(doc, namespace, localName, html);
}

function isHtmlContextElement(element: Element | null): boolean | null {
  return element && element.localName === "html" && element.namespaceURI === HTML_NS;
}

function contextualFragmentDetails(node: NodeBase): {
  doc: any;
  namespace: string | null;
  localName: string;
} {
  const doc = node.nodeType === DOCUMENT_NODE ? node : node.ownerDocument;
  let element = contextualFragmentElement(node);
  if (isHtmlContextElement(element)) element = null;
  return {
    doc,
    namespace: element ? element.namespaceURI : HTML_NS,
    localName: element ? element.localName : "body",
  };
}

function contextualFragmentForRange(node: NodeBase, markup: string): Idl.DocumentFragment {
  const context = contextualFragmentDetails(node);
  return fragmentInDocumentContext(
    context.doc,
    context.namespace,
    context.localName,
    String(markup),
  );
}

type RangeRectTarget = NodeBase & Pick<Idl.Element, "getBoundingClientRect">;

function hasRangeRectMethod(node: NodeBase | null): node is RangeRectTarget {
  if (!node) return false;
  if (!("getBoundingClientRect" in node)) return false;
  return typeof node.getBoundingClientRect === "function";
}

function rangeRectTarget(startNode: BoundaryNode): RangeRectTarget | null {
  let node: NodeBase | null = startNode;
  if (node && node.nodeType === TEXT_NODE) node = node.parentNode;
  return hasRangeRectMethod(node) ? node : null;
}

function safeRangeRect(node: RangeRectTarget): Idl.DOMRect | null {
  try {
    return node.getBoundingClientRect();
  } catch {
    return null;
  }
}

function assertRangeNodeArgument(node: unknown, operation: string): void {
  if (
    node === null ||
    typeof node !== "object" ||
    typeof Reflect.get(node, "nodeType") !== "number"
  ) {
    throw new TypeError(operation + ": argument must be a Node");
  }
}

function assertRangePointInSameTree(node: NodeBase, range: RangeImpl, operation: string): void {
  if (rootOf(node) !== rootOf(rangeBounds(range).startContainer)) {
    throw new DOMException(operation + ": node is in a different tree", "WrongDocumentError");
  }
}

function comparePointToRange(range: RangeImpl, node: NodeBase, offset: number): number {
  const bounds = rangeBounds(range);
  if (compareBoundary(node, offset, bounds.startContainer, bounds.startOffset) < 0) return -1;
  if (compareBoundary(node, offset, bounds.endContainer, bounds.endOffset) > 0) return 1;
  return 0;
}

function assertIsPointInRangeOffset(node: NodeBase, offset: number): void {
  const normalized = offset >>> 0;
  if (normalized > nodeLength(node)) {
    throw new DOMException(
      "isPointInRange: offset " + normalized + " exceeds node length",
      "IndexSizeError",
    );
  }
}

function pointIsWithinRange(range: RangeImpl, node: NodeBase, offset: number): boolean {
  const bounds = rangeBounds(range);
  const start = compareBoundary(node, offset, bounds.startContainer, bounds.startOffset);
  const end = compareBoundary(node, offset, bounds.endContainer, bounds.endOffset);
  return start >= 0 && end <= 0;
}

function* rangeDescendants(root: NodeBase): IterableIterator<NodeBase> {
  yield root;
  const kids = root.childNodes;
  if (!kids) return;
  for (let i = 0; i < kids.length; i++) yield* rangeDescendants(kids[i]);
}

function rangeTextAnchor(node: NodeBase, offset: number): NodeBase | null {
  if (isRangeTextNode(node)) return node;
  const kids = node.childNodes;
  return offset < kids.length ? kids[offset] : null;
}

interface RangeTextCollection {
  startNode: NodeBase;
  startAnchor: NodeBase | null;
  endNode: NodeBase;
  endAnchor: NodeBase | null;
  endOffset: number;
  startIsText: boolean;
  endIsText: boolean;
  collecting: boolean;
  stopped: boolean;
  text: string;
}

function appendRangeEndText(node: NodeBase, state: RangeTextCollection): boolean {
  if (node !== state.endNode || !state.endIsText) return false;
  state.text += (state.endNode.data || "").slice(0, state.endOffset);
  state.stopped = true;
  return true;
}

function stopAtRangeEndAnchor(node: NodeBase, state: RangeTextCollection): boolean {
  if (node !== state.endAnchor) return false;
  state.stopped = true;
  return true;
}

function markRangeTextStart(node: NodeBase, state: RangeTextCollection): void {
  if (node === state.startAnchor) state.collecting = true;
}

function appendCollectedRangeText(node: NodeBase, state: RangeTextCollection): void {
  if (state.collecting && isRangeTextNode(node)) state.text += node.data || "";
}

function collectRangeTextNode(node: NodeBase, state: RangeTextCollection): void {
  markRangeTextStart(node, state);
  if (node === state.startNode && state.startIsText) return;
  if (appendRangeEndText(node, state)) return;
  if (stopAtRangeEndAnchor(node, state)) return;
  appendCollectedRangeText(node, state);
}

function initialRangeText(node: NodeBase, offset: number): string {
  if (!isRangeTextNode(node)) return "";
  const data = node.data || "";
  return data.slice(offset);
}

function rangeTextBetween(range: RangeImpl, points: RangeClonePoints): string {
  const startIsText = isRangeTextNode(points.startNode);
  const endIsText = isRangeTextNode(points.endNode);
  const state: RangeTextCollection = {
    startNode: points.startNode,
    startAnchor: rangeTextAnchor(points.startNode, points.startOffset),
    endNode: points.endNode,
    endAnchor: rangeTextAnchor(points.endNode, points.endOffset),
    endOffset: points.endOffset,
    startIsText,
    endIsText,
    collecting: false,
    stopped: false,
    text: initialRangeText(points.startNode, points.startOffset),
  };
  for (const node of rangeDescendants(range.commonAncestorContainer)) {
    if (state.stopped) break;
    collectRangeTextNode(node, state);
  }
  return state.text;
}

function isForbiddenInsertionContainer(startType: number): boolean {
  return startType === PROCESSING_INSTRUCTION_NODE || startType === COMMENT_NODE;
}

function isCharacterDataInsertionContainer(startType: number): boolean {
  return startType === TEXT_NODE || startType === CDATA_SECTION_NODE;
}

function insertionInCharacterData(
  startNode: NodeBase & { splitText?: (offset: number) => NodeBase },
  startOffset: number,
): { parent: NodeBase; reference: NodeBase | null } {
  const parent = startNode.parentNode;
  if (!parent) {
    throw makeDOMException(
      "HierarchyRequestError",
      "insertNode: start container is a parentless Text",
    );
  }
  const reference = startNode.splitText ? startNode.splitText(startOffset) : startNode.nextSibling;
  return { parent, reference };
}

function insertionInChildList(
  startNode: NodeBase,
  startOffset: number,
): { parent: NodeBase; reference: NodeBase | null } {
  const kids = startNode.childNodes;
  return { parent: startNode, reference: startOffset < kids.length ? kids[startOffset] : null };
}

function rangeInsertionLocation(
  startNode: NodeBase,
  startOffset: number,
): { parent: NodeBase; reference: NodeBase | null } {
  const startType = startNode.nodeType;
  if (isForbiddenInsertionContainer(startType)) {
    throw makeDOMException(
      "HierarchyRequestError",
      "insertNode: start container is a ProcessingInstruction/Comment",
    );
  }
  if (isCharacterDataInsertionContainer(startType)) {
    return insertionInCharacterData(startNode, startOffset);
  }
  return insertionInChildList(startNode, startOffset);
}

function detachRangeInsertionNode(node: NodeBase): void {
  if (!node.parentNode) return;
  try {
    node.parentNode.removeChild(node);
  } catch {}
}

function insertNodeAtRangeStart(range: RangeImpl, node: NodeBase): void {
  const bounds = rangeBounds(range);
  const { parent, reference } = rangeInsertionLocation(bounds.startContainer, bounds.startOffset);
  const adjustedReference = reference === node ? node.nextSibling : reference;
  detachRangeInsertionNode(node);
  parent.insertBefore(node, adjustedReference);
  if (range.collapsed) {
    bounds.endContainer = parent;
    bounds.endOffset = nodeIndexOf(node) + 1;
  }
}

function isForbiddenSurroundParent(newParent: NodeBase): boolean {
  return (
    newParent.nodeType === DOCUMENT_NODE ||
    newParent.nodeType === DOCTYPE_NODE ||
    newParent.nodeType === DOCUMENT_FRAGMENT_NODE
  );
}

function assertSurroundContentsAllowed(range: RangeImpl, newParent: NodeBase): void {
  if (!newParent) throw new TypeError("surroundContents: argument is not a Node");
  if (rangePartiallyContainedNonTextNodes(range)) {
    throw makeDOMException(
      "InvalidStateError",
      "surroundContents: range partially selects a non-Text node",
    );
  }
  if (isForbiddenSurroundParent(newParent)) {
    throw makeDOMException(
      "HierarchyRequestError",
      "surroundContents: newParent must not be Document/DocumentType/DocumentFragment",
    );
  }
}

function rangeExtractOrDelete(range: RangeImpl): void {
  if (range.collapsed) return;
  rangeCloneOrExtract(range, "extract");
}

type BoundaryNode = NodeBase;
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

  constructor(ownerDoc?: any) {
    const def = ownerDoc != null ? ownerDoc : document;
    super(ABSTRACT_RANGE_TOKEN, def, 0, def, 0);
    liveRanges.add(rangeBounds(this));
  }

  get commonAncestorContainer() {
    let cur = rangeBounds(this).startContainer;
    while (cur && !isInclusiveDescendant(cur, rangeBounds(this).endContainer)) {
      cur = cur.parentNode;
    }
    return cur || rangeBounds(this).startContainer;
  }

  _setStartInternal(node, offset): void {
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
  _setEndInternal(node, offset): void {
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

  setStart(node, offset) {
    this._setStartInternal(node, offset >>> 0);
  }
  setEnd(node, offset) {
    this._setEndInternal(node, offset >>> 0);
  }
  setStartBefore(node) {
    const parent = node && node.parentNode;
    if (!parent) {
      throw new DOMException("setStartBefore: node has no parent", "InvalidNodeTypeError");
    }
    this._setStartInternal(parent, nodeIndexOf(node));
  }
  setStartAfter(node) {
    const parent = node && node.parentNode;
    if (!parent) {
      throw new DOMException("setStartAfter: node has no parent", "InvalidNodeTypeError");
    }
    this._setStartInternal(parent, nodeIndexOf(node) + 1);
  }
  setEndBefore(node) {
    const parent = node && node.parentNode;
    if (!parent) {
      throw new DOMException("setEndBefore: node has no parent", "InvalidNodeTypeError");
    }
    this._setEndInternal(parent, nodeIndexOf(node));
  }
  setEndAfter(node) {
    const parent = node && node.parentNode;
    if (!parent) {
      throw new DOMException("setEndAfter: node has no parent", "InvalidNodeTypeError");
    }
    this._setEndInternal(parent, nodeIndexOf(node) + 1);
  }
  collapse(toStart) {
    if (toStart) {
      rangeBounds(this).endContainer = rangeBounds(this).startContainer;
      rangeBounds(this).endOffset = rangeBounds(this).startOffset;
    } else {
      rangeBounds(this).startContainer = rangeBounds(this).endContainer;
      rangeBounds(this).startOffset = rangeBounds(this).endOffset;
    }
    selNotifyRangeMutated(this);
  }
  selectNode(node) {
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
  selectNodeContents(node) {
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
  createContextualFragment(markup: string): Idl.DocumentFragment {
    return contextualFragmentForRange(rangeBounds(this).startContainer, markup);
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
    const node = rangeRectTarget(rangeBounds(this).startContainer);
    return node ? safeRangeRect(node) : null;
  }

  compareBoundaryPoints(how, other) {
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
    let aN, aO, bN, bO;
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

  comparePoint(node, offset) {
    assertRangeNodeArgument(node, "comparePoint");
    assertRangePointInSameTree(node, this, "comparePoint");
    rangeAssertNotDoctype(node, "comparePoint");
    rangeAssertOffsetInBounds(node, offset, "comparePoint");
    return comparePointToRange(this, node, offset);
  }
  isPointInRange(node, offset) {
    assertRangeNodeArgument(node, "isPointInRange");
    if (rootOf(node) !== rootOf(rangeBounds(this).startContainer)) return false;
    rangeAssertNotDoctype(node, "isPointInRange");
    const u = offset >>> 0;
    assertIsPointInRangeOffset(node, u);
    return pointIsWithinRange(this, node, u);
  }
  intersectsNode(node) {
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
    const points = rangeClonePoints(this);
    if (points.startNode === points.endNode && isRangeTextNode(points.startNode)) {
      const data = points.startNode.data || "";
      return data.slice(points.startOffset, points.endOffset);
    }
    return rangeTextBetween(this, points);
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
  insertNode(node) {
    if (!node || typeof node !== "object" || typeof node.nodeType !== "number") {
      throw new TypeError("insertNode: argument is not a Node");
    }
    insertNodeAtRangeStart(this, node);
  }
  surroundContents(newParent) {
    assertSurroundContentsAllowed(this, newParent);
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

function selAssertNode(v: any, opName: string) {
  if (!v || typeof v !== "object" || typeof v.nodeType !== "number") {
    throw new TypeError(
      "Failed to execute '" + opName + "' on 'Selection': parameter is not of type 'Node'.",
    );
  }
}

let notifyRangeMutated!: (
  selection: SelectionImpl,
  range: unknown,
  changedEndpoint?: string,
) => void;
function selNotifyRangeMutated(range: unknown, changedEndpoint?: string) {
  if (selectionImpl) notifyRangeMutated(selectionImpl, range, changedEndpoint);
}

function composedParentStep(node: any): { parent: any; step: number } | null {
  const parent = node.parentNode;
  if (parent) return { parent, step: nodeIndexOf(node) };
  if (isShadowRootNode(node)) return { parent: node.host, step: -1 };
  return null;
}

function composedSteps(node: any): { root: any; steps: number[] } {
  const steps: number[] = [];
  let cur = node;
  let hops = 0;
  while (cur && hops++ < MAX_COMPOSED_ANCESTOR_HOPS) {
    const next = composedParentStep(cur);
    if (!next) break;
    steps.push(next.step);
    cur = next.parent;
  }
  steps.reverse();
  return { root: cur, steps };
}

function compareComposedStepPaths(aSteps: number[], bSteps: number[]): number | null {
  const sharedLength = Math.min(aSteps.length, bSteps.length);
  for (let i = 0; i < sharedLength; i++) {
    if (aSteps[i] !== bSteps[i]) return compareOffsets(aSteps[i], bSteps[i]);
  }
  return null;
}

function compareComposedPathLengths(
  aSteps: number[],
  aOffset: number,
  bSteps: number[],
  bOffset: number,
): number {
  if (aSteps.length === bSteps.length) return 0;
  const sharedLength = Math.min(aSteps.length, bSteps.length);
  if (aSteps.length < bSteps.length) return aOffset <= bSteps[sharedLength] ? -1 : 1;
  return bOffset <= aSteps[sharedLength] ? 1 : -1;
}

function compareComposedPaths(aN: any, aO: number, bN: any, bO: number): number {
  const aPath = composedSteps(aN);
  const bPath = composedSteps(bN);
  if (aPath.root !== bPath.root) return NaN;
  const sharedOrder = compareComposedStepPaths(aPath.steps, bPath.steps);
  if (sharedOrder !== null) return sharedOrder;
  return compareComposedPathLengths(aPath.steps, aO, bPath.steps, bO);
}

function compareComposed(aN: any, aO: number, bN: any, bO: number): number {
  if (aN === bN) return compareOffsets(aO, bO);
  if (!aN || !bN) return NaN;
  return compareComposedPaths(aN, aO, bN, bO);
}

function isShadowRootNode(v: any): boolean {
  return !!v && v.nodeType === DOCUMENT_FRAGMENT_NODE && !!v.host;
}

function composedRootOf(node: any): any {
  let cur = node;
  while (cur && cur.parentNode) cur = cur.parentNode;
  return cur;
}

function shadowIncludingParent(node: any): any {
  const parent = node.parentNode;
  if (parent) return parent;
  return isShadowRootNode(node) ? node.host : null;
}

function isShadowIncludingInclusiveAncestor(anc: any, of: any): boolean {
  let cur = of;
  let hops = 0;
  while (cur && hops++ < MAX_COMPOSED_ANCESTOR_HOPS) {
    if (cur === anc) return true;
    cur = shadowIncludingParent(cur);
  }
  return false;
}

function selComposedRootIsDocument(node: any): boolean {
  let cur = node;
  let hops = 0;
  while (cur && hops++ < MAX_SELECTION_ANCESTOR_HOPS) {
    if (cur === document) return true;
    cur = shadowIncludingParent(cur);
  }
  return false;
}

function selRescope(node: any, offset: number, roots: any[], bias: number) {
  let cur = node;
  let off = offset;
  let hops = 0;
  while (cur && hops++ < MAX_COMPOSED_ANCESTOR_HOPS) {
    const root = composedRootOf(cur);
    if (!isShadowRootNode(root)) break;
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
interface SelectionTextRunBuilder {
  entries: any[];
  starts: Map<any, number>;
  extents: Map<any, number[]>;
  breaks: Set<number>;
  text: string;
}

function addSelectionTextEntry(node: any, state: SelectionTextRunBuilder): void {
  const data = typeof node.data === "string" ? node.data : "";
  state.starts.set(node, state.text.length);
  state.entries.push({ node, start: state.text.length, len: data.length, text: true });
  state.text += data;
}

function addSelectionBreakEntry(node: any, state: SelectionTextRunBuilder): void {
  state.breaks.add(state.text.length);
  state.entries.push({ node, start: state.text.length, len: 1, text: false });
  state.text += "\n";
  state.breaks.add(state.text.length);
}

function isSkippedSelectionElement(tag: unknown): boolean {
  return typeof tag === "string" && SEL_SKIP_TAGS.test(tag);
}

function visitSelectionChildren(node: any, state: SelectionTextRunBuilder): void {
  const kids = node.childNodes;
  for (let i = 0; kids && i < kids.length; i++) visitSelectionNode(kids[i], state);
}

function visitSelectionElement(node: any, state: SelectionTextRunBuilder): void {
  const tag = node.tagName;
  if (isSkippedSelectionElement(tag)) return;
  state.starts.set(node, state.text.length);
  if (tag === "BR") {
    addSelectionBreakEntry(node, state);
    return;
  }
  const block = isSelectionBlockTag(tag);
  if (block) state.breaks.add(state.text.length);
  const from = state.text.length;
  visitSelectionChildren(node, state);
  if (block) state.breaks.add(state.text.length);
  state.extents.set(node, [from, state.text.length]);
}

function isSelectionBlockTag(tag: unknown): boolean {
  return typeof tag === "string" && SEL_BLOCK_TAGS.has(tag);
}

function visitSelectionNode(node: any, state: SelectionTextRunBuilder): void {
  if (!node) return;
  if (node.nodeType === TEXT_NODE) {
    addSelectionTextEntry(node, state);
    return;
  }
  if (node.nodeType !== ELEMENT_NODE) return;
  visitSelectionElement(node, state);
}

function selBuildTextRun() {
  const body = (document as any).body || (document as any).documentElement;
  if (!body) return null;
  const state: SelectionTextRunBuilder = {
    entries: [],
    starts: new Map(),
    extents: new Map(),
    breaks: new Set([0]),
    text: "",
  };
  visitSelectionNode(body, state);
  state.breaks.add(state.text.length);
  return state;
}

function editingHostDecision(node: any): { host: any; stop: boolean } {
  if (node.nodeType !== ELEMENT_NODE || typeof node.getAttribute !== "function") {
    return { host: null, stop: false };
  }
  const value = node.getAttribute("contenteditable");
  if (value === "" || value === "true") return { host: node, stop: false };
  return { host: null, stop: value === "false" };
}

function selectionEditingHostStart(node: any): any {
  return node && node.nodeType === ELEMENT_NODE ? node : node && node.parentNode;
}

function selEditingHostOf(node: any) {
  let cur = selectionEditingHostStart(node);
  let hops = 0;
  let host: any = null;
  while (cur && hops++ < MAX_SELECTION_ANCESTOR_HOPS) {
    const decision = editingHostDecision(cur);
    if (decision.host) host = decision.host;
    if (decision.stop) break;
    cur = cur.parentNode;
  }
  return host;
}

function selRunLineBoundary(run: any, p: number, forward: boolean) {
  let best = forward ? run.text.length : 0;
  for (const b of run.breaks as Set<number>) {
    if (forward) {
      if (b > p && b < best) best = b;
    } else if (b <= p && b > best) best = b;
  }
  return best;
}

function directionOnNode(node: any): "ltr" | "rtl" | null {
  if (node.nodeType !== ELEMENT_NODE || typeof node.getAttribute !== "function") return null;
  const direction = node.getAttribute("dir");
  return direction === "rtl" || direction === "ltr" ? direction : null;
}

function selDirectionAt(node: any) {
  let cur = node;
  let hops = 0;
  while (cur && hops++ < MAX_SELECTION_ANCESTOR_HOPS) {
    const direction = directionOnNode(cur);
    if (direction) return direction;
    cur = cur.parentNode;
  }
  return "ltr";
}

function selectionTextNodePosition(run: any, node: any, offset: number): number {
  const start = run.starts.get(node);
  return start === undefined ? -1 : start + Math.min(offset, nodeLength(node));
}

function selectionChildPosition(run: any, node: any, offset: number): number | null {
  const kids = node.childNodes;
  if (!kids || offset >= kids.length) return null;
  const start = run.starts.get(kids[offset]);
  return start === undefined ? null : start;
}

function isLastSelectionRunChild(
  entry: any,
  kids: ArrayLike<NodeBase> | null | undefined,
): boolean {
  return !!kids && kids.length > 0 && entry.node === kids[kids.length - 1];
}

function selectionNodeEndPosition(
  run: SelectionTextRunBuilder,
  start: number,
  kids: ArrayLike<NodeBase> | null | undefined,
): number {
  let end = start;
  for (const entry of run.entries) {
    if (entry.start >= start) end = Math.max(end, entry.start + entry.len);
    if (isLastSelectionRunChild(entry, kids)) break;
  }
  return end;
}

function selRunPositionOf(run: any, node: any, offset: number) {
  if (!node) return -1;
  if (node.nodeType === TEXT_NODE) return selectionTextNodePosition(run, node, offset);
  const kids = node.childNodes;
  const childPosition = selectionChildPosition(run, node, offset);
  if (childPosition !== null) return childPosition;
  const self = run.starts.get(node);
  if (self === undefined) return -1;
  return selectionNodeEndPosition(run, self, kids);
}

function updateSelectionTextEntries(
  entry: any,
  position: number,
  found: { before: any; after: any },
): void {
  if (!entry.text) return;
  if (isSelectionTextEntryBefore(entry, position)) found.before = entry;
  if (entry.start === position && !found.after) found.after = entry;
}

function isSelectionTextEntryBefore(entry: any, position: number): boolean {
  return entry.start < position && position <= entry.start + entry.len;
}

function selectionTextEntriesAt(run: any, position: number): { before: any; after: any } {
  const found: { before: any; after: any } = { before: null, after: null };
  for (const entry of run.entries) updateSelectionTextEntries(entry, position, found);
  return found;
}

function lastSelectionTextPoint(run: any): [any, number] | null {
  for (let i = run.entries.length - 1; i >= 0; i--) {
    const entry = run.entries[i];
    if (entry.text) return [entry.node, entry.len];
  }
  return null;
}

function selRunResolve(run: any, p: number, forward: boolean) {
  const { before, after } = selectionTextEntriesAt(run, p);
  if (preferSelectionEntryAfter(before, after, forward)) return [after.node, 0];
  if (before) return [before.node, p - before.start];
  if (after) return [after.node, 0];
  return lastSelectionTextPoint(run);
}

function preferSelectionEntryAfter(before: any, after: any, forward: boolean): boolean {
  return !forward && !!before && !!after;
}

function selRunWordBoundary(run: any, p: number, forward: boolean) {
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

function validateComposedShadowRoots(shadowRoots: any): any[] {
  const roots: any[] = [];
  if (shadowRoots == null) return roots;
  for (const root of shadowRoots) {
    if (!isShadowRootNode(root)) {
      throw new TypeError(
        "Failed to execute 'getComposedRanges' on 'Selection': " +
          "parameter is not of type 'ShadowRoot'.",
      );
    }
    roots.push(root);
  }
  return roots;
}

function composedSelectionRoots(options: any): any[] {
  if (options == null) return [];
  if (typeof options !== "object") {
    throw new TypeError(
      "Failed to execute 'getComposedRanges' on 'Selection': parameter is not an object.",
    );
  }
  return validateComposedShadowRoots(options.shadowRoots);
}

function selectionPaintBounds(composedRange: LiveRangeEntry | null, range: RangeImpl | null) {
  if (composedRange) return composedRange;
  if (range && !range.collapsed) return rangeBounds(range);
  return null;
}

function markSelectionLayoutDirty(): void {
  try {
    getInternalState().layoutDirtySinceRecord = true;
  } catch {}
}

function rangeBoundaryNodeId(node: NodeBase | null | undefined): number | null | undefined {
  return node && node._id;
}

function isCollapsedRangeBounds(bounds: RangeBounds<any>): boolean {
  return bounds.startContainer === bounds.endContainer && bounds.startOffset === bounds.endOffset;
}

function canSetDomSelection(
  domHandle: any,
  bounds: RangeBounds<any> | null,
): bounds is RangeBounds<any> {
  if (!bounds) return false;
  const startId = rangeBoundaryNodeId(bounds.startContainer);
  const endId = rangeBoundaryNodeId(bounds.endContainer);
  if (typeof startId !== "number") return false;
  if (typeof endId !== "number") return false;
  if (isCollapsedRangeBounds(bounds)) return false;
  return typeof domHandle.setDomSelection === "function";
}

function writeDomSelection(domHandle: any, bounds: RangeBounds<any> | null): boolean {
  if (canSetDomSelection(domHandle, bounds)) {
    const start = bounds.startContainer._id;
    const end = bounds.endContainer._id;
    domHandle.setDomSelection(start, bounds.startOffset, end, bounds.endOffset);
    return true;
  }
  if (typeof domHandle.clearDomSelection !== "function") return false;
  domHandle.clearDomSelection();
  return true;
}

function rangeContainsNode(
  range: RangeImpl,
  node: NodeBase,
  length: number,
  allowPartialContainment: boolean,
): boolean {
  const bounds = rangeBounds(range);
  if (allowPartialContainment) {
    const beforeEnd = compareBoundary(node, 0, bounds.endContainer, bounds.endOffset);
    const afterStart = compareBoundary(node, length, bounds.startContainer, bounds.startOffset);
    return beforeEnd < 0 && afterStart > 0;
  }
  const startsBeforeNode = compareBoundary(bounds.startContainer, bounds.startOffset, node, 0);
  const endsAfterNode = compareBoundary(node, length, bounds.endContainer, bounds.endOffset);
  return startsBeforeNode <= 0 && endsAfterNode <= 0;
}

type SelectionModifyAlter = "extend" | "move";
interface SelectionModifyInput {
  alter: SelectionModifyAlter;
  direction: string;
  granularity: string;
}

const VALID_SELECTION_MODIFY_GRANULARITIES = new Set([
  "character",
  "word",
  "lineboundary",
  "documentboundary",
  "line",
  "sentence",
  "paragraph",
  "sentenceboundary",
  "paragraphboundary",
]);
const SUPPORTED_SELECTION_MODIFY_GRANULARITIES = new Set([
  "character",
  "word",
  "lineboundary",
  "documentboundary",
]);
const VALID_SELECTION_MODIFY_DIRECTIONS = new Set(["forward", "backward", "left", "right"]);

function normalizeSelectionModifyValue(value: unknown): string {
  return String(value == null ? "" : value).toLowerCase();
}

function isSelectionModifyAlter(value: string): value is SelectionModifyAlter {
  return value === "extend" || value === "move";
}

function normalizeSelectionModifyInput(
  alter: unknown,
  direction: unknown,
  granularity: unknown,
): SelectionModifyInput | null {
  const normalizedAlter = normalizeSelectionModifyValue(alter);
  const normalizedDirection = normalizeSelectionModifyValue(direction);
  const normalizedGranularity = normalizeSelectionModifyValue(granularity);
  if (!isSelectionModifyAlter(normalizedAlter)) return null;
  if (!VALID_SELECTION_MODIFY_DIRECTIONS.has(normalizedDirection)) return null;
  if (!VALID_SELECTION_MODIFY_GRANULARITIES.has(normalizedGranularity)) return null;
  return {
    alter: normalizedAlter,
    direction: normalizedDirection,
    granularity: normalizedGranularity,
  };
}

function selectionMoveForward(direction: string, focusNode: any): boolean {
  if (direction === "forward") return true;
  if (direction === "backward") return false;
  const rtl = selDirectionAt(focusNode) === "rtl";
  return (direction === "right") !== rtl;
}

function moveSelectionTextPosition(
  run: any,
  position: number,
  granularity: string,
  forward: boolean,
): number {
  switch (granularity) {
    case "documentboundary":
      return forward ? run.text.length : 0;
    case "lineboundary":
      return selRunLineBoundary(run, position, forward);
    case "character":
      return forward ? Math.min(position + 1, run.text.length) : Math.max(position - 1, 0);
    default:
      return selRunWordBoundary(run, position, forward);
  }
}

function clampSelectionTextPosition(run: any, node: any, position: number): number {
  const host = selEditingHostOf(node);
  const extent = host && run.extents.get(host);
  return extent ? Math.min(Math.max(position, extent[0]), extent[1]) : position;
}

function selectionModifyPoint(
  run: any,
  node: any,
  offset: number,
  granularity: string,
  forward: boolean,
) {
  let position = selRunPositionOf(run, node, offset);
  if (position < 0) return null;
  position = moveSelectionTextPosition(run, position, granularity, forward);
  position = clampSelectionTextPosition(run, node, position);
  return selRunResolve(run, position, forward);
}

function hasRequiredStaticRangeMembers(bounds: RangeBounds): boolean {
  return (
    bounds.startContainer !== undefined &&
    bounds.endContainer !== undefined &&
    bounds.startOffset !== undefined &&
    bounds.endOffset !== undefined
  );
}

function hasStaticRangeContainers(bounds: RangeBounds): boolean {
  return !!bounds.startContainer && !!bounds.endContainer;
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
    if (hasComposedRange && !selComposedRootIsDocument(rangeBounds(range).startContainer)) {
      try {
        const updatedRange = new RangeImpl(document);
        updatedRange._setStartInternal(composedRange.startContainer, composedRange.startOffset);
        updatedRange._setEndInternal(composedRange.endContainer, composedRange.endOffset);
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

  #applyAnchorFocus(anchorNode: any, anchorOffset: number, focusNode: any, focusOffset: number) {
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

  #copyRangeToComposed(range: RangeImpl): void {
    const bounds = rangeBounds(range);
    this.#composed.startContainer = bounds.startContainer;
    this.#composed.startOffset = bounds.startOffset;
    this.#composed.endContainer = bounds.endContainer;
    this.#composed.endOffset = bounds.endOffset;
  }

  #copyChangedEndpointToComposed(range: RangeImpl, changedEndpoint: string): void {
    const bounds = rangeBounds(range);
    if (changedEndpoint === "start") {
      this.#composed.startContainer = bounds.startContainer;
      this.#composed.startOffset = bounds.startOffset;
      return;
    }
    this.#composed.endContainer = bounds.endContainer;
    this.#composed.endOffset = bounds.endOffset;
  }

  #collapseComposedEndpoints(changedEndpoint: string): void {
    const composedRange = this.#composed;
    const comparison = compareComposed(
      composedRange.startContainer,
      composedRange.startOffset,
      composedRange.endContainer,
      composedRange.endOffset,
    );
    if (comparison <= 0) return;
    if (changedEndpoint === "start") {
      composedRange.endContainer = composedRange.startContainer;
      composedRange.endOffset = composedRange.startOffset;
    } else {
      composedRange.startContainer = composedRange.endContainer;
      composedRange.startOffset = composedRange.endOffset;
    }
  }

  #syncComposedFromRange(changedEndpoint?: string) {
    const range = this.#range;
    if (!range) return;
    if (!this.#hasComposed() || !changedEndpoint) {
      this.#copyRangeToComposed(range);
      return;
    }
    this.#copyChangedEndpointToComposed(range, changedEndpoint);
    this.#collapseComposedEndpoints(changedEndpoint);
  }

  getComposedRanges(options?: any) {
    const roots = composedSelectionRoots(options);
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
      const domHandle: any = dom;
      if (!domHandle) return;
      markSelectionLayoutDirty();
      // Paint composed endpoints; a single-tree Range cannot represent a cross-shadow selection.
      const composedRange = this.#hasComposed() ? this.#composed : null;
      const bounds = selectionPaintBounds(composedRange, this.#range);
      if (!writeDomSelection(domHandle, bounds)) return;
      bumpMutationSeq("paint");
    } catch {}
  }

  addRange(range) {
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
  removeRange(range) {
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

  collapse(node, offset) {
    selAssertArgs(1, arguments.length, "collapse");
    if (node === null) {
      this.removeAllRanges();
      return;
    }
    selAssertNode(node, "collapse");
    const o = offset >>> 0;
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
  setPosition(node, offset) {
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

  extend(node, offset) {
    selAssertArgs(1, arguments.length, "extend");
    selAssertNode(node, "extend");
    const o = offset >>> 0;
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
    this.#applyAnchorFocus(anchorNode, anchorOffset, node, o);
  }

  setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset) {
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

  selectAllChildren(node) {
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

  containsNode(node, allowPartialContainment) {
    selAssertArgs(1, arguments.length, "containsNode");
    selAssertNode(node, "containsNode");
    const range = this.#live();
    if (!range) return false;
    if (!selComposedRootIsDocument(node)) return false;
    return rangeContainsNode(range, node, nodeLength(node), !!allowPartialContainment);
  }

  modify(alter, direction, granularity) {
    const input = normalizeSelectionModifyInput(alter, direction, granularity);
    if (!input) return;
    const point = this.#modifyPoint(input);
    if (!point) return;
    if (input.alter === "move") {
      this.#applyAnchorFocus(point[0], point[1], point[0], point[1]);
    } else {
      this.#applyAnchorFocus(this.anchorNode, this.anchorOffset, point[0], point[1]);
    }
  }

  #modifyPoint(input: SelectionModifyInput) {
    if (!this.#live()) return null;
    if (!SUPPORTED_SELECTION_MODIFY_GRANULARITIES.has(input.granularity)) return null;
    const focusNode = this.focusNode;
    const run = selBuildTextRun();
    if (!run) return null;
    const forward = selectionMoveForward(input.direction, focusNode);
    return selectionModifyPoint(run, focusNode, this.focusOffset, input.granularity, forward);
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

function assertStaticRangeDictionary(init: StaticRangeShimInit): void {
  if (init == null || typeof init !== "object") {
    throw new TypeError("StaticRange: argument must be a dictionary");
  }
}

function assertStaticRangeMembers(bounds: RangeBounds): void {
  if (!hasRequiredStaticRangeMembers(bounds)) {
    throw new TypeError("Failed to construct 'StaticRange': required member missing");
  }
  if (!hasStaticRangeContainers(bounds)) {
    throw new TypeError("StaticRange: startContainer and endContainer are required");
  }
}

function assertStaticRangeNotAttribute(node: BoundaryNode): void {
  if (node.nodeType === ATTRIBUTE_NODE) {
    throw new DOMException(
      "Failed to construct 'StaticRange': Attr nodes are not allowed as boundary container.",
      "InvalidNodeTypeError",
    );
  }
}

class StaticRangeImpl extends AbstractRangeImpl implements Idl.StaticRange {
  constructor(init: StaticRangeShimInit) {
    assertStaticRangeDictionary(init);
    const { startContainer, startOffset, endContainer, endOffset } = init;
    assertStaticRangeMembers({ startContainer, endContainer, startOffset, endOffset });
    rangeAssertNotDoctype(startContainer, "StaticRange");
    rangeAssertNotDoctype(endContainer, "StaticRange");
    assertStaticRangeNotAttribute(startContainer);
    assertStaticRangeNotAttribute(endContainer);
    super(ABSTRACT_RANGE_TOKEN, startContainer, startOffset >>> 0, endContainer, endOffset >>> 0);
  }
}

type RangeEndpoint = "start" | "end";

function rangeEndpointContainer(
  range: LiveRangeEntry,
  endpoint: RangeEndpoint,
): RangeBoundaryContainer | null {
  return endpoint === "start" ? range.startContainer : range.endContainer;
}

function rangeEndpointOffset(range: LiveRangeEntry, endpoint: RangeEndpoint): number {
  return endpoint === "start" ? range.startOffset : range.endOffset;
}

function setRangeEndpoint(
  range: LiveRangeEntry,
  endpoint: RangeEndpoint,
  node: RangeBoundaryContainer | null,
  offset: number,
): void {
  if (endpoint === "start") {
    range.startContainer = node;
    range.startOffset = offset;
  } else {
    range.endContainer = node;
    range.endOffset = offset;
  }
}

function shiftRangeEndpointAfterInsert(
  range: LiveRangeEntry,
  endpoint: RangeEndpoint,
  parent: RangeBoundaryContainer,
  refIndex: number,
  count: number,
): void {
  if (
    rangeEndpointContainer(range, endpoint) === parent &&
    rangeEndpointOffset(range, endpoint) > refIndex
  ) {
    setRangeEndpoint(range, endpoint, parent, rangeEndpointOffset(range, endpoint) + count);
  }
}

function rangeAfterInsert(parent: RangeBoundaryContainer, refIndex: number, count: number): void {
  if (liveRanges.size === 0) return;
  for (const range of liveRanges) {
    shiftRangeEndpointAfterInsert(range, "start", parent, refIndex, count);
    shiftRangeEndpointAfterInsert(range, "end", parent, refIndex, count);
  }
}

function rangeBeforeRemove(parent: RangeBoundaryContainer, index: number, child: NodeBase): void {
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

function adjustEndpointBeforeReplaceData(
  range: LiveRangeEntry,
  endpoint: RangeEndpoint,
  node: NodeBase,
  offset: number,
  cutEnd: number,
  delta: number,
): void {
  if (rangeEndpointContainer(range, endpoint) !== node) return;
  const pointOffset = rangeEndpointOffset(range, endpoint);
  if (pointOffset > offset && pointOffset <= cutEnd) {
    setRangeEndpoint(range, endpoint, node, offset);
    return;
  }
  if (pointOffset > cutEnd) setRangeEndpoint(range, endpoint, node, pointOffset + delta);
}

function rangeBeforeReplaceData(
  node: NodeBase,
  offset: number,
  count: number,
  insertedLength: number,
): void {
  if (liveRanges.size === 0) return;
  const delta = insertedLength - count;
  const cutEnd = offset + count;
  for (const range of liveRanges) {
    adjustEndpointBeforeReplaceData(range, "start", node, offset, cutEnd, delta);
    adjustEndpointBeforeReplaceData(range, "end", node, offset, cutEnd, delta);
  }
}

function moveEndpointAfterTextSplit(
  range: LiveRangeEntry,
  endpoint: RangeEndpoint,
  node: NodeBase,
  offset: number,
  newNode: NodeBase,
): boolean {
  if (rangeEndpointContainer(range, endpoint) !== node) return false;
  const pointOffset = rangeEndpointOffset(range, endpoint);
  if (pointOffset <= offset) return false;
  setRangeEndpoint(range, endpoint, newNode, pointOffset - offset);
  return true;
}

function shiftEndpointAtSplitInsertion(
  range: LiveRangeEntry,
  endpoint: RangeEndpoint,
  parent: NodeBase,
  newIdx: number,
): void {
  if (rangeEndpointContainer(range, endpoint) !== parent) return;
  const pointOffset = rangeEndpointOffset(range, endpoint);
  if (pointOffset === newIdx) setRangeEndpoint(range, endpoint, parent, pointOffset + 1);
}

function clampEndpointWithoutSplitParent(
  range: LiveRangeEntry,
  endpoint: RangeEndpoint,
  node: NodeBase,
  offset: number,
): void {
  if (rangeEndpointContainer(range, endpoint) !== node) return;
  if (rangeEndpointOffset(range, endpoint) > offset)
    setRangeEndpoint(range, endpoint, node, offset);
}

function adjustEndpointAfterTextSplit(
  range: LiveRangeEntry,
  endpoint: RangeEndpoint,
  node: NodeBase,
  offset: number,
  newNode: NodeBase,
  parent: NodeBase | null,
  newIdx: number,
): void {
  if (!parent) {
    clampEndpointWithoutSplitParent(range, endpoint, node, offset);
    return;
  }
  if (moveEndpointAfterTextSplit(range, endpoint, node, offset, newNode)) return;
  shiftEndpointAtSplitInsertion(range, endpoint, parent, newIdx);
}

function rangeAfterSplitText(node: NodeBase, offset: number, newNode: NodeBase): void {
  if (liveRanges.size === 0) return;
  const parent = node.parentNode || null;
  const newIdx = parent ? nodeIndexOf(newNode) : -1;
  for (const range of liveRanges) {
    adjustEndpointAfterTextSplit(range, "start", node, offset, newNode, parent, newIdx);
    adjustEndpointAfterTextSplit(range, "end", node, offset, newNode, parent, newIdx);
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
