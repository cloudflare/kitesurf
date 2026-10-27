// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements node wrappers, tree mutations, cloning, and text operations over the wasm DOM.

import type { DomHandle, KsNodeInfo } from "../../core/pkg/kitesurf_core";
import type * as Idl from "./idl/types.generated.js";
import {
  ksGlobal,
  dom,
  documentImpl as document,
  liveDocument,
  liveWindow,
  pageUrl,
  nodeFor,
  elementFor,
  isElementNode,
  isShadowRootNode,
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
  type NodeOwnerDocument,
  syntheticParent,
  fragmentIds,
  templateContentFragment,
  stampedPiIds,
  commentData,
  nodeListCache,
} from "./registries.js";
import { getInternalState } from "./internal-state.js";
import type { DocumentFragmentImpl, NodeListCls } from "./collections.js";
import type { DetachedDocument } from "./document.js";
import type { ParsedElement } from "./parser.js";
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
import { ksInternals } from "./internals.js";

const MAX_CONNECTED_NODE_ANCESTOR_HOPS = 8192;

function notifyConnectedCallbacks(child: NodeBase): void {
  const hook = ksInternals.notifyConnected;
  if (typeof hook === "function") {
    try {
      hook(child);
    } catch {}
  }
}

function ksState() {
  return getInternalState();
}

// A wrapper adoptIntoDom can move: a live wrapper or a DOMParser one,
// seen through the fields it rewrites.
// _id is whatever the page left there; parentNode and ownerDocument are
// written as plain assignments, which throw on a live wrapper's getters.
export type AdoptableNode = {
  _dom?: DomHandle;
  _id?: unknown;
  parentNode?: unknown;
  ownerDocument?: unknown;
};

// _id and _dom as the tree checks read them off any node argument: a
// DetachedDocument has neither, a live wrapper has no _dom, and a DOMParser
// node has both.
function treeId(n: object): unknown {
  return Reflect.get(n, "_id");
}
function treeDom(n: object): unknown {
  return Reflect.get(n, "_dom");
}

// The parent side of the tree checks: a node wrapper, or a DetachedDocument.
type TreeParent = NodeBase | DetachedDocument;
// A node argument the tree checks read. The IDL says Node; page code may
// pass any object, and the checks read nodeType, _id and _dom themselves.
type TreeArg = TreeParent | ParsedElement;

export function adoptIntoDom(
  destDom: DomHandle,
  wrapper: AdoptableNode | null | undefined,
  destOwnerDoc?: unknown,
): void {
  if (!wrapper || !wrapper._dom || wrapper._dom === destDom) return;
  const sourceDom = wrapper._dom;
  // wasm-bindgen converts a node id argument to a number; do it here.
  const sourceId = Number(wrapper._id);
  let info: KsNodeInfo | null;
  try {
    info = sourceDom.nodeInfo(sourceId);
  } catch {
    info = null;
  }
  if (!info) return;
  let newId: number;
  if (info.nodeType === ELEMENT_NODE) {
    const tag = (info.nodeName || "DIV").toLowerCase();
    try {
      newId = destDom.createElement(tag);
    } catch {
      return;
    }
    const attrs = parsedAttrs(sourceDom, sourceId);
    for (const a of attrs) {
      try {
        destDom.setAttribute(newId, a.name, a.value);
      } catch {}
    }
  } else if (info.nodeType === TEXT_NODE) {
    let text = "";
    try {
      text = sourceDom.textContent(sourceId) || "";
    } catch {}
    try {
      newId = destDom.createTextNode(text);
    } catch {
      return;
    }
  } else {
    return;
  }
  wrapper._dom = destDom;
  wrapper._id = newId;
  if (destDom === dom) adoptedWrapperIds.add(newId);
  if (destOwnerDoc !== undefined) wrapper.ownerDocument = destOwnerDoc;
}

// The clone of a node inside a tree: cloneNode answers a DetachedDocument
// only for a document and null only for a synthetic node with no clone,
// neither of which a fragment, a document's children or a Range clones.
export function cloneWrapper(node: NodeBase, deep: boolean): NodeBase {
  const clone = node.cloneNode(deep);
  if (!clone || !NodeBase.prototype.isPrototypeOf(clone)) {
    throw new TypeError("cloneNode: this node has no wrapper clone");
  }
  return clone as NodeBase;
}

export function parsedAttrs(handle: DomHandle, id: number): Array<{ name: string; value: string }> {
  let info;
  try {
    info = handle.nodeInfo(id);
  } catch {
    return [];
  }
  if (!info || !Array.isArray(info.attributes)) return [];
  const out: Array<{ name: string; value: string }> = [];
  for (let i = 0; i < info.attributes.length - 1; i += 2) {
    const name = info.attributes[i];
    const value = info.attributes[i + 1];
    if (typeof name === "string" && typeof value === "string") {
      out.push({ name, value });
    }
  }
  return out;
}

function copyCommentDataToClone(sourceId: number, cloneId: number): void {
  if (typeof sourceId !== "number" || typeof cloneId !== "number") return;
  let srcInfo: KsNodeInfo | null, cloneInfo: KsNodeInfo | null;
  try {
    srcInfo = dom.nodeInfo(sourceId);
  } catch {
    return;
  }
  try {
    cloneInfo = dom.nodeInfo(cloneId);
  } catch {
    return;
  }
  if (!srcInfo || !cloneInfo) return;
  if (srcInfo.nodeType === COMMENT_NODE) {
    const text = commentData.get(sourceId) ?? "";
    commentData.set(cloneId, text);
    try {
      dom.setCommentData(cloneId, text);
    } catch {}
  }
  let srcChildren: ArrayLike<number> = [];
  let cloneChildren: ArrayLike<number> = [];
  try {
    srcChildren = dom.childIds(sourceId);
  } catch {}
  try {
    cloneChildren = dom.childIds(cloneId);
  } catch {}
  const n = Math.min(srcChildren?.length || 0, cloneChildren?.length || 0);
  for (let i = 0; i < n; i++) {
    copyCommentDataToClone(srcChildren[i], cloneChildren[i]);
  }
}
function copyElemNsToClone(sourceId: number, cloneId: number): void {
  if (typeof sourceId !== "number" || typeof cloneId !== "number") return;
  const entry = elemNs.get(sourceId);
  if (entry) {
    elemNs.set(cloneId, { qname: entry.qname, ns: entry.ns, viaNS: entry.viaNS });
    if (entry.viaNS !== false) {
      fastpathMarkSpecial(cloneId);
    }
  }
  let srcChildren: ArrayLike<number> = [];
  let cloneChildren: ArrayLike<number> = [];
  try {
    srcChildren = dom.childIds(sourceId);
  } catch {}
  try {
    cloneChildren = dom.childIds(cloneId);
  } catch {}
  const n = Math.min(srcChildren?.length || 0, cloneChildren?.length || 0);
  for (let i = 0; i < n; i++) {
    copyElemNsToClone(srcChildren[i], cloneChildren[i]);
  }
}

function unwrappedSubtreeIds(nodeId: number): number[] | null {
  if (hasLiveWrapper(nodeId) || adoptedWrapperIds.has(nodeId)) return null;
  try {
    const descendants = Array.from(dom.descendantsOf(nodeId));
    if (descendants.some((id) => hasLiveWrapper(id) || adoptedWrapperIds.has(id))) return null;
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
  if (nodeId < 0) return false;
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

function collectTextContent(rootId: number): string {
  let out = "";
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    if (id == null || id < 0) continue;
    if (stampedPiIds.has(id)) continue;
    let info;
    try {
      info = dom.nodeInfo(id);
    } catch {
      continue;
    }
    if (!info) continue;
    if (info.nodeType === TEXT_NODE) {
      out += info.nodeValue || "";
      continue;
    }
    if (info.nodeType !== ELEMENT_NODE && info.nodeType !== DOCUMENT_FRAGMENT_NODE) continue;
    const kids = Array.from(dom.childIds(id));
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return out;
}
function toUint32(v: number): number {
  return v >>> 0;
}

function isNodeLike(v: unknown): v is NodeBase {
  if (v == null) return false;
  if (typeof v !== "object" && typeof v !== "function") return false;
  // A node-like object is treated as a node wrapper from here on.
  if (typeof Reflect.get(v, "_id") === "number") return true;
  if (typeof Reflect.get(v, "nodeType") === "number") return true;
  return false;
}

function assertNotDocumentChild(child: TreeArg | null | undefined, op: string): void {
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

function assertOneElementChild(
  parent: TreeParent,
  newChild: TreeArg | null | undefined,
  op: string,
): void {
  if (!newChild) return;
  let pType;
  try {
    pType = parent.nodeType;
  } catch {
    return;
  }
  const parentId = treeId(parent);
  const isHostStandIn = typeof parentId === "number" && hostIdToDoc.has(parentId);
  const parentIsDoc = pType === DOCUMENT_NODE || isHostStandIn;
  if (!parentIsDoc) return;
  let cType;
  try {
    cType = newChild.nodeType;
  } catch {
    return;
  }
  if (cType !== ELEMENT_NODE) return;
  const doc = isHostStandIn && typeof parentId === "number" ? hostIdToDoc.get(parentId) : parent;
  let existing = 0;
  // Reading through undefined threw into the catch below, which returns.
  if (!doc) return;
  try {
    const kids = doc.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      if (k && k.nodeType === ELEMENT_NODE && k !== newChild) existing++;
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

function isHierarchyRequestError(error: unknown) {
  // Fragment validation rethrows only wrapper errors named HierarchyRequestError.
  return !!error && (error as { name?: unknown }).name === "HierarchyRequestError";
}

function fragmentDocumentChildCounts(fragment: NodeBase, op: string) {
  let elements = 0;
  let doctypes = 0;
  try {
    for (const child of fragment.childNodes) {
      const nodeType = child && child.nodeType;
      if (nodeType === TEXT_NODE || nodeType === CDATA_SECTION_NODE) {
        throw new DOMException(
          op + ": Document cannot have a Text node child",
          "HierarchyRequestError",
        );
      }
      if (nodeType === ELEMENT_NODE) elements++;
      else if (nodeType === DOCTYPE_NODE) doctypes++;
    }
  } catch (error) {
    if (isHierarchyRequestError(error)) throw error;
  }
  return { elements, doctypes };
}

function assertDocumentInsertAllowed(
  doc: TreeParent,
  nodes: readonly unknown[],
  op: string,
  _atFront: boolean,
  ignoreExisting?: boolean,
): void {
  let existingElements = 0;
  let existingDoctypes = 0;
  if (!ignoreExisting) {
    for (const c of doc.childNodes) {
      const nt = c && c.nodeType;
      if (nt === ELEMENT_NODE) existingElements++;
      else if (nt === DOCTYPE_NODE) existingDoctypes++;
    }
  }
  let incomingElements = 0;
  let incomingDoctypes = 0;
  for (const n of nodes) {
    if (!isNodeLike(n)) {
      throw new DOMException(
        op + ": Document cannot have a Text node child",
        "HierarchyRequestError",
      );
    }
    const nt = n.nodeType;
    if (nt === TEXT_NODE || nt === CDATA_SECTION_NODE) {
      throw new DOMException(
        op + ": Document cannot have a Text node child",
        "HierarchyRequestError",
      );
    }
    if (nt === DOCUMENT_FRAGMENT_NODE) {
      const counts = fragmentDocumentChildCounts(n, op);
      incomingElements += counts.elements;
      incomingDoctypes += counts.doctypes;
      continue;
    }
    if (nt === ELEMENT_NODE) incomingElements++;
    else if (nt === DOCTYPE_NODE) incomingDoctypes++;
  }
  if (existingElements + incomingElements > 1) {
    throw new DOMException(
      op + ": Document can only have one Element child",
      "HierarchyRequestError",
    );
  }
  if (existingDoctypes + incomingDoctypes > 1) {
    throw new DOMException(
      op + ": Document can only have one DocumentType child",
      "HierarchyRequestError",
    );
  }
  if (!ignoreExisting) {
    if (!_atFront && incomingDoctypes > 0 && existingElements > 0) {
      throw new DOMException(
        op + ": Document doctype must precede element",
        "HierarchyRequestError",
      );
    }
    if (_atFront && incomingElements > 0 && existingDoctypes > 0) {
      throw new DOMException(
        op + ": Document doctype must precede element",
        "HierarchyRequestError",
      );
    }
  }
}

function assertDoctypeOnlyInDocument(
  parent: TreeParent,
  child: TreeArg | null | undefined,
  op: string,
): void {
  if (!child) return;
  let nt;
  try {
    nt = child.nodeType;
  } catch {
    return;
  }
  if (nt !== DOCTYPE_NODE) return;
  let pType;
  try {
    pType = parent.nodeType;
  } catch {
    return;
  }
  const parentId = treeId(parent);
  const isHostStandIn = typeof parentId === "number" && hostIdToDoc.has(parentId);
  if (pType !== DOCUMENT_NODE && !isHostStandIn) {
    throw new DOMException(
      op + ": doctype must be inserted into a document",
      "HierarchyRequestError",
    );
  }
}

function assertNotTextIntoDocument(
  parent: TreeParent,
  child: TreeArg | null | undefined,
  op: string,
): void {
  if (!child) return;
  let pType;
  try {
    pType = parent.nodeType;
  } catch {
    return;
  }
  const parentId = treeId(parent);
  const isHostStandIn = typeof parentId === "number" && hostIdToDoc.has(parentId);
  const parentIsDoc = pType === DOCUMENT_NODE || isHostStandIn;
  if (!parentIsDoc) return;
  let cType;
  try {
    cType = child.nodeType;
  } catch {
    return;
  }
  if (cType === TEXT_NODE) {
    throw new DOMException(
      op + ": cannot insert a Text node directly under a document",
      "HierarchyRequestError",
    );
  }
}

function assertNotAncestor(parent: TreeParent, node: TreeArg | null | undefined, op: string): void {
  if (!node) return;
  const rawNodeId = treeId(node);
  const nodeId = typeof rawNodeId === "number" ? rawNodeId : null;
  const nodeDom = treeDom(node);
  let cur: TreeParent | null = parent;
  while (cur) {
    const curDom = treeDom(cur);
    const curId = treeId(cur);
    const sharesDom = !nodeDom || !curDom || nodeDom === curDom;
    const same =
      nodeId !== null && typeof curId === "number" && sharesDom ? curId === nodeId : cur === node;
    if (same) {
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
  let t;
  try {
    t = self.nodeType;
  } catch {
    t = undefined;
  }
  if (typeof t !== "number") t = self._info && self._info.nodeType;
  if (typeof t === "number" && LEAF_PARENT_TYPES.has(t)) {
    const name = self.nodeName || (self._info && self._info.nodeName) || "leaf";
    throw new DOMException(
      op + ": " + name + " nodes cannot have children",
      "HierarchyRequestError",
    );
  }
}
function isTemplateElement(id: unknown): boolean {
  if (typeof id !== "number" || id < 0) return false;
  let info;
  try {
    info = dom.nodeInfo(id);
  } catch {
    return false;
  }
  if (!info || info.nodeType !== ELEMENT_NODE) return false;
  const tag = info.nodeName;
  if (tag !== "TEMPLATE" && tag !== "template") return false;
  const ns = elemNs.get(id);
  if (ns && ns.ns && ns.ns !== HTML_NS) return false;
  return true;
}

const TEMPLATE_CONTENT_FRAGMENT_TAG = "#document-fragment";

function ensureTemplateContent(templateId: number): DocumentFragmentImpl {
  let frag = templateContentFragment.get(templateId);
  if (frag) return frag;
  // The backing tag lets Rust keep template contents inert, unlike other detached elements.
  const fragId = dom.createElement(TEMPLATE_CONTENT_FRAGMENT_TAG);
  fragmentIds.add(fragId);
  frag = nodeFor(fragId) as DocumentFragmentImpl;
  templateContentFragment.set(templateId, frag);
  let kids: number[];
  try {
    kids = Array.from(dom.childIds(templateId));
  } catch {
    kids = [];
  }
  for (const kidId of kids) {
    try {
      dom.removeNode(kidId);
    } catch {}
    try {
      dom.appendChildNode(fragId, kidId);
    } catch {}
  }
  if (kids.length > 0) {
    bumpMutationSeq();
  }
  return frag;
}
function eventTargetKey(target: KsEventTarget): number | KsEventTarget {
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

// What a wrapper knows about its node: nodeInfo's snapshot, or the literal
// a synthetic node (doctype, processing instruction) builds by hand.
export type WrapperInfo = Pick<KsNodeInfo, "nodeType" | "nodeName" | "localName" | "nodeValue"> &
  Partial<KsNodeInfo>;

class NodeBase extends KsEventTarget implements Idl.Node {
  // Installed on the prototype below the class.
  declare baseURI: string;
  _id: number;
  _parentIdCache: number;
  _parentIdSeq: number;
  declare _typeCheckSeq?: number;
  declare _attrFlatCache?: string[] | null;
  _info: WrapperInfo;
  // Typed for NodeBase receivers, which always carry _info. `?.` because a
  // ParsedElement receiver borrows these getters without one, and reads
  // undefined, outside what TypeScript sees as `this`.
  get data(): string {
    return this._info?.nodeValue;
  }
  set data(_v: unknown) {}
  _attrFlat?(): string[];
  _serializeForAppend?(): string;
  get innerHTML(): string | undefined {
    return undefined;
  }
  set innerHTML(_v: unknown) {}
  declare isSameNode: (other: Idl.Node | null) => boolean;
  declare isEqualNode: (other: Idl.Node | null) => boolean;
  declare getRootNode: (options?: Idl.GetRootNodeOptions) => NodeBase | DetachedDocument;
  declare compareDocumentPosition: (other: Idl.Node) => number;
  declare lookupNamespaceURI: (prefix: string | null) => string | null;
  declare lookupPrefix: (ns: string | null) => string | null;
  declare isDefaultNamespace: (ns: string | null) => boolean;
  constructor(nodeId: number, info: WrapperInfo) {
    super();
    this._id = nodeId;
    this._info = info;
    this._parentIdCache = -2;
    this._parentIdSeq = -1;
  }
  static [Symbol.hasInstance](v: unknown): boolean {
    if (v == null) return false;
    if (typeof v !== "object" && typeof v !== "function") return false;
    if (NodeBase.prototype.isPrototypeOf(v)) return true;
    return typeof Reflect.get(v, "nodeType") === "number";
  }
  // A document's clone is a DetachedDocument (DocumentImpl.cloneNode).
  cloneNode(deep?: boolean): NodeBase | DetachedDocument | null {
    if (this._id < 0) return null;
    if (this.nodeType === PROCESSING_INSTRUCTION_NODE) {
      // createProcessingInstruction stamps target, a string, on the wrapper.
      const stamped: unknown = Reflect.get(this, "target");
      const tgt = stamped ? String(stamped) : this.nodeName || "";
      return liveDocument().createProcessingInstruction(tgt, this.data ?? "");
    }
    let cloneNode;
    if (deep === true) {
      const id = dom.deepCloneNode(this._id);
      if (id === 0) return null;
      try {
        copyCommentDataToClone(this._id, id);
      } catch {}
      try {
        copyElemNsToClone(this._id, id);
      } catch {}
      cloneNode = nodeFor(id);
    } else {
      const nt = this._info && this._info.nodeType;
      if (nt === TEXT_NODE) {
        return createTextNodeInternal(this.data ?? this._info.nodeValue ?? "");
      }
      if (nt === COMMENT_NODE) {
        return liveDocument().createComment(this.data ?? "");
      }
      if (nt === PROCESSING_INSTRUCTION_NODE) {
        // createProcessingInstruction stamps target, a string, on the wrapper.
        const stamped: unknown = Reflect.get(this, "target");
        const tgt = stamped ? String(stamped) : this.nodeName || "";
        return liveDocument().createProcessingInstruction(tgt, this.data ?? "");
      }
      if (nt === ELEMENT_NODE) {
        const nsEntry = elemNs.get(this._id);
        let clone: Element;
        if (nsEntry && nsEntry.viaNS !== false) {
          clone = createElementNSInternal(nsEntry.ns, nsEntry.qname);
        } else {
          const tag = this._info.localName || this._info.nodeName || "div";
          clone = createElementInternal(tag);
        }
        const attrs = this._attrFlat ? this._attrFlat() : [];
        for (let i = 0; i < attrs.length - 1; i += 2) {
          try {
            clone.setAttribute(attrs[i], attrs[i + 1]);
          } catch {}
        }
        cloneNode = clone;
      } else {
        const id = dom.deepCloneNode(this._id);
        if (id === 0) return null;
        cloneNode = nodeFor(id);
      }
    }
    // Both steps return at once for a null clone.
    if (cloneNode) {
      try {
        runCloneSteps(this, cloneNode);
        if (deep === true) {
          runCloneStepsDeep(this, cloneNode);
        }
      } catch {}
    }
    return cloneNode;
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
  get nodeValue(): string | null {
    return null;
  }
  set nodeValue(_v: string | null) {}
  get textContent(): string | null {
    if (this._id < 0) return this._info.nodeValue || "";
    if (stampedPiIds.size === 0) return dom.textContent(this._id);
    return collectTextContent(this._id);
  }
  set textContent(value: string | null) {
    if (this._id < 0) {
      const text = String(value ?? "");
      if (this._info) this._info.nodeValue = text;
      return;
    }
    const text = String(value ?? "");
    const existing: NodeBase[] = [];
    const removedIds: number[] = [];
    const rawIds = Array.from(dom.childIds(this._id));
    const observed = hasChildListObserver(this._id);
    const transientlyObserved = hasSubtreeObserver(this._id);
    for (const cid of rawIds) {
      removedIds.push(cid);
      // Preserve wrapped removed nodes when an observer needs them in the childList record.
      if (!observed && dropUnwrappedSubtree(cid)) continue;
      if (transientlyObserved) registerTransientObservers(cid);
      const c = nodeFor(cid);
      if (!c) continue;
      existing.push(c);
      runIteratorPreRemove(c);
      dom.removeNode(c._id);
    }
    if (observed) {
      for (const c of Array.from(this.childNodes)) {
        if (typeof c._id === "number" && c._id < 0) existing.push(c);
      }
    }
    let added: NodeBase[] = [];
    let addedId = -1;
    if (text.length > 0) {
      addedId = dom.createTextNode(text);
      dom.appendChildNode(this._id, addedId);
      if (observed) {
        const t = nodeFor(addedId);
        if (t) added = [t];
      }
    }
    bumpMutationSeq("text");
    for (const cid of removedIds) {
      recordCdpMutation({
        kind: "childNodeRemoved",
        parentNodeId: this._id,
        nodeId: cid,
      });
    }
    if (addedId >= 0) {
      recordCdpMutation({
        kind: "childNodeInserted",
        parentNodeId: this._id,
        previousNodeId: 0,
        nodeId: addedId,
      });
    }
    if (observed && (existing.length > 0 || added.length > 0)) {
      recordChildListMutation(this, added, existing, null, null);
    }
  }
  get childNodes(): NodeListCls<NodeBase> {
    const cached = nodeListCache.get(this);
    if (cached) return cached;
    const id = this._id;
    const list = makeNodeList(() => {
      const ids = Array.from(dom.childIds(id));
      return ids
        .map((cid) => cache.get(cid) || nodeFor(cid))
        .filter((n): n is NodeBase => n !== null);
    }, "childSeq");
    nodeListCache.set(this, list);
    return list;
  }
  get firstChild(): NodeBase | null {
    if (this == null) return null;
    const kids = childArray(this);
    return kids.length > 0 ? kids[0] : null;
  }
  get lastChild(): NodeBase | null {
    const kids = childArray(this);
    return kids.length > 0 ? kids[kids.length - 1] : null;
  }
  hasChildNodes() {
    return this.childNodes.length > 0;
  }
  contains(other: Idl.Node | null): boolean {
    if (other == null) return false;
    if (other === this) return true;
    const sp = syntheticParent.get(other);
    if (sp === (this as object)) return true;
    const otherId: unknown = Reflect.get(Object(other), "_id");
    if (typeof otherId !== "number") return false;
    let cur = otherId;
    let safety = 0;
    while (safety < MAX_NODE_ANCESTOR_HOPS) {
      if (cur === this._id) return true;
      let p;
      try {
        p = dom.parentId(cur);
      } catch {
        return false;
      }
      if (p < 0 || p === cur) return false;
      cur = p;
      safety++;
    }
    return false;
  }
  normalize() {
    const visit = (parent: NodeBase | null) => {
      if (!parent) return;
      const children: (NodeBase | null)[] = Array.from(parent.childNodes);
      for (let i = 0; i < children.length; i++) {
        const c = children[i];
        if (!c) continue;
        const t = c.nodeType;
        if (t === TEXT_NODE) {
          if (c.data.length === 0) {
            try {
              parent.removeChild(c);
            } catch {}
            children[i] = null;
            continue;
          }
          let merged = c.data;
          let j = i + 1;
          while (j < children.length) {
            const nx = children[j];
            if (!nx) break;
            const nt = nx.nodeType;
            if (nt !== TEXT_NODE) break;
            merged += nx.data;
            try {
              parent.removeChild(nx);
            } catch {}
            children[j] = null;
            j++;
          }
          if (merged !== c.data) c.data = merged;
          i = j - 1;
        } else if (t === ELEMENT_NODE) {
          visit(c);
        }
      }
    };
    visit(this);
  }

  get parentNode(): NodeBase | DetachedDocument | null {
    const curSeq = ksState().childSeq | 0;
    let p;
    if (this._parentIdSeq === curSeq && this._parentIdCache !== -2) {
      p = this._parentIdCache;
    } else {
      try {
        p = dom.parentId(this._id);
      } catch {
        return null;
      }
      this._parentIdCache = p;
      this._parentIdSeq = curSeq;
    }
    if (p < 0) return null;
    const hostDoc = hostIdToDoc.get(p);
    if (hostDoc) return hostDoc;
    return nodeFor(p);
  }
  get parentElement(): Element | null {
    const p = this.parentNode;
    return isElementNode(p) ? p : null;
  }
  get nextSibling(): NodeBase | null {
    if (this == null) return null;
    const kids = parentChildArray(this);
    if (!kids) return null;
    const i = indexById(kids, this._id);
    return i >= 0 && i + 1 < kids.length ? kids[i + 1] : null;
  }
  get previousSibling(): NodeBase | null {
    const kids = parentChildArray(this);
    if (!kids) return null;
    const i = indexById(kids, this._id);
    return i > 0 ? kids[i - 1] : null;
  }
  // A child with nodeType ELEMENT_NODE is an Element wrapper.
  get nextElementSibling(): Element | null {
    const kids = parentChildArray(this);
    if (!kids) return null;
    let i = indexById(kids, this._id);
    if (i < 0) return null;
    for (i = i + 1; i < kids.length; i++) {
      const kid = kids[i];
      if (isElementNode(kid)) return kid;
    }
    return null;
  }
  get previousElementSibling(): Element | null {
    const kids = parentChildArray(this);
    if (!kids) return null;
    let i = indexById(kids, this._id);
    if (i < 0) return null;
    for (i = i - 1; i >= 0; i--) {
      const kid = kids[i];
      if (isElementNode(kid)) return kid;
    }
    return null;
  }
  get ownerDocument(): NodeOwnerDocument | null {
    const owner = nodeOwnerDoc.get(this);
    if (owner) return owner;
    return liveWindow().document;
  }
  appendChild<T extends NodeBase>(child: T): T {
    maybeScheduleSlotchange(this._id);
    if (!child) throw notSupported("appendChild: null/undefined child");
    // A DOMParser node carries its own handle.
    const childDom = treeDom(child);
    if (childDom && childDom !== dom) {
      try {
        adoptIntoDom(dom, child, document);
      } catch {}
    }
    assertCanHaveChildren(this, "appendChild");
    assertNotAncestor(this, child, "appendChild");
    assertNotDocumentChild(child, "appendChild");
    assertDoctypeOnlyInDocument(this, child, "appendChild");
    assertNotTextIntoDocument(this, child, "appendChild");
    assertOneElementChild(this, child, "appendChild");
    let childNT;
    try {
      childNT = child.nodeType;
    } catch {
      childNT = null;
    }
    if (childNT === DOCUMENT_FRAGMENT_NODE && typeof child._id === "number" && child._id >= 0) {
      const kids = Array.from(child.childNodes);
      if (kids.length === 0) return child;
      // Validate every fragment child before moving any; failure must not partially consume it.
      for (const k of kids) {
        assertNotDocumentChild(k, "appendChild");
        assertDoctypeOnlyInDocument(this, k, "appendChild");
        assertNotTextIntoDocument(this, k, "appendChild");
      }
      const prevSiblingForAdd = this.lastChild || null;
      for (const k of kids) {
        if (typeof k._id !== "number" || k._id < 0) continue;
        try {
          dom.removeNode(k._id);
        } catch {}
        dom.appendChildNode(this._id, k._id);
      }
      bumpMutationSeq(undefined, true);
      let prevForCdp = prevSiblingForAdd ? prevSiblingForAdd._id : 0;
      for (const k of kids) {
        if (typeof k._id !== "number" || k._id < 0) continue;
        recordCdpMutation({
          kind: "childNodeInserted",
          parentNodeId: this._id,
          previousNodeId: prevForCdp,
          nodeId: k._id,
        });
        prevForCdp = k._id;
      }
      recordChildListMutation(child, [], kids, null, null);
      recordChildListMutation(this, kids, [], prevSiblingForAdd, null);
      for (const k of kids) {
        stampConnectedNamedGlobals(k._id);
        notifySubtreeInserts(k);
        notifyConnectedCallbacks(k);
      }
      return child;
    }
    if (typeof child._id === "number" && child._id >= 0) {
      const prevSiblingForAdd = this.lastChild || null;
      let oldParent: NodeBase | null = null;
      let oldPrevSibling: NodeBase | null = null;
      let oldNextSibling: NodeBase | null = null;
      try {
        const opId = dom.parentId(child._id);
        if (opId >= 0) {
          oldParent = opId === this._id ? this : nodeFor(opId);
          oldPrevSibling = child.previousSibling || null;
          oldNextSibling = child.nextSibling || null;
        }
      } catch {}
      const intraParent = oldParent === this;
      let oldIndex = -1;
      if (oldParent) {
        oldIndex = nodeIndexOf(child);
      }
      try {
        const curParent = dom.parentId(child._id);
        // Blitz corrupts its child list if appendChildNode receives an attached same-parent child.
        if (curParent === this._id) dom.removeNode(child._id);
      } catch {}
      if (oldParent && oldIndex >= 0) {
        rangeBeforeRemove(oldParent, oldIndex, child);
      }
      dom.appendChildNode(this._id, child._id);
      bumpMutationSeq(undefined, true);
      {
        const newIdx = dom.childIds(this._id).length - 1;
        if (newIdx >= 0) rangeAfterInsert(this, newIdx, 1);
      }
      if (oldParent && !intraParent && typeof oldParent._id === "number" && oldParent._id >= 0) {
        recordCdpMutation({
          kind: "childNodeRemoved",
          parentNodeId: oldParent._id,
          nodeId: child._id,
        });
      }
      recordCdpMutation({
        kind: "childNodeInserted",
        parentNodeId: this._id,
        previousNodeId: prevSiblingForAdd ? prevSiblingForAdd._id : 0,
        nodeId: child._id,
      });
      // Queue removal before addition, even when an intra-parent move targets the same observer.
      if (oldParent) {
        recordChildListMutation(oldParent, [], [child], oldPrevSibling, oldNextSibling);
      }
      recordChildListMutation(this, [child], [], prevSiblingForAdd, null);
      stampConnectedNamedGlobals(child._id);
      notifySubtreeInserts(child);
      notifyConnectedCallbacks(child);
      return child;
    }
    if (typeof child._serializeForAppend === "function") {
      const html = child._serializeForAppend();
      recordOp({ kind: "appendChildHtml", parent: this._id, html });
      return child;
    }
    throw notSupported("appendChild: unsupported child node");
  }
  insertBefore(newChild: NodeBase, refChild: NodeBase | null) {
    maybeScheduleSlotchange(this._id);
    if (arguments.length < 2) {
      throw new TypeError(
        "insertBefore: 2 arguments required, but only " + arguments.length + " present",
      );
    }
    if (refChild != null && (typeof refChild !== "object" || typeof refChild._id !== "number")) {
      throw new TypeError("insertBefore: second argument is not a Node");
    }
    if (!newChild) {
      throw new TypeError("insertBefore: first argument is not a Node");
    }
    assertCanHaveChildren(this, "insertBefore");
    assertNotAncestor(this, newChild, "insertBefore");
    if (refChild && typeof refChild._id === "number" && refChild._id >= 0) {
      let refParent: NodeBase | DetachedDocument | null = null;
      try {
        refParent = refChild.parentNode;
      } catch {
        refParent = null;
      }
      let parentMatches = refParent === this;
      if (!parentMatches && typeof this._id === "number" && this._id >= 0) {
        try {
          const wp = dom.parentId(refChild._id);
          parentMatches = wp >= 0 && wp === this._id;
        } catch {}
      }
      if (!parentMatches) {
        throw new DOMException(
          "insertBefore: reference child is not a child of parent",
          "NotFoundError",
        );
      }
    }
    assertNotDocumentChild(newChild, "insertBefore");
    assertDoctypeOnlyInDocument(this, newChild, "insertBefore");
    assertNotTextIntoDocument(this, newChild, "insertBefore");
    assertOneElementChild(this, newChild, "insertBefore");
    let newChildNT;
    try {
      newChildNT = newChild.nodeType;
    } catch {
      newChildNT = null;
    }
    if (
      newChildNT === DOCUMENT_FRAGMENT_NODE &&
      typeof newChild._id === "number" &&
      newChild._id >= 0
    ) {
      const kids = Array.from(newChild.childNodes);
      if (kids.length === 0) return newChild;
      // Validate every fragment child first so insertion failure cannot partially consume it.
      for (const k of kids) {
        assertNotDocumentChild(k, "insertBefore");
        assertDoctypeOnlyInDocument(this, k, "insertBefore");
        assertNotTextIntoDocument(this, k, "insertBefore");
      }
      const prevSiblingForAdd = refChild
        ? refChild.previousSibling || null
        : this.lastChild || null;
      const nextSiblingForAdd = refChild || null;
      let refIdForBatch =
        refChild && typeof refChild._id === "number" && refChild._id >= 0 ? refChild._id : 0;
      for (const k of kids) {
        if (typeof k._id !== "number" || k._id < 0) continue;
        try {
          dom.removeNode(k._id);
        } catch {}
        const safeRefId = safeReferenceId(this._id, refIdForBatch);
        dom.insertBeforeNode(this._id, k._id, safeRefId);
      }
      bumpMutationSeq(undefined, true);
      let prevForCdp = prevSiblingForAdd ? prevSiblingForAdd._id : 0;
      for (const k of kids) {
        if (typeof k._id !== "number" || k._id < 0) continue;
        recordCdpMutation({
          kind: "childNodeInserted",
          parentNodeId: this._id,
          previousNodeId: prevForCdp,
          nodeId: k._id,
        });
        prevForCdp = k._id;
      }
      recordChildListMutation(newChild, [], kids, null, null);
      recordChildListMutation(this, kids, [], prevSiblingForAdd, nextSiblingForAdd);
      for (const k of kids) {
        stampConnectedNamedGlobals(k._id);
        notifySubtreeInserts(k);
        notifyConnectedCallbacks(k);
      }
      return newChild;
    }
    const newId = newChild._id;
    if (typeof newId !== "number" || newId < 0) {
      if (typeof newChild._serializeForAppend === "function") {
        if (refChild == null) {
          const html = newChild._serializeForAppend();
          recordOp({ kind: "appendChildHtml", parent: this._id, html });
          return newChild;
        }
        throw notSupported("insertBefore: SyntheticElement requires null ref");
      }
      throw notSupported("insertBefore: unsupported new child");
    }
    if (refChild === newChild) {
      const next = newChild.nextSibling;
      if (next) refChild = next;
      else refChild = null;
    }
    const refId =
      refChild && typeof refChild._id === "number" && refChild._id >= 0 ? refChild._id : 0;
    const prevSiblingForAdd = refChild ? refChild.previousSibling || null : this.lastChild || null;
    const nextSiblingForAdd = refChild || null;
    let oldParent: NodeBase | null = null;
    let oldPrevSibling: NodeBase | null = null;
    let oldNextSibling: NodeBase | null = null;
    try {
      const opId = dom.parentId(newId);
      if (opId >= 0) {
        oldParent = opId === this._id ? this : nodeFor(opId);
        oldPrevSibling = newChild.previousSibling || null;
        oldNextSibling = newChild.nextSibling || null;
      }
    } catch {}
    const intraParent = oldParent === this;
    const insertBeforeOldIndex = oldParent ? nodeIndexOf(newChild) : -1;
    const refIndex = refChild ? nodeIndexOf(refChild) : dom.childIds(this._id).length;
    try {
      const curParent = dom.parentId(newId);
      if (curParent === this._id) {
        // Detach before the wasm move; an attached same-parent move corrupts Blitz's child list.
        dom.removeNode(newId);
      }
    } catch {}
    if (oldParent && insertBeforeOldIndex >= 0) {
      rangeBeforeRemove(oldParent, insertBeforeOldIndex, newChild);
    }
    dom.insertBeforeNode(this._id, newId, refId);
    bumpMutationSeq(undefined, true);
    {
      let landedIdx = refIndex;
      if (intraParent && insertBeforeOldIndex >= 0 && insertBeforeOldIndex < refIndex) {
        landedIdx = refIndex - 1;
      }
      rangeAfterInsert(this, landedIdx, 1);
    }
    if (oldParent && !intraParent && typeof oldParent._id === "number" && oldParent._id >= 0) {
      recordCdpMutation({
        kind: "childNodeRemoved",
        parentNodeId: oldParent._id,
        nodeId: newId,
      });
    }
    recordCdpMutation({
      kind: "childNodeInserted",
      parentNodeId: this._id,
      previousNodeId: prevSiblingForAdd ? prevSiblingForAdd._id : 0,
      nodeId: newId,
    });
    if (oldParent) {
      recordChildListMutation(oldParent, [], [newChild], oldPrevSibling, oldNextSibling);
    }
    recordChildListMutation(this, [newChild], [], prevSiblingForAdd, nextSiblingForAdd);
    stampConnectedNamedGlobals(newChild._id);
    notifySubtreeInserts(newChild);
    notifyConnectedCallbacks(newChild);
    return newChild;
  }
  removeChild<T extends NodeBase>(child: T): T {
    maybeScheduleSlotchange(this._id);
    if (child == null || (typeof child !== "object" && typeof child !== "function")) {
      throw new TypeError("removeChild: argument must be a Node");
    }
    if (typeof child.nodeType !== "number" && typeof child._id !== "number") {
      throw new TypeError("removeChild: argument must be a Node");
    }
    if (typeof child._id !== "number" || child._id < 0) {
      throw new DOMException("removeChild: child is not a child of parent", "NotFoundError");
    }
    {
      let pn: TreeParent | null = null;
      try {
        pn = child.parentNode;
      } catch {
        pn = null;
      }
      let parentMatches = pn === this;
      if (!parentMatches && typeof this._id === "number" && this._id >= 0) {
        try {
          const wp = dom.parentId(child._id);
          parentMatches = wp >= 0 && wp === this._id;
        } catch {}
      }
      if (!parentMatches) {
        throw new DOMException("removeChild: child is not a child of parent", "NotFoundError");
      }
    }
    // Adjust iterators and ranges before detaching, while the old tree position is still available.
    runIteratorPreRemove(child);
    const removedPrev = child.previousSibling || null;
    const removedNext = child.nextSibling || null;
    const removedNodeId = child._id;
    const removedIndex = nodeIndexOf(child);
    if (removedIndex >= 0) rangeBeforeRemove(this, removedIndex, child);
    notifyIframeRemoves(child);
    dom.removeNode(child._id);
    bumpMutationSeq(undefined, true);
    recordCdpMutation({
      kind: "childNodeRemoved",
      parentNodeId: this._id,
      nodeId: removedNodeId,
    });
    recordChildListMutation(this, [], [child], removedPrev, removedNext);
    return child;
  }
  replaceChild<T extends NodeBase>(newChild: NodeBase, oldChild: T): T {
    maybeScheduleSlotchange(this._id);
    assertCanHaveChildren(this, "replaceChild");
    if (!newChild) {
      throw new TypeError("replaceChild: first argument is not a Node");
    }
    assertNotAncestor(this, newChild, "replaceChild");
    if (!oldChild) {
      throw new TypeError("replaceChild: second argument is not a Node");
    }
    {
      let oldParent: TreeParent | null = null;
      try {
        oldParent = oldChild.parentNode;
      } catch {
        oldParent = null;
      }
      let parentMatches = oldParent === this;
      if (
        !parentMatches &&
        typeof this._id === "number" &&
        this._id >= 0 &&
        typeof oldChild._id === "number" &&
        oldChild._id >= 0
      ) {
        try {
          const wp = dom.parentId(oldChild._id);
          parentMatches = wp >= 0 && wp === this._id;
        } catch {}
      }
      if (!parentMatches) {
        throw new DOMException("replaceChild: old child is not a child of parent", "NotFoundError");
      }
    }
    assertNotDocumentChild(newChild, "replaceChild");
    assertDoctypeOnlyInDocument(this, newChild, "replaceChild");
    assertNotTextIntoDocument(this, newChild, "replaceChild");
    if (typeof newChild._id !== "number" || newChild._id < 0) {
      throw notSupported("replaceChild: invalid new child");
    }
    if (typeof oldChild._id !== "number" || oldChild._id < 0) {
      throw notSupported("replaceChild: invalid old child");
    }
    const swapPrev = oldChild.previousSibling || null;
    let swapNext = oldChild.nextSibling || null;
    if (swapNext === newChild) {
      swapNext = newChild.nextSibling || null;
    }
    let movedFromParent: NodeBase | null = null;
    let movedFromPrev: NodeBase | null = null;
    let movedFromNext: NodeBase | null = null;
    try {
      const npid = dom.parentId(newChild._id);
      if (npid >= 0) {
        movedFromParent = npid === this._id ? this : nodeFor(npid);
        movedFromPrev = newChild.previousSibling || null;
        movedFromNext = newChild.nextSibling || null;
      }
    } catch {}
    const replaceIntraParent = movedFromParent === this;
    const isSelfReplace = newChild === oldChild;
    const cdpPrevId = swapPrev ? swapPrev._id : 0;
    const oldChildIdx = nodeIndexOf(oldChild);
    const newChildOldIdx = movedFromParent ? nodeIndexOf(newChild) : -1;
    if (movedFromParent && newChildOldIdx >= 0 && !isSelfReplace) {
      rangeBeforeRemove(movedFromParent, newChildOldIdx, newChild);
    }
    if (oldChildIdx >= 0) {
      rangeBeforeRemove(this, oldChildIdx, oldChild);
    }
    if (!isSelfReplace) notifyIframeRemoves(oldChild);
    dom.replaceChildNode(newChild._id, oldChild._id);
    if (oldChildIdx >= 0) {
      let landedIdx = oldChildIdx;
      if (replaceIntraParent && newChildOldIdx >= 0 && newChildOldIdx < oldChildIdx) {
        landedIdx -= 1;
      }
      rangeAfterInsert(this, landedIdx, 1);
    }
    bumpMutationSeq(undefined, true);
    if (
      movedFromParent &&
      !replaceIntraParent &&
      typeof movedFromParent._id === "number" &&
      movedFromParent._id >= 0
    ) {
      recordCdpMutation({
        kind: "childNodeRemoved",
        parentNodeId: movedFromParent._id,
        nodeId: newChild._id,
      });
    }
    if (!isSelfReplace) {
      recordCdpMutation({
        kind: "childNodeRemoved",
        parentNodeId: this._id,
        nodeId: oldChild._id,
      });
    }
    recordCdpMutation({
      kind: "childNodeInserted",
      parentNodeId: this._id,
      previousNodeId: cdpPrevId,
      nodeId: newChild._id,
    });
    if (movedFromParent) {
      recordChildListMutation(movedFromParent, [], [newChild], movedFromPrev, movedFromNext);
    }
    const swapRemoved = isSelfReplace ? [] : [oldChild];
    recordChildListMutation(this, [newChild], swapRemoved, swapPrev, swapNext);
    stampConnectedNamedGlobals(newChild._id);
    return oldChild;
  }
  before(...nodes: Array<NodeBase | string>): void {
    const parent = this.parentNode;
    if (!parent) return;
    const argSet = new Set(nodes.filter(isNodeLike));
    let viablePrev = this.previousSibling;
    while (viablePrev && argSet.has(viablePrev)) {
      viablePrev = viablePrev.previousSibling;
    }
    let anchor = viablePrev ? viablePrev.nextSibling : parent.firstChild;
    while (anchor && argSet.has(anchor)) {
      anchor = anchor.nextSibling;
    }
    const converted = nodes.map((n) => (isNodeLike(n) ? n : createTextNodeInternal(String(n))));
    for (const node of converted) {
      if (anchor) parent.insertBefore(node, anchor);
      else parent.appendChild(node);
    }
  }
  after(...nodes: Array<NodeBase | string>): void {
    const parent = this.parentNode;
    if (!parent) return;
    const argSet = new Set(nodes.filter(isNodeLike));
    let viableNext = this.nextSibling;
    while (viableNext && argSet.has(viableNext)) {
      viableNext = viableNext.nextSibling;
    }
    const converted = nodes.map((n) => (isNodeLike(n) ? n : createTextNodeInternal(String(n))));
    for (const node of converted) {
      if (viableNext) parent.insertBefore(node, viableNext);
      else parent.appendChild(node);
    }
  }
  replaceWith(...nodes: Array<NodeBase | string>): void {
    const parent = this.parentNode;
    if (!parent) return;
    const argSet = new Set(nodes.filter(isNodeLike));
    let viableNext = this.nextSibling;
    while (viableNext && argSet.has(viableNext)) {
      viableNext = viableNext.nextSibling;
    }
    const selfInArgs = argSet.has(this);
    const converted = nodes.map((n) => (isNodeLike(n) ? n : createTextNodeInternal(String(n))));
    for (const node of converted) {
      if (viableNext) parent.insertBefore(node, viableNext);
      else parent.appendChild(node);
    }
    if (!selfInArgs) parent.removeChild(this);
  }
  remove(): void {
    const parent = this.parentNode;
    if (parent) parent.removeChild(this);
  }
  append(...nodes: Array<NodeBase | string>): void {
    for (const n of nodes) {
      const node = isNodeLike(n) ? n : createTextNodeInternal(String(n));
      this.appendChild(node);
    }
  }
  prepend(...nodes: Array<NodeBase | string>): void {
    const first = this.firstChild;
    for (const n of nodes) {
      const node = isNodeLike(n) ? n : createTextNodeInternal(String(n));
      if (first) this.insertBefore(node, first);
      else this.appendChild(node);
    }
  }
  replaceChildren(...nodes: Array<NodeBase | string>): void {
    const converted = nodes.map((n) => (isNodeLike(n) ? n : createTextNodeInternal(String(n))));
    const prospective: NodeBase[] = [];
    for (const node of converted) {
      const children =
        node.nodeType === DOCUMENT_FRAGMENT_NODE ? Array.from(node.childNodes) : [node];
      for (const child of children) {
        const previous = prospective.indexOf(child);
        if (previous !== -1) prospective.splice(previous, 1);
        prospective.push(child);
      }
    }
    assertCanHaveChildren(this, "replaceChildren");
    const isDocument = this.nodeType === DOCUMENT_NODE || hostIdToDoc.has(this._id);
    if (isDocument) {
      assertDocumentInsertAllowed(this, prospective, "replaceChildren", false, true);
      let sawElement = false;
      for (const node of prospective) {
        if (node.nodeType === ELEMENT_NODE) sawElement = true;
        if (node.nodeType === DOCTYPE_NODE && sawElement) {
          throw new DOMException(
            "replaceChildren: Document doctype must precede element",
            "HierarchyRequestError",
          );
        }
      }
    }
    for (const node of converted) {
      assertNotAncestor(this, node, "replaceChildren");
      assertNotDocumentChild(node, "replaceChildren");
      if (!isDocument) assertDoctypeOnlyInDocument(this, node, "replaceChildren");
    }
    const existing = Array.from(this.childNodes);
    suppressChildListMutations(this, () => {
      for (const c of existing) this.removeChild(c);
      for (const c of converted) this.appendChild(c);
    });
    const added = Array.from(this.childNodes);
    if (added.length > 0 || existing.length > 0) {
      recordChildListMutation(this, added, existing, null, null);
    }
  }

  insertAdjacentElement(position: string, element: Element): Idl.Element | null {
    if (!element || typeof element._id !== "number") {
      throw notSupported("insertAdjacentElement: unsupported element");
    }
    let elNT;
    try {
      elNT = element.nodeType;
    } catch {
      elNT = null;
    }
    if (elNT !== ELEMENT_NODE) {
      throw new TypeError(
        "insertAdjacentElement: second argument must be an Element (got nodeType " + elNT + ")",
      );
    }
    const pos = typeof position === "string" ? position.toLowerCase() : "";
    const valid =
      pos === "beforebegin" || pos === "afterbegin" || pos === "beforeend" || pos === "afterend";
    if (!valid) {
      throw new DOMException(
        "insertAdjacentElement: '" + position + "' is not a valid insertAdjacent position",
        "SyntaxError",
      );
    }
    if (pos === "beforebegin") {
      const parent = this.parentNode;
      if (!parent) return null;
      parent.insertBefore(element, this);
      return element;
    }
    if (pos === "afterbegin") {
      const first = this.firstChild;
      if (first) this.insertBefore(element, first);
      else this.appendChild(element);
      return element;
    }
    if (pos === "beforeend") {
      this.appendChild(element);
      return element;
    }
    const parent = this.parentNode;
    if (!parent) return null;
    const sibs = parent.childNodes;
    const idx = sibs.findIndex((c) => c === this);
    const next = idx >= 0 ? sibs[idx + 1] : null;
    parent.insertBefore(element, next || null);
    return element;
  }
  insertAdjacentText(position: string, data: string): void {
    const pos = typeof position === "string" ? position.toLowerCase() : "";
    const valid =
      pos === "beforebegin" || pos === "afterbegin" || pos === "beforeend" || pos === "afterend";
    if (!valid) {
      throw new DOMException(
        "insertAdjacentText: '" + position + "' is not a valid insertAdjacent position",
        "SyntaxError",
      );
    }
    const text = createTextNodeInternal(String(data ?? ""));
    if (pos === "beforebegin") {
      const parent = this.parentNode;
      if (!parent) return;
      parent.insertBefore(text, this);
    } else if (pos === "afterbegin") {
      const first = this.firstChild;
      if (first) this.insertBefore(text, first);
      else this.appendChild(text);
    } else if (pos === "beforeend") {
      this.appendChild(text);
    } else {
      const parent = this.parentNode;
      if (!parent) return;
      const sibs = parent.childNodes;
      const idx = sibs.findIndex((c) => c === this);
      const next = idx >= 0 ? sibs[idx + 1] : null;
      parent.insertBefore(text, next || null);
    }
  }
  insertAdjacentHTML(position: string, html: string): void {
    const htmlText = String(html == null ? "" : html);
    return ksSpan("dom.insertAdjacentHTML", { html_bytes: htmlText.length }, () =>
      this.__insertAdjacentHTML(position, htmlText),
    );
  }
  __insertAdjacentHTML(position: string, html: string): void {
    const pos = typeof position === "string" ? position.toLowerCase() : "";
    if (pos === "afterbegin" || pos === "beforeend") {
      const tmp = createElementInternal("div");
      tmp.innerHTML = String(html == null ? "" : html);
      const newNodes = Array.from(tmp.childNodes);
      if (pos === "afterbegin") {
        const ref = this.firstChild;
        for (const n of newNodes) {
          if (ref) this.insertBefore(n, ref);
          else this.appendChild(n);
        }
      } else {
        for (const n of newNodes) this.appendChild(n);
      }
      return;
    }
    if (pos === "beforebegin" || pos === "afterend") {
      const parent = this.parentNode;
      if (
        !parent ||
        (parent.nodeType !== ELEMENT_NODE && parent.nodeType !== DOCUMENT_FRAGMENT_NODE)
      ) {
        throw new (ksGlobal.DOMException || Error)(
          "insertAdjacentHTML: cannot insert at '" + position + "' without an element parent",
          "NoModificationAllowedError",
        );
      }
      const tmp = createElementInternal("div");
      tmp.innerHTML = String(html == null ? "" : html);
      const newNodes = Array.from(tmp.childNodes);
      if (pos === "beforebegin") {
        for (const n of newNodes) parent.insertBefore(n, this);
      } else {
        const ref = this.nextSibling;
        for (const n of newNodes) {
          if (ref) parent.insertBefore(n, ref);
          else parent.appendChild(n);
        }
      }
      return;
    }
    throw new (ksGlobal.DOMException || Error)(
      "'" + position + "' is not a valid insertAdjacent position",
      "SyntaxError",
    );
  }

  get isConnected() {
    let n: TreeParent | null = this;
    const seen = new Set<TreeParent>();
    for (let i = 0; i < MAX_CONNECTED_NODE_ANCESTOR_HOPS; i++) {
      if (!n) return false;
      if (n.nodeType === DOCUMENT_NODE) return true;
      if (seen.has(n)) return false;
      seen.add(n);
      n = n.parentNode || (isShadowRootNode(n) && n.host ? n.host : null);
    }
    return false;
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
Object.assign(NodeBase, NODE_CONSTANTS);
Object.assign(NodeBase.prototype, NODE_CONSTANTS);

NodeBase.prototype.isSameNode = function (other) {
  if (!other) return false;
  // Object() so a primitive reads undefined, as `other._id` did.
  return this === other || this._id === treeId(Object(other));
};
NodeBase.prototype.isEqualNode = function (other) {
  return isEqualNode(this, other);
};
NodeBase.prototype.getRootNode = function (options) {
  let n: NodeBase | DetachedDocument = this;
  let p;
  while ((p = n.parentNode)) n = p;

  if (options && options.composed) {
    while (isShadowRootNode(n) && n.host) {
      let hop: NodeBase | DetachedDocument = n.host;
      let hp;
      while ((hp = hop.parentNode)) hop = hp;
      n = hop;
    }
  }
  return n;
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
type NamespaceLookupNode = (NodeBase | DetachedDocument) & {
  attributes?: ArrayLike<Idl.Attr | null> | null;
  prefix?: string | null;
  namespaceURI?: string | null;
  documentElement?: NodeBase | null;
  ownerElement?: NodeBase | null;
};

type NamespaceAttributeResult<T> = { found: true; value: T } | { found: false };

function findNamespaceAttribute<T>(
  node: NamespaceLookupNode,
  matches: (attribute: Idl.Attr) => boolean,
  value: (attribute: Idl.Attr) => T,
): NamespaceAttributeResult<T> {
  try {
    const attrs = node.attributes;
    if (attrs) {
      for (let i = 0; i < attrs.length; i++) {
        const attribute = attrs[i];
        if (attribute && matches(attribute)) return { found: true, value: value(attribute) };
      }
    }
  } catch {}
  return { found: false };
}

function locateNamespace(elem: NamespaceLookupNode, prefix: string | null): string | null {
  let n: NamespaceLookupNode | null = elem;
  while (n && n.nodeType === ELEMENT_NODE) {
    const elPrefix = n.prefix === undefined ? null : n.prefix;
    const elNs = n.namespaceURI || null;
    if (elNs && elPrefix === prefix) return elNs;
    const declaration = findNamespaceAttribute(
      n,
      (attribute) => {
        if ((attribute.namespaceURI || null) !== XMLNS_NS) return false;
        const attributePrefix = attribute.prefix === undefined ? null : attribute.prefix;
        const localName = attribute.localName || attribute.name;
        return prefix === null
          ? attributePrefix === null && localName === "xmlns"
          : attributePrefix === "xmlns" && localName === prefix;
      },
      (attribute) => attribute.value || null,
    );
    if (declaration.found) return declaration.value;
    n = n.parentNode;
  }
  return null;
}
NodeBase.prototype.lookupNamespaceURI = function (
  this: NamespaceLookupNode,
  prefix: string | null,
): string | null {
  const p = prefix === "" ? null : prefix;
  let n;
  if (this.nodeType === ELEMENT_NODE) {
    n = this;
  } else if (this.nodeType === DOCUMENT_NODE) {
    n = this.documentElement || null;
  } else if (this.nodeType === ATTRIBUTE_NODE) {
    n = this.ownerElement ?? null;
  } else {
    n = this.parentNode;
  }
  while (n && n.nodeType !== ELEMENT_NODE) n = n.parentNode;
  if (!n) return null;
  if (p === "xml") return XML_NS;
  if (p === "xmlns") return XMLNS_NS;
  return locateNamespace(n, p);
};
NodeBase.prototype.lookupPrefix = function (
  this: NamespaceLookupNode,
  namespace: string | null,
): string | null {
  if (!namespace) return null;
  let n: NamespaceLookupNode | null;
  if (this.nodeType === ELEMENT_NODE) {
    n = this;
  } else if (this.nodeType === DOCUMENT_NODE) {
    n = this.documentElement || null;
  } else if (this.nodeType === ATTRIBUTE_NODE) {
    n = this.ownerElement ?? null;
  } else {
    n = this.parentNode;
  }
  while (n && !isElementNode(n)) n = n.parentNode;
  while (isElementNode(n)) {
    const elPrefix = n.prefix === undefined ? null : n.prefix;
    const elNs = n.namespaceURI || null;
    if (elNs === namespace && elPrefix) return elPrefix;
    const declaration = findNamespaceAttribute(
      n,
      (attribute) =>
        (attribute.namespaceURI || null) === XMLNS_NS &&
        attribute.prefix === "xmlns" &&
        (attribute.value || null) === namespace,
      (attribute) => attribute.localName || attribute.name,
    );
    if (declaration.found) return declaration.value;
    n = n.parentNode;
  }
  return null;
};
NodeBase.prototype.isDefaultNamespace = function (namespace: string | null): boolean {
  const ns = namespace === "" ? null : namespace;
  const def = this.lookupNamespaceURI(null);
  return def === ns;
};
function computeBaseURI(): string {
  const docUrl = pageUrl || "about:blank";
  try {
    const baseId = dom ? dom.querySelector("base[href]") : -1;
    if (baseId && baseId > 0) {
      const node = elementFor(baseId);
      const href =
        node && typeof node.getAttribute === "function" ? node.getAttribute("href") : null;
      if (href != null && href !== "") {
        try {
          return new URL(String(href), docUrl).toString();
        } catch {}
      }
    }
  } catch {}
  return docUrl;
}
Object.defineProperty(NodeBase.prototype, "baseURI", {
  configurable: true,
  enumerable: true,
  get: function () {
    return computeBaseURI();
  },
});

// The members isEqualNode compares, by node type, read off any Node.
type EqualityNode = Idl.Node & {
  name?: string;
  publicId?: string;
  systemId?: string;
  namespaceURI?: string | null;
  prefix?: string | null;
  localName?: string | null;
  attributes?: ArrayLike<{ namespaceURI: string | null; localName: string; value: string }>;
  value?: string;
  target?: string;
  data?: string;
};
function isEqualNode(
  a: EqualityNode | null | undefined,
  b: EqualityNode | null | undefined,
): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.nodeType !== b.nodeType) return false;
  switch (a.nodeType) {
    case DOCTYPE_NODE: {
      if ((a.name || "") !== (b.name || "")) return false;
      if ((a.publicId || "") !== (b.publicId || "")) return false;
      if ((a.systemId || "") !== (b.systemId || "")) return false;
      return true;
    }
    case ELEMENT_NODE: {
      if (a.namespaceURI !== b.namespaceURI) return false;
      if (a.prefix !== b.prefix) return false;
      if (a.localName !== b.localName) return false;
      const aa = a.attributes;
      const bb = b.attributes;
      // Every element has attributes; reading through undefined threw this.
      if (!aa || !bb) throw new TypeError("isEqualNode: element has no attributes");
      if (aa.length !== bb.length) return false;
      const aMap = new Map<string, string>();
      for (let i = 0; i < aa.length; i++) {
        const at = aa[i];
        const k = (at.namespaceURI || "") + "|" + at.localName;
        aMap.set(k, at.value);
      }
      for (let i = 0; i < bb.length; i++) {
        const at = bb[i];
        const k = (at.namespaceURI || "") + "|" + at.localName;
        if (!aMap.has(k) || aMap.get(k) !== at.value) return false;
      }
      break;
    }
    case ATTRIBUTE_NODE: {
      if (a.namespaceURI !== b.namespaceURI) return false;
      if (a.localName !== b.localName) return false;
      if (a.value !== b.value) return false;
      return true;
    }
    case PROCESSING_INSTRUCTION_NODE: {
      if ((a.target || "") !== (b.target || "")) return false;
      if ((a.data || "") !== (b.data || "")) return false;
      return true;
    }
    case TEXT_NODE:
    case CDATA_SECTION_NODE:
    case COMMENT_NODE: {
      if ((a.data || "") !== (b.data || "")) return false;
      return true;
    }
  }
  const ac = a.childNodes;
  const bc = b.childNodes;
  if (ac.length !== bc.length) return false;
  for (let i = 0; i < ac.length; i++) {
    if (!isEqualNode(ac[i], bc[i])) return false;
  }
  return true;
}

const disconnectedRootOrder = new WeakMap<object, number>();
let nextDisconnectedRootOrder = 1;

function rootOrder(root: object): number {
  let order = disconnectedRootOrder.get(root);
  if (order === undefined) {
    order = nextDisconnectedRootOrder++;
    disconnectedRootOrder.set(root, order);
  }
  return order;
}

function compareDocumentPosition(self: Idl.Node, other: Idl.Node): number {
  if (!other) {
    throw new TypeError("compareDocumentPosition: argument required");
  }
  if (self === other) return 0;
  function chain(start: Idl.Node): Idl.Node[] {
    const c: Idl.Node[] = [];
    for (let n: Idl.Node | null = start; n; n = n.parentNode) c.unshift(n);
    return c;
  }
  const a = chain(self);
  const b = chain(other);
  if (a[0] !== b[0]) {
    const flag = DOCUMENT_POSITION_DISCONNECTED | DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC;
    return (
      flag |
      (rootOrder(a[0]) < rootOrder(b[0])
        ? DOCUMENT_POSITION_FOLLOWING
        : DOCUMENT_POSITION_PRECEDING)
    );
  }
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i === a.length) {
    return DOCUMENT_POSITION_FOLLOWING | DOCUMENT_POSITION_CONTAINED_BY;
  }
  if (i === b.length) {
    return DOCUMENT_POSITION_PRECEDING | DOCUMENT_POSITION_CONTAINS;
  }
  const parent = a[i - 1];
  const kids = parent.childNodes;
  const aChild = a[i];
  const bChild = b[i];
  for (let k = 0; k < kids.length; k++) {
    const kid = kids[k];
    const kidId = kid ? treeId(kid) : undefined;
    if (kids[k] === aChild || (kidId != null && kidId === treeId(aChild))) {
      return DOCUMENT_POSITION_FOLLOWING;
    }
    if (kids[k] === bChild || (kidId != null && kidId === treeId(bChild))) {
      return DOCUMENT_POSITION_PRECEDING;
    }
  }
  return DOCUMENT_POSITION_DISCONNECTED;
}
class CharacterDataNode extends NodeBase implements Idl.CharacterData {
  // length is uniform across subclasses: just .data.length.
  get length() {
    return this.data.length;
  }

  substringData(offset: number, count: number) {
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

  appendData(data: string) {
    if (arguments.length < 1) {
      throw new TypeError("appendData: 1 argument required, but 0 present");
    }
    this.replaceData(this.length, 0, data);
  }

  insertData(offset: number, data: string) {
    if (arguments.length < 2) {
      throw new TypeError(
        "insertData: 2 arguments required, but only " + arguments.length + " present",
      );
    }
    this.replaceData(offset, 0, data);
  }

  deleteData(offset: number, count: number) {
    if (arguments.length < 2) {
      throw new TypeError(
        "deleteData: 2 arguments required, but only " + arguments.length + " present",
      );
    }
    this.replaceData(offset, count, "");
  }

  replaceData(offset: number, count: number, data: string) {
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

function writeCharacterData(node: CharacterDataNode, value: unknown) {
  if (!node) return;
  const next = value === null ? "" : String(value);
  if (!suppressRangeUpdate) {
    const oldLen =
      typeof node.data === "string"
        ? node.data.length
        : typeof (node._info && node._info.nodeValue) === "string"
          ? node._info.nodeValue.length
          : 0;
    rangeBeforeReplaceData(node, 0, oldLen, next.length);
  }
  let oldValue: string;
  if (node.nodeType === COMMENT_NODE) {
    oldValue = commentData.get(node._id) ?? (node._info && node._info.nodeValue) ?? "";
  } else if (typeof node.data === "string") {
    oldValue = node.data;
  } else {
    oldValue = (node._info && node._info.nodeValue) || "";
  }
  if (node._info) node._info.nodeValue = next;
  if (node._id < 0) {
    recordCharacterDataMutation(node, oldValue);
    return;
  }
  if (node.nodeType === COMMENT_NODE) {
    commentData.set(node._id, next);
    try {
      dom.setCommentData(node._id, next);
    } catch {}
    recordCharacterDataMutation(node, oldValue);
    return;
  }
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
  recordOp({ kind: "setNodeText", node: node._id, text: next });
  recordCharacterDataMutation(node, oldValue);
}

class TextNode extends CharacterDataNode implements Idl.Text {
  // NodeBase.prototype installs the Slottable mixin's assignedSlot.
  declare readonly assignedSlot: Idl.HTMLSlotElement | null;
  _typeCheckSeq?: number;
  constructor(arg?: unknown, info?: unknown) {
    if (
      typeof arg === "number" &&
      info !== null &&
      typeof info === "object" &&
      typeof Reflect.get(info, "nodeType") === "number"
    ) {
      // A numeric nodeType is the whole check: nodeFor passes a nodeInfo
      // snapshot, and page code can reach this branch with anything.
      super(arg, info as WrapperInfo);
      return;
    }
    const data = arg === undefined ? "" : String(arg);
    const id = dom.createTextNode(data);
    const cachedInfo = dom.nodeInfo(id) || {
      nodeType: TEXT_NODE,
      nodeName: "#text",
      localName: "",
      nodeValue: data,
    };
    super(id, cachedInfo);
    this._typeCheckSeq = ksState().mutationSeq | 0;
    cache.set(id, this);
  }
  _refreshTextInfo(): void {
    const curSeq = ksState().mutationSeq | 0;
    if (this._typeCheckSeq === curSeq) return;
    const cached = this._info && this._info.nodeValue;
    if (typeof cached === "string") {
      for (let i = 0; i < cached.length; i++) {
        const c = cached.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdfff) {
          this._typeCheckSeq = curSeq;
          return;
        }
      }
    }
    try {
      const fresh = dom.nodeInfo(this._id);
      if (fresh) this._info = fresh;
    } catch {}
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
  constructor(arg?: unknown, info?: unknown) {
    if (
      typeof arg === "number" &&
      info !== null &&
      typeof info === "object" &&
      typeof Reflect.get(info, "nodeType") === "number"
    ) {
      // A numeric nodeType is the whole check: nodeFor passes a nodeInfo
      // snapshot, and page code can reach this branch with anything.
      super(arg, info as WrapperInfo);
      return;
    }
    const data = arg === undefined ? "" : String(arg);
    const id = dom.createComment(data);
    commentData.set(id, data);
    const cachedInfo = dom.nodeInfo(id) || {
      nodeType: COMMENT_NODE,
      nodeName: "#comment",
      localName: "",
      nodeValue: data,
    };
    super(id, cachedInfo);
    this._typeCheckSeq = ksState().mutationSeq | 0;
    cache.set(id, this);
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
  set textContent(_v: string | null) {}
  get parentNode(): NodeBase | DetachedDocument | null {
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
  cloneNode(_deep?: boolean): DocumentTypeNode {
    const synth: DocumentTypeNode = Object.create(DocumentTypeNode.prototype);
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
