// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements node wrappers, tree mutations, cloning, and text operations over the wasm DOM.

import type * as Idl from "./idl/types.generated.js";
import {
  ksGlobal,
  dom,
  documentImpl as document,
  liveDocument,
  windowObj,
  pageUrl,
  nodeFor,
  makeNodeList,
  runCloneSteps,
  runCloneStepsDeep,
  nextSyntheticId,
  shadowRootModes,
  fastpathMarkSpecial,
  createElementInternal,
  createElementNSInternal,
  createTextNodeInternal,
} from "./state.js";
import { recordOp, recordCdpMutation } from "./record.js";
import {
  nodeIndexOf,
  childArray,
  rangeAfterInsert,
  rangeBeforeRemove,
  rangeBeforeReplaceData,
  rangeAfterSplitText,
} from "./range.js";
import { runIteratorPreRemove } from "./traversal.js";
import { ksSpan } from "./otel.js";
import { stampConnectedNamedGlobals } from "./window.js";
import {
  cache,
  hasLiveWrapper,
  forgetNodeIds,
  adoptedWrapperIds,
  elemNs,
  hostIdToDoc,
  nodeOwnerDoc,
  syntheticParent,
  fragmentIds,
  templateContentFragment,
  stampedPiIds,
  commentData,
  nodeListCache,
} from "./registries.js";
import { getInternalState } from "./internal-state.js";
import type { DocumentFragmentImpl } from "./collections.js";
import type { Element } from "./element/element.js";
import {
  ELEMENT_NODE,
  ATTRIBUTE_NODE,
  TEXT_NODE,
  CDATA_SECTION_NODE,
  ENTITY_REFERENCE_NODE,
  ENTITY_NODE,
  PROCESSING_INSTRUCTION_NODE,
  COMMENT_NODE,
  DOCUMENT_NODE,
  DOCTYPE_NODE,
  DOCUMENT_FRAGMENT_NODE,
  NOTATION_NODE,
  DOCUMENT_POSITION_DISCONNECTED,
  DOCUMENT_POSITION_PRECEDING,
  DOCUMENT_POSITION_FOLLOWING,
  DOCUMENT_POSITION_CONTAINS,
  DOCUMENT_POSITION_CONTAINED_BY,
  DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC,
  HTML_NS,
  MAX_NODE_ANCESTOR_HOPS,
  notSupported,
} from "./constants.js";
import { XML_NS, XMLNS_NS } from "./util/validation.js";
import { bumpMutationSeq } from "./mutations/seq.js";
import {
  recordChildListMutation,
  recordCharacterDataMutation,
  suppressChildListMutations,
  notifyIframeRemoves,
  notifySubtreeInserts,
  hasChildListObserver,
  hasSubtreeObserver,
  registerTransientObservers,
} from "./mutations/observer.js";
import { addListener, removeListener } from "./events/dispatch.js";
import { dispatchOnKey } from "./events/dispatch.js";
import { maybeScheduleSlotchange } from "./events/slotchange.js";

const MAX_CONNECTED_NODE_ANCESTOR_HOPS = 8192;

function notifyConnectedCallbacks(child: any): void {
  const hook = ksGlobal.__ks_notifyConnected;
  if (typeof hook === "function") {
    try {
      hook(child);
    } catch {}
  }
}

function ksState() {
  return getInternalState();
}

export function adoptIntoDom(destDom: any, wrapper: any, destOwnerDoc?: any): void {
  if (!shouldAdoptIntoDom(destDom, wrapper)) return;
  const sourceDom = wrapper._dom;
  const sourceId = wrapper._id;
  const info = adoptionNodeInfo(sourceDom, sourceId);
  if (!info) return;
  const newId = createAdoptedNode(sourceDom, destDom, sourceId, info);
  if (newId === undefined) return;
  finishAdoption(destDom, wrapper, destOwnerDoc, newId);
}

function finishAdoption(destDom: any, wrapper: any, destOwnerDoc: any, newId: number): void {
  wrapper._dom = destDom;
  wrapper._id = newId;
  if (destDom === dom) adoptedWrapperIds.add(newId);
  if (destOwnerDoc !== undefined) wrapper.ownerDocument = destOwnerDoc;
}

function shouldAdoptIntoDom(destDom: any, wrapper: any): boolean {
  return !!wrapper && !!wrapper._dom && wrapper._dom !== destDom;
}

function adoptionNodeInfo(sourceDom: any, sourceId: number) {
  try {
    return sourceDom.nodeInfo(sourceId);
  } catch {
    return null;
  }
}

function createAdoptedElement(sourceDom: any, destDom: any, sourceId: number, info: any) {
  const tag = (info.nodeName || "DIV").toLowerCase();
  let newId;
  try {
    newId = destDom.createElement(tag);
  } catch {
    return undefined;
  }
  const attrs = parsedAttrs(sourceDom, sourceId);
  for (const attr of attrs) {
    try {
      destDom.setAttribute(newId, attr.name, attr.value);
    } catch {}
  }
  return newId;
}

function createAdoptedText(sourceDom: any, destDom: any, sourceId: number) {
  let text = "";
  try {
    text = sourceDom.textContent(sourceId) || "";
  } catch {}
  try {
    return destDom.createTextNode(text);
  } catch {
    return undefined;
  }
}

function createAdoptedNode(sourceDom: any, destDom: any, sourceId: number, info: any) {
  if (info.nodeType === ELEMENT_NODE) {
    return createAdoptedElement(sourceDom, destDom, sourceId, info);
  }
  if (info.nodeType === TEXT_NODE) return createAdoptedText(sourceDom, destDom, sourceId);
  return undefined;
}

export function parsedAttrs(handle: any, id: number): Array<{ name: string; value: string }> {
  const info = attrsNodeInfo(handle, id);
  if (!info || !Array.isArray(info.attributes)) return [];
  return parsedAttributePairs(info.attributes);
}

function attrsNodeInfo(handle: any, id: number) {
  try {
    return handle.nodeInfo(id);
  } catch {
    return null;
  }
}

function parsedAttributePairs(attributes: unknown[]): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  for (let i = 0; i < attributes.length - 1; i += 2) {
    const name = attributes[i];
    const value = attributes[i + 1];
    if (typeof name === "string" && typeof value === "string") {
      out.push({ name, value });
    }
  }
  return out;
}

function validCloneIds(sourceId: number, cloneId: number): boolean {
  return typeof sourceId === "number" && typeof cloneId === "number";
}

type CloneNodeInfo = ReturnType<typeof dom.nodeInfo>;
type CloneNodeInfos = { source: CloneNodeInfo; clone: CloneNodeInfo };

function cloneNodeInfos(sourceId: number, cloneId: number): CloneNodeInfos | null {
  let source: CloneNodeInfo;
  try {
    source = (dom as any).nodeInfo(sourceId);
  } catch {
    return null;
  }
  let clone: CloneNodeInfo;
  try {
    clone = (dom as any).nodeInfo(cloneId);
  } catch {
    return null;
  }
  if (!source || !clone) return null;
  return { source, clone };
}

function cloneChildIds(id: number): number[] {
  let children: number[] = [];
  try {
    children = (dom as any).childIds ? (dom as any).childIds(id) : [];
  } catch {}
  return children;
}

function copyCloneChildren(
  sourceId: number,
  cloneId: number,
  copy: (sourceChildId: number, cloneChildId: number) => void,
): void {
  const sourceChildren = cloneChildIds(sourceId);
  const cloneChildren = cloneChildIds(cloneId);
  const count = Math.min(cloneChildCount(sourceChildren), cloneChildCount(cloneChildren));
  for (let i = 0; i < count; i++) copy(sourceChildren[i], cloneChildren[i]);
}

function cloneChildCount(children: number[] | null | undefined): number {
  return children?.length || 0;
}

function copyCloneCommentData(sourceId: number, cloneId: number): void {
  const text = commentData.get(sourceId) ?? "";
  commentData.set(cloneId, text);
  try {
    if ((dom as any).setCommentData) (dom as any).setCommentData(cloneId, text);
  } catch {}
}

function copyCommentDataToClone(sourceId: number, cloneId: number): void {
  if (!validCloneIds(sourceId, cloneId)) return;
  const infos = cloneNodeInfos(sourceId, cloneId);
  if (!infos) return;
  if (infos.source.nodeType === COMMENT_NODE) {
    copyCloneCommentData(sourceId, cloneId);
  }
  copyCloneChildren(sourceId, cloneId, copyCommentDataToClone);
}

function copyCloneElementNamespace(sourceId: number, cloneId: number): void {
  const entry = elemNs.get(sourceId);
  if (!entry) return;
  elemNs.set(cloneId, { qname: entry.qname, ns: entry.ns, viaNS: entry.viaNS });
  if (entry.viaNS !== false) fastpathMarkSpecial(cloneId);
}

function copyElemNsToClone(sourceId: number, cloneId: number): void {
  if (!validCloneIds(sourceId, cloneId)) return;
  copyCloneElementNamespace(sourceId, cloneId);
  copyCloneChildren(sourceId, cloneId, copyElemNsToClone);
}

function hasCachedWrapper(nodeId: number): boolean {
  return hasLiveWrapper(nodeId) || adoptedWrapperIds.has(nodeId);
}

function unwrappedDescendantIds(nodeId: number): number[] | null {
  try {
    if (typeof dom.descendantsOf !== "function") return null;
    return Array.from(dom.descendantsOf(nodeId)) as number[];
  } catch {
    return null;
  }
}

function unwrappedSubtreeIds(nodeId: number): number[] | null {
  if (hasCachedWrapper(nodeId)) return null;
  try {
    const descendants = unwrappedDescendantIds(nodeId);
    if (!descendants || descendants.some(hasCachedWrapper)) return null;
    descendants.push(nodeId);
    return descendants;
  } catch {
    return null;
  }
}

export function subtreeHasCachedWrapper(nodeId: number): boolean {
  return unwrappedSubtreeIds(nodeId) === null;
}

function dropUnwrappedSubtree(nodeId: number): boolean {
  if (nodeId < 0 || typeof dom.dropNode !== "function") return false;
  const droppedIds = unwrappedSubtreeIds(nodeId);
  if (!droppedIds || !dom.dropNode(nodeId)) return false;
  forgetNodeIds(droppedIds);
  return true;
}

/** Drops only subtrees with no cached or adopted wrapper; other nodes remain detached. */
export function dropUnwrappedSubtrees(nodeIds: Iterable<number>): number {
  let dropped = 0;
  for (const nodeId of nodeIds) if (dropUnwrappedSubtree(nodeId)) dropped++;
  return dropped;
}

function textContentNodeInfo(id: number) {
  try {
    return dom.nodeInfo(id);
  } catch {
    return null;
  }
}

function isTextContentContainer(info: any): boolean {
  return info.nodeType === ELEMENT_NODE || info.nodeType === DOCUMENT_FRAGMENT_NODE;
}

function textContentNodeValue(info: any): string {
  return info.nodeValue || "";
}

function addTextContentChildren(id: number, stack: number[]): void {
  const kids = Array.from(dom.childIds(id));
  for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
}

function collectTextContentNodeValue(id: number, info: any, stack: number[]): string {
  if (!info) return "";
  if (info.nodeType === TEXT_NODE) return textContentNodeValue(info);
  if (!isTextContentContainer(info)) return "";
  addTextContentChildren(id, stack);
  return "";
}

function collectTextContent(rootId): string {
  let out = "";
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    if (id == null || id < 0) continue;
    if (stampedPiIds.has(id)) continue;
    const info = textContentNodeInfo(id);
    out += collectTextContentNodeValue(id, info, stack);
  }
  return out;
}
function toUint32(v): number {
  return v >>> 0;
}

function isObjectOrFunction(value: unknown): value is object {
  return typeof value === "object" || typeof value === "function";
}

function hasNodeIdOrType(value: object): boolean {
  return (
    typeof Reflect.get(value, "_id") === "number" ||
    typeof Reflect.get(value, "nodeType") === "number"
  );
}

type NodeLikeInput = {
  readonly _id?: unknown;
  readonly nodeType?: unknown;
  readonly childNodes?: Iterable<unknown> | null;
};

function isNodeLike(v: unknown): v is NodeLikeInput {
  if (v == null) return false;
  if (!isObjectOrFunction(v)) return false;
  return hasNodeIdOrType(v);
}

function assertNotDocumentChild(child, op): void {
  if (!child) return;
  let nt;
  try {
    nt = child.nodeType;
  } catch {
    return;
  }
  if (nt === DOCUMENT_NODE) {
    throw new DOMException(op + ": cannot insert a Document node", "HierarchyRequestError");
  }
}

type NodeTypeRead = { ok: true; value: unknown } | { ok: false };

function readUnknownNodeType(node: unknown): unknown {
  if (!node) return node;
  return Reflect.get(Object(node), "nodeType");
}

function tryReadNodeType(node: unknown): NodeTypeRead {
  if (node == null) return { ok: false };
  try {
    return { ok: true, value: readUnknownNodeType(node) };
  } catch {
    return { ok: false };
  }
}

function isHostDocumentStandIn(parent: NodeBase): boolean {
  return typeof parent._id === "number" && hostIdToDoc.has(parent._id);
}

function documentTargetForElementCheck(parent: NodeBase): { doc: any } | null {
  const parentType = tryReadNodeType(parent);
  if (!parentType.ok) return null;
  const host = isHostDocumentStandIn(parent);
  if (parentType.value !== DOCUMENT_NODE && !host) return null;
  return { doc: host ? hostIdToDoc.get(parent._id) : parent };
}

function isElementNode(node: unknown): boolean {
  const nodeType = tryReadNodeType(node);
  return nodeType.ok && nodeType.value === ELEMENT_NODE;
}

function isOtherDocumentElement(child: unknown, newChild: unknown): boolean {
  return !!child && readUnknownNodeType(child) === ELEMENT_NODE && child !== newChild;
}

function assertNoExistingDocumentElement(doc: NodeBase, newChild: unknown, op: string): void {
  let existing = 0;
  try {
    const kids = doc.childNodes;
    for (let i = 0; i < kids.length; i++) {
      if (isOtherDocumentElement(kids[i], newChild)) existing++;
    }
  } catch {
    return;
  }
  if (existing >= 1) {
    throw new DOMException(
      op + ": Document can only have one Element child",
      "HierarchyRequestError",
    );
  }
}

function assertOneElementChild(parent: NodeBase, newChild: unknown, op: string): void {
  if (!newChild) return;
  const target = documentTargetForElementCheck(parent);
  if (!target) return;
  if (!isElementNode(newChild)) return;
  assertNoExistingDocumentElement(target.doc, newChild, op);
}

function isHierarchyRequestError(error: unknown) {
  // Fragment validation rethrows only wrapper errors named HierarchyRequestError.
  return !!error && (error as { name?: unknown }).name === "HierarchyRequestError";
}

interface DocumentChildCounts {
  elements: number;
  doctypes: number;
}

function isDocumentTextNodeType(nodeType: unknown): boolean {
  return nodeType === TEXT_NODE || nodeType === CDATA_SECTION_NODE;
}

function countDocumentChildType(counts: DocumentChildCounts, nodeType: unknown): void {
  if (nodeType === ELEMENT_NODE) counts.elements++;
  else if (nodeType === DOCTYPE_NODE) counts.doctypes++;
}

function countFragmentDocumentChild(counts: DocumentChildCounts, child: unknown, op: string): void {
  const nodeType = readUnknownNodeType(child);
  if (isDocumentTextNodeType(nodeType)) {
    throw new DOMException(
      op + ": Document cannot have a Text node child",
      "HierarchyRequestError",
    );
  }
  countDocumentChildType(counts, nodeType);
}

function fragmentDocumentChildCounts(fragment: NodeLikeInput, op: string) {
  const counts = { elements: 0, doctypes: 0 };
  try {
    const children = fragment.childNodes;
    if (!children) return counts;
    for (const child of children) countFragmentDocumentChild(counts, child, op);
  } catch (error) {
    if (isHierarchyRequestError(error)) throw error;
  }
  return counts;
}

function countExistingDocumentChildren(doc: Pick<Idl.Node, "childNodes">): DocumentChildCounts {
  const counts = { elements: 0, doctypes: 0 };
  for (const child of doc.childNodes) {
    const nodeType = readUnknownNodeType(child);
    countDocumentChildType(counts, nodeType);
  }
  return counts;
}

function invalidDocumentTextChild(op: string): never {
  throw new DOMException(op + ": Document cannot have a Text node child", "HierarchyRequestError");
}

function countIncomingDocumentChild(node: unknown, op: string): DocumentChildCounts {
  if (!isNodeLike(node)) invalidDocumentTextChild(op);
  const nodeType = node.nodeType;
  if (isDocumentTextNodeType(nodeType)) invalidDocumentTextChild(op);
  if (nodeType === DOCUMENT_FRAGMENT_NODE) return fragmentDocumentChildCounts(node, op);
  const counts = { elements: 0, doctypes: 0 };
  countDocumentChildType(counts, nodeType);
  return counts;
}

function addDocumentChildCounts(total: DocumentChildCounts, next: DocumentChildCounts): void {
  total.elements += next.elements;
  total.doctypes += next.doctypes;
}

function countIncomingDocumentChildren(nodes: readonly unknown[], op: string): DocumentChildCounts {
  const counts = { elements: 0, doctypes: 0 };
  for (const node of nodes) addDocumentChildCounts(counts, countIncomingDocumentChild(node, op));
  return counts;
}

function assertDocumentChildCounts(
  existing: DocumentChildCounts,
  incoming: DocumentChildCounts,
  op: string,
): void {
  if (existing.elements + incoming.elements > 1) {
    throw new DOMException(
      op + ": Document can only have one Element child",
      "HierarchyRequestError",
    );
  }
  if (existing.doctypes + incoming.doctypes > 1) {
    throw new DOMException(
      op + ": Document can only have one DocumentType child",
      "HierarchyRequestError",
    );
  }
}

function doctypeWouldFollowElement(
  atFront: boolean,
  incomingDoctypes: number,
  existingElements: number,
): boolean {
  return !atFront && incomingDoctypes > 0 && existingElements > 0;
}

function elementWouldPrecedeDoctype(
  atFront: boolean,
  incomingElements: number,
  existingDoctypes: number,
): boolean {
  return atFront && incomingElements > 0 && existingDoctypes > 0;
}

function assertDocumentDoctypeInsertionOrder(
  existing: DocumentChildCounts,
  incoming: DocumentChildCounts,
  atFront: boolean,
  op: string,
): void {
  if (doctypeWouldFollowElement(atFront, incoming.doctypes, existing.elements)) {
    throw new DOMException(op + ": Document doctype must precede element", "HierarchyRequestError");
  }
  if (elementWouldPrecedeDoctype(atFront, incoming.elements, existing.doctypes)) {
    throw new DOMException(op + ": Document doctype must precede element", "HierarchyRequestError");
  }
}

function assertDocumentInsertAllowed(
  doc: Pick<Idl.Node, "childNodes">,
  nodes: readonly unknown[],
  op: string,
  atFront: boolean,
  ignoreExisting?: boolean,
): void {
  const existing = ignoreExisting
    ? { elements: 0, doctypes: 0 }
    : countExistingDocumentChildren(doc);
  const incoming = countIncomingDocumentChildren(nodes, op);
  assertDocumentChildCounts(existing, incoming, op);
  if (!ignoreExisting) {
    assertDocumentDoctypeInsertionOrder(existing, incoming, atFront, op);
  }
}

function assertDoctypeParent(parent: NodeBase, op: string): void {
  const parentType = tryReadNodeType(parent);
  if (!parentType.ok) return;
  const isHostStandIn = isHostDocumentStandIn(parent);
  if (parentType.value !== DOCUMENT_NODE && !isHostStandIn) {
    throw new DOMException(
      op + ": doctype must be inserted into a document",
      "HierarchyRequestError",
    );
  }
}

function assertDoctypeOnlyInDocument(parent: NodeBase, child: unknown, op: string): void {
  if (!child) return;
  const childType = tryReadNodeType(child);
  if (!childType.ok) return;
  if (childType.value !== DOCTYPE_NODE) return;
  assertDoctypeParent(parent, op);
}

function isDocumentParent(parent: NodeBase): boolean {
  const parentType = tryReadNodeType(parent);
  if (!parentType.ok) return false;
  const isHostStandIn = isHostDocumentStandIn(parent);
  return parentType.value === DOCUMENT_NODE || isHostStandIn;
}

function assertNotTextIntoDocument(parent: NodeBase, child: unknown, op: string): void {
  if (!child) return;
  if (!isDocumentParent(parent)) return;
  const childType = tryReadNodeType(child);
  if (!childType.ok) return;
  if (childType.value === TEXT_NODE) {
    throw new DOMException(
      op + ": cannot insert a Text node directly under a document",
      "HierarchyRequestError",
    );
  }
}

type NodeWithOptionalDom = NodeBase & { _dom?: unknown };

function nodesShareDom(node: NodeWithOptionalDom, cur: NodeWithOptionalDom): boolean {
  return !node._dom || !cur._dom || node._dom === cur._dom;
}

function isInclusiveAncestorCandidate(
  node: NodeWithOptionalDom,
  nodeId: number | null,
  cur: NodeWithOptionalDom,
): boolean {
  const sharesDom = nodesShareDom(node, cur);
  if (nodeId !== null && typeof cur._id === "number" && sharesDom) {
    return cur._id === nodeId;
  }
  return cur === node;
}

function assertNotAncestor(
  parent: NodeWithOptionalDom,
  node: NodeWithOptionalDom | null,
  op: string,
): void {
  if (!node) return;
  const nodeId = typeof node._id === "number" ? node._id : null;
  let cur = parent;
  while (cur) {
    if (isInclusiveAncestorCandidate(node, nodeId, cur)) {
      throw new DOMException(
        op + ": new child is an inclusive ancestor of parent",
        "HierarchyRequestError",
      );
    }
    cur = cur.parentNode;
  }
}

const LEAF_PARENT_TYPES = new Set<number>([
  TEXT_NODE,
  CDATA_SECTION_NODE,
  PROCESSING_INSTRUCTION_NODE,
  COMMENT_NODE,
  DOCTYPE_NODE,
]);

function safeReferenceId(parentId: number, referenceId: number) {
  if (referenceId === 0) return 0;
  try {
    return dom.parentId(referenceId) === parentId ? referenceId : 0;
  } catch {
    return 0;
  }
}

function assertCanHaveChildren(self: NodeBase, op: string): void {
  const nodeType = childParentNodeType(self);
  if (!isLeafParentType(nodeType)) return;
  const name = childlessNodeName(self);
  throw new DOMException(op + ": " + name + " nodes cannot have children", "HierarchyRequestError");
}

function childParentNodeType(self: NodeBase): unknown {
  let nodeType;
  try {
    nodeType = self.nodeType;
  } catch {
    nodeType = undefined;
  }
  if (typeof nodeType !== "number") nodeType = self._info && self._info.nodeType;
  return nodeType;
}

function isLeafParentType(nodeType: unknown): boolean {
  return typeof nodeType === "number" && LEAF_PARENT_TYPES.has(nodeType);
}

function childlessNodeName(self: NodeBase): string {
  return self.nodeName || (self._info && self._info.nodeName) || "leaf";
}

function isTemplateNodeId(id: unknown): id is number {
  return typeof id === "number" && id >= 0;
}

function templateNodeInfo(id: number) {
  try {
    return dom.nodeInfo(id);
  } catch {
    return null;
  }
}

function hasTemplateElementInfo(info: ReturnType<typeof dom.nodeInfo> | null): boolean {
  return !!info && info.nodeType === ELEMENT_NODE;
}

function hasTemplateTagName(tag: string): boolean {
  return tag === "TEMPLATE" || tag === "template";
}

function hasHtmlTemplateNamespace(ns: ReturnType<typeof elemNs.get>): boolean {
  return !ns || !ns.ns || ns.ns === HTML_NS;
}

function isTemplateElement(id: unknown): boolean {
  if (!isTemplateNodeId(id)) return false;
  const info = templateNodeInfo(id);
  if (!hasTemplateElementInfo(info)) return false;
  if (!hasTemplateTagName(info.nodeName)) return false;
  if (!hasHtmlTemplateNamespace(elemNs.get(id))) return false;
  return true;
}

const TEMPLATE_CONTENT_FRAGMENT_TAG = "#document-fragment";

function templateChildIds(templateId: number): number[] {
  try {
    return Array.from(dom.childIds(templateId));
  } catch {
    return [];
  }
}

function moveTemplateChildren(fragmentId: number, kids: number[]): void {
  for (const kidId of kids) {
    try {
      dom.removeNode(kidId);
    } catch {}
    try {
      dom.appendChildNode(fragmentId, kidId);
    } catch {}
  }
}

function ensureTemplateContent(templateId: number): DocumentFragmentImpl {
  let frag = templateContentFragment.get(templateId);
  if (frag) return frag;
  // The backing tag lets Rust keep template contents inert, unlike other detached elements.
  const fragId = dom.createElement(TEMPLATE_CONTENT_FRAGMENT_TAG);
  fragmentIds.add(fragId);
  frag = nodeFor(fragId) as DocumentFragmentImpl;
  templateContentFragment.set(templateId, frag);
  const kids = templateChildIds(templateId);
  moveTemplateChildren(fragId, kids);
  if (kids.length > 0) {
    bumpMutationSeq();
  }
  return frag;
}
function eventTargetKey(target: KsEventTarget): any {
  const id = target._id;
  return typeof id === "number" ? id : target;
}
class KsEventTarget implements Idl.EventTarget {
  declare _id?: number;
  addEventListener(
    type: string,
    listener: Idl.EventListener | null,
    options?: Idl.AddEventListenerOptions | boolean,
  ): void {
    if (arguments.length < 2) {
      throw new TypeError(
        "Failed to execute 'addEventListener' on 'EventTarget': 2 arguments required, but only " +
          arguments.length +
          " present.",
      );
    }
    addListener(eventTargetKey(this), type, listener, options);
  }
  removeEventListener(
    type: string,
    listener: Idl.EventListener | null,
    options?: Idl.EventListenerOptions | boolean,
  ): void {
    if (arguments.length < 2) {
      throw new TypeError(
        "Failed to execute 'removeEventListener' on 'EventTarget': 2 arguments required, but only " +
          arguments.length +
          " present.",
      );
    }
    removeListener(eventTargetKey(this), type, listener, options);
  }
  dispatchEvent(event: Idl.Event): boolean {
    return dispatchOnKey(() => eventTargetKey(this), event);
  }
}

function parentChildArray(node: NodeBase): ArrayLike<NodeBase> | null {
  const parent = node.parentNode;
  return parent ? childArray(parent) : null;
}
function indexById(kids: ArrayLike<NodeBase>, id: number): number {
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i];
    if (c && c._id === id) return i;
  }
  return -1;
}

type NodeCloneValue = ReturnType<typeof nodeFor>;
type NodeCloneResult = { earlyReturn: boolean; node: NodeCloneValue | null };

function cloneProcessingInstruction(node: NodeBase): Idl.ProcessingInstruction {
  const target = (node as any).target || node.nodeName || "";
  return node.ownerDocument.createProcessingInstruction(target, node.data ?? "");
}

function cloneNodeDeep(node: NodeBase): NodeCloneResult {
  const id = dom.deepCloneNode(node._id);
  if (id === 0) return { earlyReturn: true, node: null };
  try {
    copyCommentDataToClone(node._id, id);
  } catch {}
  try {
    copyElemNsToClone(node._id, id);
  } catch {}
  return { earlyReturn: false, node: nodeFor(id) };
}

function cloneNodeElementShell(node: NodeBase): Element {
  const nsEntry = elemNs.get(node._id);
  if (nsEntry && nsEntry.viaNS !== false) {
    return createElementNSInternal(nsEntry.ns, nsEntry.qname);
  }
  const tag = node._info.localName || node._info.nodeName || "div";
  return createElementInternal(tag);
}

function copyNodeElementAttributes(node: NodeBase, clone: Element): void {
  const attrs = node._attrFlat ? node._attrFlat() : [];
  for (let i = 0; i < attrs.length - 1; i += 2) {
    try {
      clone.setAttribute(attrs[i], attrs[i + 1]);
    } catch {}
  }
}

function cloneNodeShallowElement(node: NodeBase): Element {
  const clone = cloneNodeElementShell(node);
  copyNodeElementAttributes(node, clone);
  return clone;
}

function cloneNodeFromWasm(node: NodeBase): NodeCloneResult {
  const id = dom.deepCloneNode(node._id);
  if (id === 0) return { earlyReturn: true, node: null };
  return { earlyReturn: false, node: nodeFor(id) };
}

const SHALLOW_NODE_CLONERS: Partial<Record<number, (node: NodeBase) => NodeCloneResult>> = {
  [TEXT_NODE]: (node) => ({
    earlyReturn: false,
    node: createTextNodeInternal(node.data ?? node._info.nodeValue ?? ""),
  }),
  [COMMENT_NODE]: (node) => ({
    earlyReturn: false,
    node: liveDocument().createComment(node.data ?? ""),
  }),
  [PROCESSING_INSTRUCTION_NODE]: (node) => ({
    earlyReturn: false,
    node: cloneProcessingInstruction(node),
  }),
  [ELEMENT_NODE]: (node) => ({
    earlyReturn: false,
    node: cloneNodeShallowElement(node),
  }),
};

function cloneNodeShallow(node: NodeBase): NodeCloneResult {
  const nodeType = node._info && node._info.nodeType;
  return SHALLOW_NODE_CLONERS[nodeType]?.(node) ?? cloneNodeFromWasm(node);
}

type TextContentRemoval = { existing: NodeBase[]; removedIds: number[] };
type TextContentAddition = { nodes: NodeBase[]; id: number };
type NormalizationChildren = Array<NodeBase | null>;

function setSyntheticTextContent(node: NodeBase, value: unknown): void {
  const text = String(value ?? "");
  if (node._info) node._info.nodeValue = text;
}

function textContentChildIds(nodeId: number): number[] {
  return dom.childIds ? Array.from(dom.childIds(nodeId)) : [];
}

function removeTextContentChildren(
  node: NodeBase,
  rawIds: number[],
  observed: boolean,
  transientlyObserved: boolean,
): TextContentRemoval {
  const existing: NodeBase[] = [];
  const removedIds: number[] = [];
  for (const childId of rawIds) {
    removedIds.push(childId);
    const child = removeTextContentChild(childId, observed, transientlyObserved);
    if (child) existing.push(child);
  }
  return { existing, removedIds };
}

function removeTextContentChild(
  childId: number,
  observed: boolean,
  transientlyObserved: boolean,
): NodeBase | null {
  // Keep wrapped removed nodes when a child-list observer needs them in its record.
  if (!observed && dropUnwrappedSubtree(childId)) return null;
  if (transientlyObserved) registerTransientObservers(childId);
  const child = nodeFor(childId);
  if (!child) return null;
  runIteratorPreRemove(child);
  dom.removeNode(child._id);
  return child;
}

function includeObservedSyntheticChildren(
  node: NodeBase,
  existing: NodeBase[],
  observed: boolean,
): void {
  if (!observed) return;
  for (const child of Array.from<any>(node.childNodes)) {
    if (typeof child._id === "number" && child._id < 0) existing.push(child);
  }
}

function createTextContentChild(
  node: NodeBase,
  text: string,
  observed: boolean,
): TextContentAddition {
  if (text.length === 0) return { nodes: [], id: -1 };
  const id = dom.createTextNode(text);
  dom.appendChildNode(node._id, id);
  if (!observed) return { nodes: [], id };
  const child = nodeFor(id);
  return { nodes: child ? [child] : [], id };
}

function recordRemovedTextContentNodes(node: NodeBase, removedIds: number[]): void {
  for (const childId of removedIds) {
    recordCdpMutation({ kind: "childNodeRemoved", parentNodeId: node._id, nodeId: childId });
  }
}

function recordAddedTextContentNode(node: NodeBase, addedId: number): void {
  if (addedId >= 0) {
    recordCdpMutation({
      kind: "childNodeInserted",
      parentNodeId: node._id,
      previousNodeId: 0,
      nodeId: addedId,
    });
  }
}

function recordObservedTextContentChildren(
  node: NodeBase,
  observed: boolean,
  added: NodeBase[],
  existing: NodeBase[],
): void {
  if (observed && (existing.length > 0 || added.length > 0)) {
    recordChildListMutation(node, added, existing, null, null);
  }
}

function recordTextContentMutations(
  node: NodeBase,
  removedIds: number[],
  addedId: number,
  observed: boolean,
  added: NodeBase[],
  existing: NodeBase[],
): void {
  recordRemovedTextContentNodes(node, removedIds);
  recordAddedTextContentNode(node, addedId);
  recordObservedTextContentChildren(node, observed, added, existing);
}

function setNodeTextContent(node: NodeBase, value: unknown): void {
  if (node._id < 0) {
    setSyntheticTextContent(node, value);
    return;
  }
  const text = String(value ?? "");
  const observed = hasChildListObserver(node._id);
  const removed = removeTextContentChildren(
    node,
    textContentChildIds(node._id),
    observed,
    hasSubtreeObserver(node._id),
  );
  includeObservedSyntheticChildren(node, removed.existing, observed);
  const added = createTextContentChild(node, text, observed);
  bumpMutationSeq("text");
  recordTextContentMutations(
    node,
    removed.removedIds,
    added.id,
    observed,
    added.nodes,
    removed.existing,
  );
}

function removeEmptyNormalizedText(
  parent: NodeBase,
  children: NormalizationChildren,
  index: number,
): void {
  const child = children[index];
  try {
    if (child) parent.removeChild(child);
  } catch {}
  children[index] = null;
}

function mergeFollowingTextNodes(
  parent: NodeBase,
  children: NormalizationChildren,
  index: number,
  textNode: NodeBase,
): number {
  let merged = textNode.data;
  let nextIndex = index + 1;
  while (nextIndex < children.length) {
    const next = children[nextIndex];
    if (!isNormalizedTextNode(next)) break;
    merged += next.data;
    removeFollowingNormalizedText(parent, children, nextIndex, next);
    nextIndex++;
  }
  if (merged !== textNode.data) textNode.data = merged;
  return nextIndex - 1;
}

function isNormalizedTextNode(node: NodeBase | null): node is NodeBase {
  return !!node && node.nodeType === TEXT_NODE;
}

function removeFollowingNormalizedText(
  parent: NodeBase,
  children: NormalizationChildren,
  index: number,
  child: NodeBase,
): void {
  try {
    parent.removeChild(child);
  } catch {}
  children[index] = null;
}

function normalizeTextChild(
  parent: NodeBase,
  children: NormalizationChildren,
  index: number,
  textNode: NodeBase,
): number {
  if (textNode.data.length === 0) {
    removeEmptyNormalizedText(parent, children, index);
    return index;
  }
  return mergeFollowingTextNodes(parent, children, index, textNode);
}

function normalizeChild(parent: NodeBase, children: NormalizationChildren, index: number): number {
  const child = children[index];
  if (!child) return index;
  const nodeType = child.nodeType;
  if (nodeType === TEXT_NODE) return normalizeTextChild(parent, children, index, child);
  if (nodeType === ELEMENT_NODE) normalizeNodeChildren(child);
  return index;
}

function normalizeNodeChildren(parent: NodeBase): void {
  const children = Array.from<NodeBase | null>(parent.childNodes);
  for (let index = 0; index < children.length; index++) {
    index = normalizeChild(parent, children, index);
  }
}

function nodeHasDomAncestor(parent: NodeBase, other: any): boolean {
  if (typeof other._id !== "number") return false;
  let current = other._id;
  let safety = 0;
  while (safety < MAX_NODE_ANCESTOR_HOPS) {
    if (current === parent._id) return true;
    const parentId = readDomParentId(current);
    if (isTerminalParentId(parentId, current)) return false;
    current = parentId;
    safety++;
  }
  return false;
}

function isTerminalParentId(parentId: number | null, currentId: number): boolean {
  return parentId === null || parentId < 0 || parentId === currentId;
}

function readDomParentId(nodeId: number): number | null {
  try {
    return dom.parentId(nodeId);
  } catch {
    return null;
  }
}

function nodeContains(parent: NodeBase, other: any): boolean {
  if (other == null) return false;
  if (other === parent) return true;
  if (syntheticParent.get(other) === (parent as object)) return true;
  return nodeHasDomAncestor(parent, other);
}

function cachedNodeParentId(node: NodeBase, currentSequence: number): number | null {
  if (node._parentIdSeq === currentSequence && node._parentIdCache !== -2) {
    return node._parentIdCache;
  }
  try {
    const parentId = dom.parentId(node._id);
    node._parentIdCache = parentId;
    node._parentIdSeq = currentSequence;
    return parentId;
  } catch {
    return null;
  }
}

function nodeParent(node: NodeBase): any {
  const parentId = cachedNodeParentId(node, ksState().childSeq | 0);
  if (parentId === null || parentId < 0) return null;
  const hostDocument = hostIdToDoc.get(parentId);
  if (hostDocument) return hostDocument;
  return nodeFor(parentId);
}

function siblingIndexInBounds(index: number, length: number): boolean {
  return index >= 0 && index < length;
}

function findElementSibling(
  children: ArrayLike<NodeBase>,
  index: number,
  direction: -1 | 1,
): Element | null {
  for (index += direction; siblingIndexInBounds(index, children.length); index += direction) {
    if (children[index]?.nodeType === ELEMENT_NODE) return children[index] as Element;
  }
  return null;
}

function elementSibling(node: NodeBase, direction: -1 | 1): Element | null {
  const children = parentChildArray(node);
  if (!children) return null;
  const index = indexById(children, node._id);
  if (index < 0) return null;
  return findElementSibling(children, index, direction);
}

type PreviousNodePosition = {
  parent: NodeBase | null;
  previous: NodeBase | null;
  next: NodeBase | null;
};

function hasLiveNodeId<Node extends NodeLikeInput>(node: Node | null | undefined): boolean {
  return node != null && typeof node._id === "number" && node._id >= 0;
}

function readNodeType<Node extends Pick<NodeLikeInput, "nodeType">>(
  node: Node,
): Node["nodeType"] | null {
  try {
    return node.nodeType;
  } catch {
    return null;
  }
}

function assertAppendChild(parent: NodeBase, child: any): void {
  if (!child) throw notSupported("appendChild: null/undefined child");
  if (child._dom && child._dom !== dom) {
    try {
      adoptIntoDom(dom, child, document);
    } catch {}
  }
  assertCanHaveChildren(parent, "appendChild");
  assertNotAncestor(parent, child, "appendChild");
  assertNotDocumentChild(child, "appendChild");
  assertDoctypeOnlyInDocument(parent, child, "appendChild");
  assertNotTextIntoDocument(parent, child, "appendChild");
  assertOneElementChild(parent, child, "appendChild");
}

function isLiveDocumentFragment(child: any, nodeType: number | null): boolean {
  return nodeType === DOCUMENT_FRAGMENT_NODE && hasLiveNodeId(child);
}

function previousNodePosition(parent: NodeBase, child: any, childId: number): PreviousNodePosition {
  try {
    const parentId = dom.parentId(childId);
    return parentId >= 0 ? previousNodePositionForId(parent, child, parentId) : EMPTY_NODE_POSITION;
  } catch {}
  return EMPTY_NODE_POSITION;
}

const EMPTY_NODE_POSITION: PreviousNodePosition = { parent: null, previous: null, next: null };

function previousNodePositionForId(
  parent: NodeBase,
  child: any,
  parentId: number,
): PreviousNodePosition {
  return {
    parent: parentId === parent._id ? parent : nodeFor(parentId),
    previous: child.previousSibling || null,
    next: child.nextSibling || null,
  };
}

function detachSameParentAppendChild(parent: NodeBase, childId: number): void {
  try {
    const currentParentId = dom.parentId(childId);
    // Blitz corrupts its child list if appendChildNode receives an attached same-parent child.
    if (currentParentId === parent._id) dom.removeNode(childId);
  } catch {}
}

function appendLiveChild(parent: NodeBase, child: NodeBase): NodeBase {
  const previousSibling = parent.lastChild || null;
  const oldPosition = previousNodePosition(parent, child, child._id);
  const oldParent = oldPosition.parent;
  const intraParent = oldParent === parent;
  const oldIndex = oldParent ? nodeIndexOf(child) : -1;
  detachSameParentAppendChild(parent, child._id);
  if (oldParent && oldIndex >= 0) rangeBeforeRemove(oldParent, oldIndex, child);
  dom.appendChildNode(parent._id, child._id);
  bumpMutationSeq(undefined, true);
  updateAppendRange(parent);
  recordAppendChildMutations(parent, child, previousSibling, oldPosition, intraParent);
  return child;
}

function updateAppendRange(parent: NodeBase): void {
  const newIndex = (dom.childIds ? dom.childIds(parent._id).length : 0) - 1;
  if (newIndex >= 0) rangeAfterInsert(parent, newIndex, 1);
}

function recordAppendRemoval(
  oldParent: NodeBase | null,
  child: NodeBase,
  intraParent: boolean,
): void {
  if (!oldParent || intraParent || !hasLiveNodeId(oldParent)) return;
  recordCdpMutation({ kind: "childNodeRemoved", parentNodeId: oldParent._id, nodeId: child._id });
}

function recordAppendChildMutations(
  parent: NodeBase,
  child: NodeBase,
  previousSibling: NodeBase | null,
  oldPosition: PreviousNodePosition,
  intraParent: boolean,
): void {
  const oldParent = oldPosition.parent;
  recordAppendRemoval(oldParent, child, intraParent);
  recordCdpMutation({
    kind: "childNodeInserted",
    parentNodeId: parent._id,
    previousNodeId: previousSibling ? previousSibling._id : 0,
    nodeId: child._id,
  });
  // Queue removal before addition, even when both mutations target one observer.
  if (oldParent) {
    recordChildListMutation(oldParent, [], [child], oldPosition.previous, oldPosition.next);
  }
  recordChildListMutation(parent, [child], [], previousSibling, null);
  stampConnectedNamedGlobals(child._id);
  notifySubtreeInserts(child);
  notifyConnectedCallbacks(child);
}

function assertFragmentAppendChildren(parent: NodeBase, children: any[]): void {
  // Validate every fragment child before moving any; failure must not partially consume it.
  for (const child of children) {
    assertNotDocumentChild(child, "appendChild");
    assertDoctypeOnlyInDocument(parent, child, "appendChild");
    assertNotTextIntoDocument(parent, child, "appendChild");
  }
}

function appendFragmentChildrenToDom(parent: NodeBase, children: any[]): void {
  for (const child of children) {
    if (!hasLiveNodeId(child)) continue;
    try {
      dom.removeNode(child._id);
    } catch {}
    dom.appendChildNode(parent._id, child._id);
  }
}

function recordAppendedFragmentChildren(
  parent: NodeBase,
  children: any[],
  previousId: number,
): void {
  let previousNodeId = previousId;
  for (const child of children) {
    if (!hasLiveNodeId(child)) continue;
    recordCdpMutation({
      kind: "childNodeInserted",
      parentNodeId: parent._id,
      previousNodeId,
      nodeId: child._id,
    });
    previousNodeId = child._id;
  }
}

function notifyAppendedFragmentChildren(children: any[]): void {
  for (const child of children) {
    stampConnectedNamedGlobals(child._id);
    notifySubtreeInserts(child);
    notifyConnectedCallbacks(child);
  }
}

function appendFragment(parent: NodeBase, fragment: NodeBase): NodeBase {
  const children = Array.from<any>(fragment.childNodes);
  if (children.length === 0) return fragment;
  assertFragmentAppendChildren(parent, children);
  const previousSibling = parent.lastChild || null;
  appendFragmentChildrenToDom(parent, children);
  bumpMutationSeq(undefined, true);
  recordAppendedFragmentChildren(parent, children, previousSibling ? previousSibling._id : 0);
  recordChildListMutation(fragment, [], children, null, null);
  recordChildListMutation(parent, children, [], previousSibling, null);
  notifyAppendedFragmentChildren(children);
  return fragment;
}

function appendSyntheticChild(parent: NodeBase, child: any): any {
  const html = child._serializeForAppend();
  recordOp({ kind: "appendChildHtml", parent: parent._id, html });
  return child;
}

function appendNode(parent: NodeBase, child: any): any {
  maybeScheduleSlotchange(parent._id);
  assertAppendChild(parent, child);
  const nodeType = readNodeType(child);
  if (isLiveDocumentFragment(child, nodeType)) return appendFragment(parent, child);
  if (hasLiveNodeId(child)) return appendLiveChild(parent, child);
  if (typeof child._serializeForAppend === "function") return appendSyntheticChild(parent, child);
  throw notSupported("appendChild: unsupported child node");
}

function isReferenceNodeArgument(node: NodeBase | null): boolean {
  return node == null || (typeof node === "object" && typeof node._id === "number");
}

function referenceChildBelongsTo(parent: NodeBase, reference: NodeBase): boolean {
  try {
    if (reference.parentNode === parent) return true;
  } catch {}
  if (!hasLiveNodeId(parent)) return false;
  const parentId = readDomParentId(reference._id);
  return referenceParentIdMatches(parentId, parent._id);
}

function referenceParentIdMatches(parentId: number | null, parentIdExpected: number): boolean {
  return parentId !== null && parentId >= 0 && parentId === parentIdExpected;
}

function assertReferenceChild(parent: NodeBase, reference: NodeBase | null): void {
  if (!reference || !hasLiveNodeId(reference)) return;
  if (!referenceChildBelongsTo(parent, reference)) {
    throw new DOMException(
      "insertBefore: reference child is not a child of parent",
      "NotFoundError",
    );
  }
}

function assertInsertBeforeArguments(
  parent: NodeBase,
  newChild: NodeBase,
  reference: NodeBase | null,
  argumentCount: number,
): void {
  if (argumentCount < 2) {
    throw new TypeError(
      "insertBefore: 2 arguments required, but only " + argumentCount + " present",
    );
  }
  if (reference != null && !isReferenceNodeArgument(reference)) {
    throw new TypeError("insertBefore: second argument is not a Node");
  }
  if (!newChild) throw new TypeError("insertBefore: first argument is not a Node");
  assertCanHaveChildren(parent, "insertBefore");
  assertNotAncestor(parent, newChild, "insertBefore");
  assertReferenceChild(parent, reference);
  assertNotDocumentChild(newChild, "insertBefore");
  assertDoctypeOnlyInDocument(parent, newChild, "insertBefore");
  assertNotTextIntoDocument(parent, newChild, "insertBefore");
  assertOneElementChild(parent, newChild, "insertBefore");
}

function assertFragmentInsertChildren(parent: NodeBase, children: any[]): void {
  // Validate the whole fragment first so a failed insertion cannot partially consume it.
  for (const child of children) {
    assertNotDocumentChild(child, "insertBefore");
    assertDoctypeOnlyInDocument(parent, child, "insertBefore");
    assertNotTextIntoDocument(parent, child, "insertBefore");
  }
}

function insertFragmentChildrenBeforeDom(
  parent: NodeBase,
  children: any[],
  referenceId: number,
): void {
  for (const child of children) {
    if (!hasLiveNodeId(child)) continue;
    try {
      dom.removeNode(child._id);
    } catch {}
    const safeReference = safeReferenceId(parent._id, referenceId);
    dom.insertBeforeNode(parent._id, child._id, safeReference);
  }
}

function notifyInsertedFragmentChildren(children: any[]): void {
  for (const child of children) {
    stampConnectedNamedGlobals(child._id);
    notifySubtreeInserts(child);
    notifyConnectedCallbacks(child);
  }
}

function insertionSiblings(
  parent: NodeBase,
  reference: NodeBase | null,
): {
  previous: NodeBase | null;
  next: NodeBase | null;
} {
  if (reference) {
    return { previous: reference.previousSibling || null, next: reference };
  }
  return { previous: parent.lastChild || null, next: null };
}

function insertFragmentBefore(
  parent: NodeBase,
  fragment: NodeBase,
  reference: NodeBase | null,
): NodeBase {
  const children = Array.from<any>(fragment.childNodes);
  if (children.length === 0) return fragment;
  assertFragmentInsertChildren(parent, children);
  const siblings = insertionSiblings(parent, reference);
  const referenceId = insertionReferenceId(reference);
  insertFragmentChildrenBeforeDom(parent, children, referenceId);
  bumpMutationSeq(undefined, true);
  recordAppendedFragmentChildren(parent, children, siblings.previous ? siblings.previous._id : 0);
  recordChildListMutation(fragment, [], children, null, null);
  recordChildListMutation(parent, children, [], siblings.previous, siblings.next);
  notifyInsertedFragmentChildren(children);
  return fragment;
}

function insertSyntheticChildBefore(
  parent: NodeBase,
  child: NodeBase,
  reference: NodeBase | null,
): NodeBase {
  if (typeof child._serializeForAppend !== "function") {
    throw notSupported("insertBefore: unsupported new child");
  }
  if (reference != null) throw notSupported("insertBefore: SyntheticElement requires null ref");
  const html = child._serializeForAppend();
  recordOp({ kind: "appendChildHtml", parent: parent._id, html });
  return child;
}

function insertReferenceForChild(child: NodeBase, reference: NodeBase | null): NodeBase | null {
  if (reference !== child) return reference;
  return child.nextSibling || null;
}

function insertionReferenceId(reference: NodeBase | null): number {
  if (reference == null) return 0;
  return hasLiveNodeId(reference) ? reference._id : 0;
}

function insertionReferenceIndex(parent: NodeBase, reference: NodeBase | null): number {
  if (reference) return nodeIndexOf(reference);
  return dom.childIds ? dom.childIds(parent._id).length : 0;
}

function nodeIndexForPreviousPosition(position: PreviousNodePosition, child: NodeBase): number {
  return position.parent ? nodeIndexOf(child) : -1;
}

function detachSameParentInsertChild(parent: NodeBase, childId: number): void {
  try {
    const currentParentId = dom.parentId(childId);
    // Blitz corrupts child order if an attached same-parent move is not detached first.
    if (currentParentId === parent._id) dom.removeNode(childId);
  } catch {}
}

function adjustRangeBeforeInsert(
  oldPosition: PreviousNodePosition,
  oldIndex: number,
  child: NodeBase,
): void {
  if (!oldPosition.parent || oldIndex < 0) return;
  rangeBeforeRemove(oldPosition.parent, oldIndex, child);
}

function adjustedInsertionIndex(
  referenceIndex: number,
  intraParent: boolean,
  oldIndex: number,
): number {
  return intraParent && oldIndex >= 0 && oldIndex < referenceIndex
    ? referenceIndex - 1
    : referenceIndex;
}

function recordInsertRemoval(
  oldParent: NodeBase | null,
  child: NodeBase,
  intraParent: boolean,
): void {
  if (!oldParent || intraParent || !hasLiveNodeId(oldParent)) return;
  recordCdpMutation({ kind: "childNodeRemoved", parentNodeId: oldParent._id, nodeId: child._id });
}

function recordInsertedChildMutations(
  parent: NodeBase,
  child: NodeBase,
  previousSibling: NodeBase | null,
  nextSibling: NodeBase | null,
  oldPosition: PreviousNodePosition,
  intraParent: boolean,
): void {
  recordInsertRemoval(oldPosition.parent, child, intraParent);
  recordCdpMutation({
    kind: "childNodeInserted",
    parentNodeId: parent._id,
    previousNodeId: previousSibling ? previousSibling._id : 0,
    nodeId: child._id,
  });
  if (oldPosition.parent) {
    recordChildListMutation(
      oldPosition.parent,
      [],
      [child],
      oldPosition.previous,
      oldPosition.next,
    );
  }
  recordChildListMutation(parent, [child], [], previousSibling, nextSibling);
  stampConnectedNamedGlobals(child._id);
  notifySubtreeInserts(child);
  notifyConnectedCallbacks(child);
}

function insertLiveChildBefore(
  parent: NodeBase,
  child: NodeBase,
  reference: NodeBase | null,
): NodeBase {
  const targetReference = insertReferenceForChild(child, reference);
  const referenceId = insertionReferenceId(targetReference);
  const siblings = insertionSiblings(parent, targetReference);
  const oldPosition = previousNodePosition(parent, child, child._id);
  const intraParent = oldPosition.parent === parent;
  const oldIndex = nodeIndexForPreviousPosition(oldPosition, child);
  const referenceIndex = insertionReferenceIndex(parent, targetReference);
  detachSameParentInsertChild(parent, child._id);
  adjustRangeBeforeInsert(oldPosition, oldIndex, child);
  dom.insertBeforeNode(parent._id, child._id, referenceId);
  bumpMutationSeq(undefined, true);
  rangeAfterInsert(parent, adjustedInsertionIndex(referenceIndex, intraParent, oldIndex), 1);
  recordInsertedChildMutations(
    parent,
    child,
    siblings.previous,
    siblings.next,
    oldPosition,
    intraParent,
  );
  return child;
}

function insertNodeBefore<Node extends NodeBase>(
  parent: NodeBase,
  newChild: Node,
  reference: NodeBase | null,
  argumentCount: number,
): Node {
  maybeScheduleSlotchange(parent._id);
  assertInsertBeforeArguments(parent, newChild, reference, argumentCount);
  const nodeType = readNodeType(newChild);
  if (isLiveDocumentFragment(newChild, nodeType)) {
    insertFragmentBefore(parent, newChild, reference);
    return newChild;
  }
  if (!hasLiveNodeId(newChild)) {
    insertSyntheticChildBefore(parent, newChild, reference);
    return newChild;
  }
  insertLiveChildBefore(parent, newChild, reference);
  return newChild;
}

function isObjectLike(value: unknown): boolean {
  return typeof value === "object" || typeof value === "function";
}

function assertRemoveChildObject(child: any): void {
  if (child == null || !isObjectLike(child)) {
    throw new TypeError("removeChild: argument must be a Node");
  }
}

function hasNodeTypeOrId(child: any): boolean {
  return typeof child.nodeType === "number" || typeof child._id === "number";
}

function assertRemoveChildShape(child: any): void {
  if (!hasNodeTypeOrId(child)) throw new TypeError("removeChild: argument must be a Node");
}

function assertLiveRemoveChild(child: any): void {
  if (!hasLiveNodeId(child)) {
    throw new DOMException("removeChild: child is not a child of parent", "NotFoundError");
  }
}

function removeChildBelongsTo(parent: NodeBase, child: any): boolean {
  let childParent: unknown = null;
  try {
    childParent = child.parentNode;
  } catch {}
  if (childParent === parent) return true;
  if (!hasLiveNodeId(parent)) return false;
  const parentId = readDomParentId(child._id);
  return referenceParentIdMatches(parentId, parent._id);
}

function assertRemoveChildParent(parent: NodeBase, child: any): void {
  if (!removeChildBelongsTo(parent, child)) {
    throw new DOMException("removeChild: child is not a child of parent", "NotFoundError");
  }
}

function assertRemovableChild(parent: NodeBase, child: any): void {
  assertRemoveChildObject(child);
  assertRemoveChildShape(child);
  assertLiveRemoveChild(child);
  assertRemoveChildParent(parent, child);
}

function removeNodeChild(parent: NodeBase, child: any): any {
  maybeScheduleSlotchange(parent._id);
  assertRemovableChild(parent, child);
  // Adjust iterators and ranges before detaching, while the old tree position is still available.
  runIteratorPreRemove(child);
  const removedPrevious = child.previousSibling || null;
  const removedNext = child.nextSibling || null;
  const removedNodeId = child._id;
  const removedIndex = nodeIndexOf(child);
  if (removedIndex >= 0) rangeBeforeRemove(parent, removedIndex, child);
  notifyIframeRemoves(child);
  dom.removeNode(child._id);
  bumpMutationSeq(undefined, true);
  recordCdpMutation({ kind: "childNodeRemoved", parentNodeId: parent._id, nodeId: removedNodeId });
  recordChildListMutation(parent, [], [child], removedPrevious, removedNext);
  return child;
}

function assertReplaceChildTarget(parent: NodeBase, oldChild: any): void {
  if (!referenceChildBelongsTo(parent, oldChild)) {
    throw new DOMException("replaceChild: old child is not a child of parent", "NotFoundError");
  }
}

function assertLiveReplacementChildren(newChild: any, oldChild: any): void {
  if (!hasLiveNodeId(newChild)) throw notSupported("replaceChild: invalid new child");
  if (!hasLiveNodeId(oldChild)) throw notSupported("replaceChild: invalid old child");
}

function assertReplaceChildArguments(parent: NodeBase, newChild: any, oldChild: any): void {
  assertCanHaveChildren(parent, "replaceChild");
  if (!newChild) throw new TypeError("replaceChild: first argument is not a Node");
  assertNotAncestor(parent, newChild, "replaceChild");
  if (!oldChild) throw new TypeError("replaceChild: second argument is not a Node");
  assertReplaceChildTarget(parent, oldChild);
  assertNotDocumentChild(newChild, "replaceChild");
  assertDoctypeOnlyInDocument(parent, newChild, "replaceChild");
  assertNotTextIntoDocument(parent, newChild, "replaceChild");
  assertLiveReplacementChildren(newChild, oldChild);
}

type ReplacementSiblings = {
  previous: NodeBase | null;
  next: NodeBase | null;
};

function replacementSiblings(oldChild: NodeBase, newChild: NodeBase): ReplacementSiblings {
  const previous = oldChild.previousSibling || null;
  let next = oldChild.nextSibling || null;
  if (next === newChild) next = newChild.nextSibling || null;
  return { previous, next };
}

function replacementIndexes(
  parent: NodeBase,
  oldChild: NodeBase,
  newChild: NodeBase,
  oldPosition: PreviousNodePosition,
): { oldChild: number; movedChild: number } {
  return {
    oldChild: nodeIndexOf(oldChild),
    movedChild: oldPosition.parent ? nodeIndexOf(newChild) : -1,
  };
}

function adjustReplaceRangesBefore(
  parent: NodeBase,
  newChild: NodeBase,
  oldChild: NodeBase,
  oldPosition: PreviousNodePosition,
  indexes: { oldChild: number; movedChild: number },
  isSelfReplace: boolean,
): void {
  if (oldPosition.parent && indexes.movedChild >= 0 && !isSelfReplace) {
    rangeBeforeRemove(oldPosition.parent, indexes.movedChild, newChild);
  }
  if (indexes.oldChild >= 0) rangeBeforeRemove(parent, indexes.oldChild, oldChild);
}

function replaceInsertionIndex(oldIndex: number, movedIndex: number, intraParent: boolean): number {
  if (intraParent && movedIndex >= 0 && movedIndex < oldIndex) return oldIndex - 1;
  return oldIndex;
}

function adjustReplaceRangeAfter(
  parent: NodeBase,
  oldIndex: number,
  movedIndex: number,
  intraParent: boolean,
): void {
  if (oldIndex < 0) return;
  rangeAfterInsert(parent, replaceInsertionIndex(oldIndex, movedIndex, intraParent), 1);
}

function recordReplaceParentRemoval(
  parent: NodeBase | null,
  newChild: NodeBase,
  intraParent: boolean,
): void {
  if (!parent || intraParent || !hasLiveNodeId(parent)) return;
  recordCdpMutation({ kind: "childNodeRemoved", parentNodeId: parent._id, nodeId: newChild._id });
}

function recordReplacedChildRemoval(
  parent: NodeBase,
  oldChild: NodeBase,
  isSelfReplace: boolean,
): void {
  if (isSelfReplace) return;
  recordCdpMutation({ kind: "childNodeRemoved", parentNodeId: parent._id, nodeId: oldChild._id });
}

function recordReplaceChildLists(
  parent: NodeBase,
  newChild: NodeBase,
  oldChild: NodeBase,
  siblings: ReplacementSiblings,
  oldPosition: PreviousNodePosition,
  isSelfReplace: boolean,
): void {
  if (oldPosition.parent) {
    recordChildListMutation(
      oldPosition.parent,
      [],
      [newChild],
      oldPosition.previous,
      oldPosition.next,
    );
  }
  recordChildListMutation(
    parent,
    [newChild],
    isSelfReplace ? [] : [oldChild],
    siblings.previous,
    siblings.next,
  );
}

function replaceNodeChild(parent: NodeBase, newChild: NodeBase, oldChild: NodeBase): NodeBase {
  maybeScheduleSlotchange(parent._id);
  assertReplaceChildArguments(parent, newChild, oldChild);
  const siblings = replacementSiblings(oldChild, newChild);
  const oldPosition = previousNodePosition(parent, newChild, newChild._id);
  const intraParent = oldPosition.parent === parent;
  const isSelfReplace = newChild === oldChild;
  const indexes = replacementIndexes(parent, oldChild, newChild, oldPosition);
  adjustReplaceRangesBefore(parent, newChild, oldChild, oldPosition, indexes, isSelfReplace);
  if (!isSelfReplace) notifyIframeRemoves(oldChild);
  dom.replaceChildNode(newChild._id, oldChild._id);
  adjustReplaceRangeAfter(parent, indexes.oldChild, indexes.movedChild, intraParent);
  bumpMutationSeq(undefined, true);
  recordReplaceParentRemoval(oldPosition.parent, newChild, intraParent);
  recordReplacedChildRemoval(parent, oldChild, isSelfReplace);
  recordCdpMutation({
    kind: "childNodeInserted",
    parentNodeId: parent._id,
    previousNodeId: siblings.previous ? siblings.previous._id : 0,
    nodeId: newChild._id,
  });
  recordReplaceChildLists(parent, newChild, oldChild, siblings, oldPosition, isSelfReplace);
  stampConnectedNamedGlobals(newChild._id);
  return oldChild;
}

function relativeNodeSet(nodes: readonly unknown[]): Set<unknown> {
  return new Set(nodes.filter(isNodeLike));
}

function skipRelativeNodes(node: NodeBase | null, nodes: Set<unknown>): NodeBase | null {
  while (node && nodes.has(node)) node = node.nextSibling;
  return node;
}

function skipPreviousRelativeNodes(node: NodeBase | null, nodes: Set<unknown>): NodeBase | null {
  while (node && nodes.has(node)) node = node.previousSibling;
  return node;
}

function convertRelativeNodes(nodes: readonly unknown[]): NodeLikeInput[] {
  return nodes.map((node) => (isNodeLike(node) ? node : createTextNodeInternal(String(node))));
}

function relativeInsertionNode(node: Idl.Node | string): Idl.Node {
  if (typeof node === "string") return createTextNodeInternal(String(node));
  return isNodeLike(node) ? node : createTextNodeInternal(String(node));
}

function convertInsertionNodes(nodes: readonly (Idl.Node | string)[]): Idl.Node[] {
  return nodes.map(relativeInsertionNode);
}

function insertRelativeNodes(parent: Idl.Node, nodes: Idl.Node[], anchor: Idl.Node | null): void {
  for (const node of nodes) {
    if (anchor) parent.insertBefore(node, anchor);
    else parent.appendChild(node);
  }
}

function insertRelativeBefore(target: NodeBase, nodes: readonly (Idl.Node | string)[]): void {
  const parent = target.parentNode;
  if (!parent) return;
  const included = relativeNodeSet(nodes);
  const previous = skipPreviousRelativeNodes(target.previousSibling, included);
  const initialAnchor = previous ? previous.nextSibling : parent.firstChild;
  const anchor = skipRelativeNodes(initialAnchor, included);
  insertRelativeNodes(parent, convertInsertionNodes(nodes), anchor);
}

function insertRelativeAfter(target: NodeBase, nodes: readonly (Idl.Node | string)[]): void {
  const parent = target.parentNode;
  if (!parent) return;
  const included = relativeNodeSet(nodes);
  const anchor = skipRelativeNodes(target.nextSibling, included);
  insertRelativeNodes(parent, convertInsertionNodes(nodes), anchor);
}

function replaceRelativeNode(target: NodeBase, nodes: readonly (Idl.Node | string)[]): void {
  const parent = target.parentNode;
  if (!parent) return;
  const included = relativeNodeSet(nodes);
  const anchor = skipRelativeNodes(target.nextSibling, included);
  insertRelativeNodes(parent, convertInsertionNodes(nodes), anchor);
  if (!included.has(target)) parent.removeChild(target);
}

function addProspectiveChild(children: any[], child: any): void {
  const previousIndex = children.indexOf(child);
  if (previousIndex !== -1) children.splice(previousIndex, 1);
  children.push(child);
}

function prospectiveReplacementChildren(converted: any[]): any[] {
  const prospective: any[] = [];
  for (const node of converted) {
    const children =
      node.nodeType === DOCUMENT_FRAGMENT_NODE ? Array.from<any>(node.childNodes) : [node];
    for (const child of children) addProspectiveChild(prospective, child);
  }
  return prospective;
}

function isDocumentChildrenTarget(parent: NodeBase): boolean {
  return parent.nodeType === DOCUMENT_NODE || hostIdToDoc.has(parent._id);
}

function hasMisorderedDoctype(child: any, sawElement: boolean): boolean {
  return child.nodeType === DOCTYPE_NODE && sawElement;
}

function assertReplaceChildrenDoctypeOrder(children: any[]): void {
  let sawElement = false;
  for (const child of children) {
    if (child.nodeType === ELEMENT_NODE) sawElement = true;
    if (hasMisorderedDoctype(child, sawElement)) {
      throw new DOMException(
        "replaceChildren: Document doctype must precede element",
        "HierarchyRequestError",
      );
    }
  }
}

function assertReplaceChildrenValid(parent: NodeBase, prospective: any[], converted: any[]): void {
  assertCanHaveChildren(parent, "replaceChildren");
  const isDocument = isDocumentChildrenTarget(parent);
  if (isDocument) {
    assertDocumentInsertAllowed(parent, prospective, "replaceChildren", false, true);
    assertReplaceChildrenDoctypeOrder(prospective);
  }
  for (const child of converted) {
    assertNotAncestor(parent, child, "replaceChildren");
    assertNotDocumentChild(child, "replaceChildren");
    if (!isDocument) assertDoctypeOnlyInDocument(parent, child, "replaceChildren");
  }
}

function applyReplaceChildren(parent: NodeBase, converted: any[], existing: any[]): void {
  suppressChildListMutations(parent, () => {
    for (const child of existing) parent.removeChild(child);
    for (const child of converted) parent.appendChild(child);
  });
}

function replaceNodeChildren(parent: NodeBase, nodes: readonly unknown[]): void {
  const converted = convertRelativeNodes(nodes);
  const prospective = prospectiveReplacementChildren(converted);
  assertReplaceChildrenValid(parent, prospective, converted);
  const existing = Array.from<any>(parent.childNodes);
  applyReplaceChildren(parent, converted, existing);
  const added = Array.from<any>(parent.childNodes);
  if (added.length > 0 || existing.length > 0) {
    recordChildListMutation(parent, added, existing, null, null);
  }
}

type AdjacentPosition = "beforebegin" | "afterbegin" | "beforeend" | "afterend";

const ADJACENT_POSITIONS = new Map<string, AdjacentPosition>([
  ["beforebegin", "beforebegin"],
  ["afterbegin", "afterbegin"],
  ["beforeend", "beforeend"],
  ["afterend", "afterend"],
]);

function normalizeAdjacentPosition(position: unknown, method: string): AdjacentPosition {
  const raw = typeof position === "string" ? position.toLowerCase() : "";
  const normalized = ADJACENT_POSITIONS.get(raw);
  if (normalized) return normalized;
  throw new DOMException(
    method + ": '" + position + "' is not a valid insertAdjacent position",
    "SyntaxError",
  );
}

function insertBeforeAdjacentTarget(target: NodeBase, node: any): NodeBase | null {
  const parent = target.parentNode;
  if (!parent) return null;
  parent.insertBefore(node, target);
  return node;
}

function insertAtAdjacentBeginning(target: NodeBase, node: any): NodeBase {
  const first = target.firstChild;
  if (first) target.insertBefore(node, first);
  else target.appendChild(node);
  return node;
}

function appendAtAdjacentEnd(target: NodeBase, node: any): NodeBase {
  target.appendChild(node);
  return node;
}

function insertAfterAdjacentTarget(target: NodeBase, node: any): NodeBase | null {
  const parent = target.parentNode;
  if (!parent) return null;
  const siblings = parent.childNodes;
  const index = siblings.findIndex((child: NodeBase) => child === target);
  const next = index >= 0 ? siblings[index + 1] : null;
  parent.insertBefore(node, next || null);
  return node;
}

const ADJACENT_INSERTION = {
  beforebegin: insertBeforeAdjacentTarget,
  afterbegin: insertAtAdjacentBeginning,
  beforeend: appendAtAdjacentEnd,
  afterend: insertAfterAdjacentTarget,
} satisfies Record<AdjacentPosition, (target: NodeBase, node: any) => NodeBase | null>;

function insertAtAdjacentPosition(
  target: NodeBase,
  node: any,
  position: AdjacentPosition,
): NodeBase | null {
  return ADJACENT_INSERTION[position](target, node);
}

function insertAdjacentElementNode(
  target: NodeBase,
  position: unknown,
  element: any,
): Idl.Element | null {
  if (!element || typeof element._id !== "number") {
    throw notSupported("insertAdjacentElement: unsupported element");
  }
  const nodeType = readNodeType(element);
  if (nodeType !== ELEMENT_NODE) {
    throw new TypeError(
      "insertAdjacentElement: second argument must be an Element (got nodeType " + nodeType + ")",
    );
  }
  const normalized = normalizeAdjacentPosition(position, "insertAdjacentElement");
  const inserted = insertAtAdjacentPosition(target, element, normalized);
  return inserted ? element : null;
}

function insertAdjacentTextNode(target: NodeBase, position: unknown, data: unknown): void {
  const normalized = normalizeAdjacentPosition(position, "insertAdjacentText");
  const text = createTextNodeInternal(String(data ?? ""));
  insertAtAdjacentPosition(target, text, normalized);
}

function adjacentHtmlPosition(position: unknown): string {
  return typeof position === "string" ? position.toLowerCase() : "";
}

function isAdjacentContentPosition(position: string): boolean {
  return position === "afterbegin" || position === "beforeend";
}

function isAdjacentSiblingPosition(position: string): boolean {
  return position === "beforebegin" || position === "afterend";
}

function adjacentHtmlNodes(html: unknown): any[] {
  const container = createElementInternal("div");
  container.innerHTML = String(html == null ? "" : html);
  return Array.from<any>(container.childNodes);
}

function insertAdjacentHtmlAtBeginning(target: NodeBase, nodes: any[]): void {
  const reference = target.firstChild;
  for (const node of nodes) {
    if (reference) target.insertBefore(node, reference);
    else target.appendChild(node);
  }
}

function appendAdjacentHtmlNodes(target: NodeBase, nodes: any[]): void {
  for (const node of nodes) target.appendChild(node);
}

function insertAdjacentHtmlInside(target: NodeBase, position: string, html: unknown): void {
  const nodes = adjacentHtmlNodes(html);
  if (position === "afterbegin") insertAdjacentHtmlAtBeginning(target, nodes);
  else appendAdjacentHtmlNodes(target, nodes);
}

function adjacentHtmlParent(target: NodeBase, position: unknown): NodeBase {
  const parent = target.parentNode;
  if (!parent || (parent.nodeType !== ELEMENT_NODE && parent.nodeType !== DOCUMENT_FRAGMENT_NODE)) {
    throw new (ksGlobal.DOMException || Error)(
      "insertAdjacentHTML: cannot insert at '" + position + "' without an element parent",
      "NoModificationAllowedError",
    );
  }
  return parent;
}

function insertAdjacentHtmlBefore(parent: NodeBase, target: NodeBase, nodes: any[]): void {
  for (const node of nodes) parent.insertBefore(node, target);
}

function insertAdjacentHtmlAfter(parent: NodeBase, target: NodeBase, nodes: any[]): void {
  const reference = target.nextSibling;
  for (const node of nodes) {
    if (reference) parent.insertBefore(node, reference);
    else parent.appendChild(node);
  }
}

function insertAdjacentHtmlBeside(
  target: NodeBase,
  position: string,
  originalPosition: unknown,
  html: unknown,
): void {
  const parent = adjacentHtmlParent(target, originalPosition);
  const nodes = adjacentHtmlNodes(html);
  if (position === "beforebegin") insertAdjacentHtmlBefore(parent, target, nodes);
  else insertAdjacentHtmlAfter(parent, target, nodes);
}

function invalidAdjacentHtmlPosition(position: unknown): never {
  throw new (ksGlobal.DOMException || Error)(
    "'" + position + "' is not a valid insertAdjacent position",
    "SyntaxError",
  );
}

function insertAdjacentHTMLNode(target: NodeBase, position: unknown, html: unknown): void {
  const normalized = adjacentHtmlPosition(position);
  if (isAdjacentContentPosition(normalized)) {
    insertAdjacentHtmlInside(target, normalized, html);
    return;
  }
  if (isAdjacentSiblingPosition(normalized)) {
    insertAdjacentHtmlBeside(target, normalized, position, html);
    return;
  }
  invalidAdjacentHtmlPosition(position);
}

function nextConnectedAncestor(node: any): any {
  if (node.parentNode) return node.parentNode;
  if (node.nodeType === DOCUMENT_FRAGMENT_NODE && node.host) return node.host;
  return null;
}

function nodeIsConnected(node: NodeBase): boolean {
  const seen = new Set<any>();
  for (let hops = 0; hops < MAX_CONNECTED_NODE_ANCESTOR_HOPS; hops++) {
    if (!node) return false;
    if (node.nodeType === DOCUMENT_NODE) return true;
    if (seen.has(node)) return false;
    seen.add(node);
    node = nextConnectedAncestor(node);
  }
  return false;
}

function runNodeCloneSteps(
  node: NodeBase,
  clone: NodeCloneValue | null,
  deep: boolean,
): NodeCloneValue | null {
  if (!clone) return null;
  try {
    runCloneSteps(node, clone);
    if (deep) runCloneStepsDeep(node, clone);
  } catch {}
  return clone;
}

function cloneOrdinaryNode(node: NodeBase, deep: boolean, nodeType: number): NodeCloneValue | null {
  const result = deep ? cloneNodeDeep(node) : cloneNodeShallow(node);
  if (result.earlyReturn) return null;
  if (isShallowTextOrCommentClone(deep, nodeType)) return result.node;
  return runNodeCloneSteps(node, result.node, deep);
}

function isShallowTextOrCommentClone(deep: boolean, nodeType: number): boolean {
  return !deep && (nodeType === TEXT_NODE || nodeType === COMMENT_NODE);
}

class NodeBase extends KsEventTarget implements Idl.Node {
  // Installed on the prototype below the class.
  declare baseURI: string;
  _id: number;
  _parentIdCache: number;
  _parentIdSeq: number;
  declare _typeCheckSeq?: number;
  declare _attrFlatCache?: string[] | null;
  _info: any;
  get data(): any {
    return this._info ? this._info.nodeValue : undefined;
  }
  set data(_v: any) {}
  _attrFlat?(): any[];
  _serializeForAppend?(): string;
  get innerHTML(): any {
    return undefined;
  }
  set innerHTML(_v: any) {}
  declare isSameNode: (other: any) => boolean;
  declare isEqualNode: (other: any) => boolean;
  declare getRootNode: (options?: any) => any;
  declare compareDocumentPosition: (other: any) => number;
  declare lookupNamespaceURI: (prefix: any) => any;
  declare lookupPrefix: (ns: any) => any;
  declare isDefaultNamespace: (ns: any) => boolean;
  constructor(nodeId: number, info: unknown) {
    super();
    this._id = nodeId;
    this._info = info;
    this._parentIdCache = -2;
    this._parentIdSeq = -1;
  }
  static [Symbol.hasInstance](v): boolean {
    if (v == null) return false;
    if (typeof v !== "object" && typeof v !== "function") return false;
    if (NodeBase.prototype.isPrototypeOf(v)) return true;
    return typeof v.nodeType === "number";
  }
  cloneNode(deep) {
    if (this._id < 0) return null;
    const nodeType = this.nodeType;
    if (nodeType === PROCESSING_INSTRUCTION_NODE) return cloneProcessingInstruction(this);
    return cloneOrdinaryNode(this, deep === true, nodeType);
  }
  get nodeType() {
    if (this._info) return this._info.nodeType;
    const own = Object.getOwnPropertyDescriptor(this, "nodeType");
    return own && "value" in own ? own.value : 0;
  }
  get nodeName() {
    if (this._info) return this._info.nodeName;
    const own = Object.getOwnPropertyDescriptor(this, "nodeName");
    return own && "value" in own ? own.value : "";
  }
  get nodeValue() {
    return null;
  }
  set nodeValue(_v) {}
  get textContent() {
    if (this._id < 0) return this._info.nodeValue || "";
    if (stampedPiIds.size === 0) return dom.textContent(this._id);
    return collectTextContent(this._id);
  }
  set textContent(value) {
    setNodeTextContent(this, value);
  }
  get childNodes(): any {
    const cached = nodeListCache.get(this);
    if (cached) return cached;
    const id = this._id;
    const list = makeNodeList(() => {
      const ids = Array.from(dom.childIds(id));
      return ids.map((cid) => cache.get(cid) || nodeFor(cid)).filter(Boolean);
    }, "childSeq");
    nodeListCache.set(this, list);
    return list;
  }
  get firstChild() {
    if (this == null) return null;
    const kids = childArray(this);
    return kids.length > 0 ? kids[0] : null;
  }
  get lastChild() {
    const kids = childArray(this);
    return kids.length > 0 ? kids[kids.length - 1] : null;
  }
  hasChildNodes() {
    return this.childNodes.length > 0;
  }
  contains(other) {
    return nodeContains(this, other);
  }
  normalize() {
    normalizeNodeChildren(this);
  }

  get parentNode() {
    return nodeParent(this);
  }
  get parentElement() {
    const p = this.parentNode;
    return p && p.nodeType === ELEMENT_NODE ? p : null;
  }
  get nextSibling() {
    if (this == null) return null;
    const kids = parentChildArray(this);
    if (!kids) return null;
    const i = indexById(kids, this._id);
    return i >= 0 && i + 1 < kids.length ? kids[i + 1] : null;
  }
  get previousSibling() {
    const kids = parentChildArray(this);
    if (!kids) return null;
    const i = indexById(kids, this._id);
    return i > 0 ? kids[i - 1] : null;
  }
  // A child with nodeType ELEMENT_NODE is an Element wrapper.
  get nextElementSibling(): Element | null {
    return elementSibling(this, 1);
  }
  get previousElementSibling(): Element | null {
    return elementSibling(this, -1);
  }
  get ownerDocument() {
    const owner = nodeOwnerDoc.get(this);
    if (owner) return owner;
    return windowObj.document;
  }
  appendChild(child: unknown): NodeBase {
    return appendNode(this, child);
  }
  insertBefore(newChild: NodeBase, refChild: NodeBase | null): NodeBase {
    return insertNodeBefore(this, newChild, refChild, arguments.length);
  }
  removeChild(child: NodeBase): NodeBase {
    return removeNodeChild(this, child);
  }
  replaceChild(newChild: NodeBase, oldChild: NodeBase): NodeBase {
    return replaceNodeChild(this, newChild, oldChild);
  }
  before(...nodes: Parameters<Idl.Element["before"]>): void {
    insertRelativeBefore(this, nodes);
  }
  after(...nodes: Parameters<Idl.Element["after"]>): void {
    insertRelativeAfter(this, nodes);
  }
  replaceWith(...nodes: Parameters<Idl.Element["replaceWith"]>): void {
    replaceRelativeNode(this, nodes);
  }
  remove(): void {
    const parent = this.parentNode;
    if (parent) parent.removeChild(this);
  }
  append(...nodes: unknown[]): void {
    for (const n of nodes) {
      const node = isNodeLike(n) ? n : createTextNodeInternal(String(n));
      this.appendChild(node);
    }
  }
  prepend(...nodes: Parameters<Idl.Element["prepend"]>): void {
    const parent: Idl.Node = this;
    const first = this.firstChild;
    for (const n of nodes) {
      const node = relativeInsertionNode(n);
      if (first) parent.insertBefore(node, first);
      else parent.appendChild(node);
    }
  }
  replaceChildren(...nodes: unknown[]): void {
    replaceNodeChildren(this, nodes);
  }

  insertAdjacentElement(position, element): Idl.Element | null {
    return insertAdjacentElementNode(this, position, element);
  }
  insertAdjacentText(position, data): void {
    insertAdjacentTextNode(this, position, data);
  }
  insertAdjacentHTML(position, html): void {
    const htmlText = String(html == null ? "" : html);
    return ksSpan("dom.insertAdjacentHTML", { html_bytes: htmlText.length }, () =>
      this.__insertAdjacentHTML(position, htmlText),
    );
  }
  __insertAdjacentHTML(position, html): void {
    insertAdjacentHTMLNode(this, position, html);
  }

  get isConnected() {
    return nodeIsConnected(this);
  }
}
const NODE_CONSTANTS = {
  ELEMENT_NODE,
  ATTRIBUTE_NODE,
  TEXT_NODE,
  CDATA_SECTION_NODE,
  ENTITY_REFERENCE_NODE,
  ENTITY_NODE,
  PROCESSING_INSTRUCTION_NODE,
  COMMENT_NODE,
  DOCUMENT_NODE,
  DOCUMENT_TYPE_NODE: DOCTYPE_NODE,
  DOCUMENT_FRAGMENT_NODE,
  NOTATION_NODE,
  DOCUMENT_POSITION_DISCONNECTED,
  DOCUMENT_POSITION_PRECEDING,
  DOCUMENT_POSITION_FOLLOWING,
  DOCUMENT_POSITION_CONTAINS,
  DOCUMENT_POSITION_CONTAINED_BY,
  DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC,
};
for (const k of Object.keys(NODE_CONSTANTS)) {
  NodeBase[k] = NODE_CONSTANTS[k];
  NodeBase.prototype[k] = NODE_CONSTANTS[k];
}

type NodeWithOptionalHost = NodeBase & { host?: NodeBase | null };

function treeRoot(node: NodeWithOptionalHost): NodeWithOptionalHost {
  let parent;
  while ((parent = node.parentNode)) node = parent;
  return node;
}

function shadowHost(node: NodeWithOptionalHost): NodeBase | null {
  if (!node || node.nodeType !== DOCUMENT_FRAGMENT_NODE || typeof node.host === "undefined") {
    return null;
  }
  return node.host || null;
}

function composedTreeRoot(root: NodeWithOptionalHost): NodeWithOptionalHost {
  let host = shadowHost(root);
  while (host) {
    root = treeRoot(host);
    host = shadowHost(root);
  }
  return root;
}

function getRootNodeForNode(node: NodeWithOptionalHost, options: any): NodeWithOptionalHost {
  const root = treeRoot(node);
  if (options && options.composed) return composedTreeRoot(root);
  return root;
}

NodeBase.prototype.isSameNode = function (other) {
  if (!other) return false;
  return this === other || this._id === other._id;
};
NodeBase.prototype.isEqualNode = function (other) {
  return isEqualNode(this, other);
};
NodeBase.prototype.getRootNode = function (options) {
  return getRootNodeForNode(this, options);
};
NodeBase.prototype.compareDocumentPosition = function (other) {
  return compareDocumentPosition(this, other);
};
Object.defineProperty(NodeBase.prototype, "assignedSlot", {
  configurable: true,
  enumerable: true,
  get() {
    let slotId = -1;
    try {
      slotId = dom.assignedSlotOf(this._id);
    } catch {}
    if (slotId < 0) return null;
    const rootId = dom.containingShadowRootId(slotId);
    if (rootId >= 0 && shadowRootModes.get(rootId) === "closed") return null;
    return nodeFor(slotId);
  },
});
type NamespaceLookupNode = NodeBase & {
  attributes?: ArrayLike<Idl.Attr | null> | null;
  prefix?: string | null;
  namespaceURI?: string | null;
  documentElement?: NodeBase | null;
  ownerElement?: NodeBase | null;
};

type NamespaceAttributeResult<T> = { found: true; value: T } | { found: false };

function scanNamespaceAttributes<T>(
  attrs: ArrayLike<Idl.Attr | null> | null | undefined,
  matches: (attribute: Idl.Attr) => boolean,
  value: (attribute: Idl.Attr) => T,
): NamespaceAttributeResult<T> {
  if (attrs) {
    for (let index = 0; index < attrs.length; index++) {
      const attribute = attrs[index];
      if (attribute && matches(attribute)) return { found: true, value: value(attribute) };
    }
  }
  return { found: false };
}

function findNamespaceAttribute<T>(
  node: NamespaceLookupNode,
  matches: (attribute: Idl.Attr) => boolean,
  value: (attribute: Idl.Attr) => T,
): NamespaceAttributeResult<T> {
  try {
    return scanNamespaceAttributes(node.attributes, matches, value);
  } catch {}
  return { found: false };
}

function matchesDefaultNamespaceDeclaration(
  attributePrefix: string | null,
  localName: string,
): boolean {
  return attributePrefix === null && localName === "xmlns";
}

function matchesNamedNamespaceDeclaration(
  attributePrefix: string | null,
  localName: string,
  prefix: string,
): boolean {
  return attributePrefix === "xmlns" && localName === prefix;
}

function namespaceDeclarationNameMatches(attribute: Idl.Attr, prefix: string | null): boolean {
  const attributePrefix = attribute.prefix === undefined ? null : attribute.prefix;
  const localName = attribute.localName || attribute.name;
  return prefix === null
    ? matchesDefaultNamespaceDeclaration(attributePrefix, localName)
    : matchesNamedNamespaceDeclaration(attributePrefix, localName, prefix);
}

function matchesNamespaceDeclaration(attribute: Idl.Attr, prefix: string | null): boolean {
  if ((attribute.namespaceURI || null) !== XMLNS_NS) return false;
  return namespaceDeclarationNameMatches(attribute, prefix);
}

function namespaceAtElement(
  element: NamespaceLookupNode,
  prefix: string | null,
): NamespaceAttributeResult<string | null> {
  const elementPrefix = element.prefix === undefined ? null : element.prefix;
  const elementNamespace = element.namespaceURI || null;
  if (elementNamespace && elementPrefix === prefix) {
    return { found: true, value: elementNamespace };
  }
  return findNamespaceAttribute(
    element,
    (attribute) => matchesNamespaceDeclaration(attribute, prefix),
    (attribute) => attribute.value || null,
  );
}

function locateNamespace(elem: NamespaceLookupNode, prefix: string | null): string | null {
  let current: NamespaceLookupNode | null = elem;
  while (current && current.nodeType === ELEMENT_NODE) {
    const namespace = namespaceAtElement(current, prefix);
    if (namespace.found) return namespace.value;
    current = current.parentNode;
  }
  return null;
}

function namespaceLookupRoot(node: NamespaceLookupNode): NamespaceLookupNode | null {
  switch (node.nodeType) {
    case ELEMENT_NODE:
      return node;
    case DOCUMENT_NODE:
      return node.documentElement || null;
    case ATTRIBUTE_NODE:
      return node.ownerElement ?? null;
    default:
      return node.parentNode;
  }
}

function namespaceElementFromNode(node: NamespaceLookupNode): NamespaceLookupNode | null {
  return nearestNamespaceElement(namespaceLookupRoot(node));
}

function nearestNamespaceElement(node: NamespaceLookupNode | null): NamespaceLookupNode | null {
  let current = node;
  while (current && current.nodeType !== ELEMENT_NODE) current = current.parentNode;
  return current;
}

function lookupNamespaceURIForNode(
  node: NamespaceLookupNode,
  prefix: string | null,
): string | null {
  const normalizedPrefix = prefix === "" ? null : prefix;
  const element = namespaceElementFromNode(node);
  if (!element) return null;
  if (normalizedPrefix === "xml") return XML_NS;
  if (normalizedPrefix === "xmlns") return XMLNS_NS;
  return locateNamespace(element, normalizedPrefix);
}

NodeBase.prototype.lookupNamespaceURI = function (
  this: NamespaceLookupNode,
  prefix: string | null,
): string | null {
  return lookupNamespaceURIForNode(this, prefix);
};

function matchesPrefixDeclaration(attribute: Idl.Attr, namespace: string): boolean {
  return (
    (attribute.namespaceURI || null) === XMLNS_NS &&
    attribute.prefix === "xmlns" &&
    (attribute.value || null) === namespace
  );
}

function prefixAtElement(
  element: NamespaceLookupNode,
  namespace: string,
): NamespaceAttributeResult<string> {
  const elementPrefix = element.prefix === undefined ? null : element.prefix;
  const elementNamespace = element.namespaceURI || null;
  if (elementNamespace === namespace && elementPrefix) {
    return { found: true, value: elementPrefix };
  }
  return findNamespaceAttribute(
    element,
    (attribute) => matchesPrefixDeclaration(attribute, namespace),
    (attribute) => attribute.localName || attribute.name,
  );
}

function lookupPrefixForNode(node: NamespaceLookupNode, namespace: string | null): string | null {
  if (!namespace) return null;
  let current = namespaceElementFromNode(node);
  while (current && current.nodeType === ELEMENT_NODE) {
    const prefix = prefixAtElement(current, namespace);
    if (prefix.found) return prefix.value;
    current = current.parentNode;
  }
  return null;
}

NodeBase.prototype.lookupPrefix = function (
  this: NamespaceLookupNode,
  namespace: string | null,
): string | null {
  return lookupPrefixForNode(this, namespace);
};
NodeBase.prototype.isDefaultNamespace = function (namespace: string | null): boolean {
  const ns = namespace === "" ? null : namespace;
  const def = this.lookupNamespaceURI(null);
  return def === ns;
};
function hasBaseElementId(baseId: number): boolean {
  return baseId > 0;
}

function isEmptyBaseHref(href: unknown): boolean {
  return href == null || href === "";
}

function readBaseHref(): unknown | null {
  try {
    const baseId = dom ? dom.querySelector("base[href]") : -1;
    if (!hasBaseElementId(baseId)) return null;
    const node = nodeFor(baseId);
    const href = baseHrefFromNode(node);
    if (isEmptyBaseHref(href)) return null;
    return href;
  } catch {}
  return null;
}

function baseHrefFromNode(node: any): unknown {
  return node && typeof node.getAttribute === "function" ? node.getAttribute("href") : null;
}

function resolveBaseHref(href: unknown, docUrl: string): string {
  try {
    return new URL(String(href), docUrl).toString();
  } catch {
    return docUrl;
  }
}

function computeBaseURI(): string {
  const docUrl = pageUrl || "about:blank";
  const href = readBaseHref();
  if (href === null) return docUrl;
  return resolveBaseHref(href, docUrl);
}

Object.defineProperty(NodeBase.prototype, "baseURI", {
  configurable: true,
  enumerable: true,
  get: function () {
    return computeBaseURI();
  },
});

type NodeEqualityComparator = (left: any, right: any) => boolean;

function equalDefaultedNodeField(left: any, right: any, field: string): boolean {
  return (left[field] || "") === (right[field] || "");
}

function equalDoctypeNodes(left: any, right: any): boolean {
  return (
    equalDefaultedNodeField(left, right, "name") &&
    equalDefaultedNodeField(left, right, "publicId") &&
    equalDefaultedNodeField(left, right, "systemId")
  );
}

function equalAttributeNodes(left: any, right: any): boolean {
  return (
    left.namespaceURI === right.namespaceURI &&
    left.localName === right.localName &&
    left.value === right.value
  );
}

function equalProcessingInstructions(left: any, right: any): boolean {
  return (
    equalDefaultedNodeField(left, right, "target") && equalDefaultedNodeField(left, right, "data")
  );
}

function equalCharacterDataNodes(left: any, right: any): boolean {
  return (left.data || "") === (right.data || "");
}

const LEAF_NODE_COMPARATORS: Partial<Record<number, NodeEqualityComparator>> = {
  [DOCTYPE_NODE]: equalDoctypeNodes,
  [ATTRIBUTE_NODE]: equalAttributeNodes,
  [PROCESSING_INSTRUCTION_NODE]: equalProcessingInstructions,
  [TEXT_NODE]: equalCharacterDataNodes,
  [CDATA_SECTION_NODE]: equalCharacterDataNodes,
  [COMMENT_NODE]: equalCharacterDataNodes,
};

function nodeAttributeKey(attribute: any): string {
  return (attribute.namespaceURI || "") + "|" + attribute.localName;
}

function elementAttributeValues(attributes: ArrayLike<any>): Map<string, unknown> {
  const values = new Map<string, unknown>();
  for (let index = 0; index < attributes.length; index++) {
    const attribute = attributes[index];
    values.set(nodeAttributeKey(attribute), attribute.value);
  }
  return values;
}

function equalElementAttributes(left: any, right: any): boolean {
  const leftAttributes = left.attributes;
  const rightAttributes = right.attributes;
  if (leftAttributes.length !== rightAttributes.length) return false;
  const values = elementAttributeValues(leftAttributes);
  for (let index = 0; index < rightAttributes.length; index++) {
    const attribute = rightAttributes[index];
    const key = nodeAttributeKey(attribute);
    if (!values.has(key) || values.get(key) !== attribute.value) return false;
  }
  return true;
}

function equalElementDetails(left: any, right: any): boolean {
  const sameName =
    left.namespaceURI === right.namespaceURI &&
    left.prefix === right.prefix &&
    left.localName === right.localName;
  return sameName && equalElementAttributes(left, right);
}

function equalNodeShellDetails(left: any, right: any): boolean {
  if (left.nodeType !== ELEMENT_NODE) return true;
  return equalElementDetails(left, right);
}

function equalNodeIdentity(left: any, right: any): boolean {
  return !!left && !!right && left.nodeType === right.nodeType;
}

function equalNodeChildren(left: any, right: any): boolean {
  const ac = left.childNodes;
  const bc = right.childNodes;
  if (ac.length !== bc.length) return false;
  for (let i = 0; i < ac.length; i++) {
    if (!isEqualNode(ac[i], bc[i])) return false;
  }
  return true;
}

function isEqualNode(a, b): boolean {
  if (!equalNodeIdentity(a, b)) return false;
  if (a === b) return true;
  if (!equalNodeShellDetails(a, b)) return false;
  const compareLeaf = LEAF_NODE_COMPARATORS[a.nodeType];
  if (compareLeaf) return compareLeaf(a, b);
  return equalNodeChildren(a, b);
}

const disconnectedRootOrder = new WeakMap<object, number>();
let nextDisconnectedRootOrder = 1;

type PositionNode = Idl.Node & { readonly _id?: unknown };

function rootOrder(root: object): number {
  let order = disconnectedRootOrder.get(root);
  if (order === undefined) {
    order = nextDisconnectedRootOrder++;
    disconnectedRootOrder.set(root, order);
  }
  return order;
}

function nodeAncestorChain(node: PositionNode): PositionNode[] {
  const chain: PositionNode[] = [];
  let current: PositionNode | null = node;
  while (current) {
    chain.unshift(current);
    current = current.parentNode;
  }
  return chain;
}

function disconnectedPosition(leftRoot: PositionNode, rightRoot: PositionNode): number {
  const flags = DOCUMENT_POSITION_DISCONNECTED | DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC;
  const order =
    rootOrder(leftRoot) < rootOrder(rightRoot)
      ? DOCUMENT_POSITION_FOLLOWING
      : DOCUMENT_POSITION_PRECEDING;
  return flags | order;
}

function sharedChainLength(left: readonly PositionNode[], right: readonly PositionNode[]): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) index++;
  return index;
}

function samePositionNode(left: PositionNode | null, right: PositionNode): boolean {
  if (left === right) return true;
  // Null slots must still throw, rather than silently changing sibling ordering.
  if (left === null) throw new TypeError("Cannot read properties of null (reading '_id')");
  return left._id != null && left._id === right._id;
}

function compareSiblingPosition(
  parent: PositionNode,
  left: PositionNode,
  right: PositionNode,
): number {
  const children = parent.childNodes;
  for (let index = 0; index < children.length; index++) {
    if (samePositionNode(children[index], left)) return DOCUMENT_POSITION_FOLLOWING;
    if (samePositionNode(children[index], right)) return DOCUMENT_POSITION_PRECEDING;
  }
  return DOCUMENT_POSITION_DISCONNECTED;
}

function compareRelatedPosition(
  left: readonly PositionNode[],
  right: readonly PositionNode[],
  sharedLength: number,
): number {
  if (sharedLength === left.length) {
    return DOCUMENT_POSITION_FOLLOWING | DOCUMENT_POSITION_CONTAINED_BY;
  }
  if (sharedLength === right.length) {
    return DOCUMENT_POSITION_PRECEDING | DOCUMENT_POSITION_CONTAINS;
  }
  return compareSiblingPosition(left[sharedLength - 1], left[sharedLength], right[sharedLength]);
}

function compareDocumentPosition(self: PositionNode, other: PositionNode): number {
  if (!other) throw new TypeError("compareDocumentPosition: argument required");
  if (self === other) return 0;
  const left = nodeAncestorChain(self);
  const right = nodeAncestorChain(other);
  if (left[0] !== right[0]) return disconnectedPosition(left[0], right[0]);
  return compareRelatedPosition(left, right, sharedChainLength(left, right));
}
class CharacterDataNode extends NodeBase implements Idl.CharacterData {
  // length is uniform across subclasses: just .data.length.
  get length() {
    return this.data.length;
  }

  substringData(offset, count) {
    if (arguments.length < 2) {
      throw new TypeError(
        "substringData: 2 arguments required, but only " + arguments.length + " present",
      );
    }
    const data = this.data;
    const len = data.length;
    offset = toUint32(offset);
    count = toUint32(count);
    if (offset > len) {
      throw new DOMException(
        "substringData: offset " + offset + " is greater than length " + len,
        "IndexSizeError",
      );
    }
    const end = offset + count > len ? len : offset + count;
    return data.slice(offset, end);
  }

  appendData(data) {
    if (arguments.length < 1) {
      throw new TypeError("appendData: 1 argument required, but 0 present");
    }
    this.replaceData(this.length, 0, data);
  }

  insertData(offset, data) {
    if (arguments.length < 2) {
      throw new TypeError(
        "insertData: 2 arguments required, but only " + arguments.length + " present",
      );
    }
    this.replaceData(offset, 0, data);
  }

  deleteData(offset, count) {
    if (arguments.length < 2) {
      throw new TypeError(
        "deleteData: 2 arguments required, but only " + arguments.length + " present",
      );
    }
    this.replaceData(offset, count, "");
  }

  replaceData(offset, count, data) {
    if (arguments.length < 3) {
      throw new TypeError(
        "replaceData: 3 arguments required, but only " + arguments.length + " present",
      );
    }
    const cur = this.data;
    const len = cur.length;
    offset = toUint32(offset);
    count = toUint32(count);
    if (offset > len) {
      throw new DOMException(
        "replaceData: offset " + offset + " is greater than length " + len,
        "IndexSizeError",
      );
    }
    if (offset + count > len) count = len - offset;
    const insertion = String(data);
    // Range offsets must use the original text, so adjust them before the data write.
    rangeBeforeReplaceData(this, offset, count, insertion.length);
    const next = cur.slice(0, offset) + insertion + cur.slice(offset + count);
    suppressRangeUpdate = true;
    try {
      writeCharacterData(this, next);
    } finally {
      suppressRangeUpdate = false;
    }
  }
}

let suppressRangeUpdate = false;

function currentCharacterDataLength(node: any): number {
  return typeof node.data === "string"
    ? node.data.length
    : typeof (node._info && node._info.nodeValue) === "string"
      ? node._info.nodeValue.length
      : 0;
}

function previousCommentData(node: any): string {
  return commentData.get(node._id) ?? (node._info && node._info.nodeValue) ?? "";
}

function previousNodeInfoData(node: any): string {
  return (node._info && node._info.nodeValue) || "";
}

function readPreviousCharacterData(node: any): string {
  if (node.nodeType === COMMENT_NODE) return previousCommentData(node);
  if (typeof node.data === "string") return node.data;
  return previousNodeInfoData(node);
}

function updateCharacterDataRanges(node: any, next: string): void {
  if (suppressRangeUpdate) return;
  rangeBeforeReplaceData(node, 0, currentCharacterDataLength(node), next.length);
}

function writeCommentCharacterData(node: any, next: string, oldValue: string): void {
  commentData.set(node._id, next);
  if (typeof (dom as any).setCommentData === "function") {
    try {
      (dom as any).setCommentData(node._id, next);
    } catch {}
  }
  recordCharacterDataMutation(node, oldValue);
}

function writeLiveTextCharacterData(node: any, next: string, oldValue: string): void {
  if (typeof dom.setNodeText === "function") {
    try {
      dom.setNodeText(node._id, next);
      bumpMutationSeq("data");
      recordCdpMutation({
        kind: "characterDataModified",
        nodeId: node._id,
        characterData: next,
      });
      recordCharacterDataMutation(node, oldValue);
      return;
    } catch {}
  }
  recordOp({ kind: "setNodeText", node: node._id, text: next });
  recordCharacterDataMutation(node, oldValue);
}

function normalizeCharacterDataValue(value: unknown): string {
  return value === null ? "" : String(value);
}

function writeCharacterData(node: any, value: unknown): void {
  if (!node) return;
  const next = normalizeCharacterDataValue(value);
  updateCharacterDataRanges(node, next);
  const oldValue = readPreviousCharacterData(node);
  if (node._info) node._info.nodeValue = next;
  if (node._id < 0) {
    recordCharacterDataMutation(node, oldValue);
    return;
  }
  if (node.nodeType === COMMENT_NODE) {
    writeCommentCharacterData(node, next, oldValue);
    return;
  }
  writeLiveTextCharacterData(node, next, oldValue);
}

function isCachedNodeWrapperArgument(arg: unknown, info: unknown): boolean {
  return (
    typeof arg === "number" &&
    info !== null &&
    typeof info === "object" &&
    typeof Reflect.get(info, "nodeType") === "number"
  );
}

function createTextNodeBacking(arg: unknown): {
  id: number;
  data: string;
  info: any;
} {
  const data = arg === undefined ? "" : String(arg);
  const id = dom.createTextNode(data);
  const info = (dom.nodeInfo ? dom.nodeInfo(id) : null) || {
    nodeType: TEXT_NODE,
    nodeName: "#text",
    localName: "",
    nodeValue: data,
  };
  return { id, data, info };
}

function createCommentNodeBacking(arg: unknown): {
  id: number;
  data: string;
  info: any;
} {
  const data = arg === undefined ? "" : String(arg);
  const id = dom.createComment(data);
  commentData.set(id, data);
  const info = (dom.nodeInfo ? dom.nodeInfo(id) : null) || {
    nodeType: COMMENT_NODE,
    nodeName: "#comment",
    localName: "",
    nodeValue: data,
  };
  return { id, data, info };
}

function hasSurrogateCodeUnit(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdfff) return true;
  }
  return false;
}

function refreshTextInfoFromDom(node: TextNode): void {
  try {
    const fresh = dom.nodeInfo(node._id);
    if (fresh) node._info = fresh;
  } catch {}
}

class TextNode extends CharacterDataNode implements Idl.Text {
  // NodeBase.prototype installs the Slottable mixin's assignedSlot.
  declare readonly assignedSlot: Idl.HTMLSlotElement | null;
  _typeCheckSeq?: number;
  constructor(arg, info) {
    if (isCachedNodeWrapperArgument(arg, info)) {
      super(arg, info);
      return;
    }
    const backing = createTextNodeBacking(arg);
    super(backing.id, backing.info);
    this._typeCheckSeq = ksState().mutationSeq | 0;
    cache.set(backing.id, this);
  }
  _refreshTextInfo(): void {
    const curSeq = ksState().mutationSeq | 0;
    if (this._typeCheckSeq === curSeq) return;
    const cached = this._info && this._info.nodeValue;
    if (typeof cached === "string" && hasSurrogateCodeUnit(cached)) {
      this._typeCheckSeq = curSeq;
      return;
    }
    refreshTextInfoFromDom(this);
    this._typeCheckSeq = curSeq;
  }
  get data() {
    this._refreshTextInfo();
    return this._info.nodeValue || "";
  }
  set data(v) {
    writeCharacterData(this, v);
  }
  get textContent() {
    this._refreshTextInfo();
    return this._info.nodeValue || "";
  }
  set textContent(v) {
    writeCharacterData(this, v);
  }
  get nodeValue() {
    this._refreshTextInfo();
    return this._info.nodeValue || "";
  }
  set nodeValue(v) {
    writeCharacterData(this, v);
  }

  splitText(offset: number): TextNode {
    const cur = this.data;
    const len = cur.length;
    offset = toUint32(offset);
    if (offset > len) {
      throw new DOMException(
        "splitText: offset " + offset + " is greater than length " + len,
        "IndexSizeError",
      );
    }
    const tail = cur.slice(offset);
    suppressRangeUpdate = true;
    try {
      writeCharacterData(this, cur.slice(0, offset));
    } finally {
      suppressRangeUpdate = false;
    }
    const next = createTextNodeInternal(tail);
    const parent = this.parentNode;
    if (parent) {
      const sib = this.nextSibling;
      if (sib) parent.insertBefore(next, sib);
      else parent.appendChild(next);
    }
    rangeAfterSplitText(this, offset, next);
    return next;
  }

  get wholeText() {
    const isTextish = (n: NodeBase | null): n is NodeBase => {
      if (!n) return false;
      const t = n.nodeType;
      return t === TEXT_NODE || t === CDATA_SECTION_NODE;
    };
    let first: NodeBase = this;
    while (isTextish(first.previousSibling)) first = first.previousSibling;
    let out = "";
    let cur: NodeBase | null = first;
    while (isTextish(cur)) {
      out += cur.data;
      cur = cur.nextSibling;
    }
    return out;
  }
}

class CommentNode extends CharacterDataNode implements Idl.Comment {
  _typeCheckSeq?: number;
  constructor(arg, info) {
    if (isCachedNodeWrapperArgument(arg, info)) {
      super(arg, info);
      return;
    }
    const backing = createCommentNodeBacking(arg);
    super(backing.id, backing.info);
    this._typeCheckSeq = ksState().mutationSeq | 0;
    cache.set(backing.id, this);
  }
  get data() {
    const v = commentData.get(this._id);
    if (v != null) return v;
    return this._info.nodeValue || "";
  }
  set data(v) {
    writeCharacterData(this, v);
  }
  get textContent() {
    return this.data;
  }
  set textContent(v) {
    writeCharacterData(this, v);
  }
  get nodeValue() {
    return this.data;
  }
  set nodeValue(v) {
    writeCharacterData(this, v);
  }
}

class DocumentTypeNode extends NodeBase implements Idl.DocumentType {
  // Backed by _info (populated from wasm or constructor params).
  // `declare` keeps them type-only — the runtime values live on
  // `_info` and are read via the getters defined below.
  declare publicId: string;
  declare systemId: string;
  get name() {
    return this._info.nodeName;
  }
  get textContent() {
    return null;
  }
  set textContent(_v) {}
  get parentNode() {
    const sp = syntheticParent.get(this);
    if (sp) return sp;
    return super.parentNode;
  }
  get ownerDocument() {
    const sp = syntheticParent.get(this);
    if (sp) return sp;
    const owner = nodeOwnerDoc.get(this);
    if (owner) return owner;
    return super.ownerDocument;
  }
  cloneNode(_deep) {
    const synth = Object.create(DocumentTypeNode.prototype);
    Object.defineProperty(synth, "_info", {
      value: {
        nodeType: DOCTYPE_NODE,
        nodeName: this._info.nodeName,
        localName: "",
        nodeValue: "",
      },
      enumerable: false,
    });
    Object.defineProperty(synth, "_id", {
      value: nextSyntheticId(),
      enumerable: false,
    });
    Object.defineProperty(synth, "name", {
      value: this.name || "",
    });
    Object.defineProperty(synth, "publicId", {
      value: this.publicId || "",
    });
    Object.defineProperty(synth, "systemId", {
      value: this.systemId || "",
    });
    return synth;
  }
}

class GenericNode extends NodeBase {}

export {
  KsEventTarget,
  NodeBase,
  CharacterDataNode,
  TextNode,
  CommentNode,
  DocumentTypeNode,
  GenericNode,
  toUint32,
  isNodeLike,
  assertNotDocumentChild,
  assertOneElementChild,
  assertDocumentInsertAllowed,
  assertDoctypeOnlyInDocument,
  assertNotTextIntoDocument,
  assertNotAncestor,
  assertCanHaveChildren,
  isTemplateElement,
  ensureTemplateContent,
  locateNamespace,
  isEqualNode,
  compareDocumentPosition,
  copyCommentDataToClone,
  copyElemNsToClone,
  collectTextContent,
};
