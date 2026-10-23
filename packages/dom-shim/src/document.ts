// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Live and detached Document implementations; parser-backed documents live in parser.ts.

import {
  ksGlobal,
  dom,
  liveDocument,
  windowObj,
  windowProxy as window,
  getCurrentUrl,
  hitTestViaPaint,
  nodeFor,
  makeNodeList,
  makeHtmlCollection,
  activeElement,
  readyState,
  cookieString,
  cookieWrites,
  DOCUMENT_ID,
  scopedQuerySelector,
  scopedQuerySelectorAll,
  nextSyntheticId,
  fastpathMarkSpecial,
  createElementInternal,
  createElementNSInternal,
  createTextNodeInternal,
  createCommentInternal,
  createDocumentFragmentInternal,
  opts,
} from "./state.js";
import { scrollOffset } from "./layout/scroll.js";
import {
  elemNs,
  xmlOwned,
  hostIdToDoc,
  elementOwnerIsHtml,
  nodeOwnerDoc,
  syntheticParent,
  fragmentIds,
  stampedPiIds,
  commentData,
} from "./registries.js";
import { getInternalState } from "./internal-state.js";
import {
  ATTRIBUTE_NODE,
  ELEMENT_NODE,
  TEXT_NODE,
  PROCESSING_INSTRUCTION_NODE,
  COMMENT_NODE,
  DOCUMENT_NODE,
  DOCTYPE_NODE,
  DOCUMENT_FRAGMENT_NODE,
  HTML_NS,
  SVG_NS,
  DEFAULT_VIEWPORT_WIDTH_CSS_PX,
  DEFAULT_VIEWPORT_HEIGHT_CSS_PX,
  MAX_NODE_ANCESTOR_HOPS,
  DOCUMENT_POSITION_PRECEDING,
  DOCUMENT_POSITION_FOLLOWING,
  DOCUMENT_POSITION_CONTAINS,
  DOCUMENT_POSITION_CONTAINED_BY,
  notSupported,
} from "./constants.js";
import { createEditingEngine, type EditingEngine } from "./editing/implementation.js";
import type { ParsedDocument } from "./parser.js";
import type { Element } from "./element/element.js";
import type * as Idl from "./idl/types.generated.js";
import { cssEscape } from "./util/strings.js";
import {
  validateAttrName,
  isValidXmlName,
  validatePIArgs,
  XML_NS,
  XMLNS_NS,
} from "./util/validation.js";
import { bumpMutationSeq } from "./mutations/seq.js";
import { markRuntimeCreatedScript } from "./mutations/observer.js";
import { addListener, removeListener, dispatchOnKey } from "./events/dispatch.js";
import {
  KsEvent,
  KsCustomEvent,
  KsHashChangeEvent,
  KsMouseEvent,
  KsKeyboardEvent,
  KsUIEvent,
  KsFocusEvent,
  KsCompositionEvent,
  KsBeforeUnloadEvent,
  KsDeviceMotionEvent,
  KsDeviceOrientationEvent,
  KsDragEvent,
  KsMessageEvent,
  KsStorageEvent,
  KsTextEvent,
  KsTouchEvent,
  eventState,
} from "./events/event.js";
import {
  AttrCls,
  filterByQualifiedName,
  makeStyleSheetList,
  adoptedStyleSheets,
  type DocumentFragmentImpl,
} from "./collections.js";
import { RangeImpl, getSelection, rangeAfterInsert, rangeBeforeRemove } from "./range.js";
import { NodeIterator, TreeWalker } from "./traversal.js";
import { createExpression, evaluateXPath } from "./xpath.js";
import { documentCharacterSet } from "./text-encoding.js";
import { cheapHit, layoutMode } from "./layout/cheap.js";
import { applyLocalCookieWrite } from "./window.js";
import { getOrMakeSyntheticScript } from "./current-script.js";
import { animationsFor, getDocumentTimeline } from "./animations.js";
import {
  NodeBase,
  type TextNode,
  type CommentNode,
  DocumentTypeNode,
  assertDocumentInsertAllowed,
  compareDocumentPosition,
} from "./node-base.js";
import { __ks_documentImpl_location_get, __ks_documentImpl_location_set } from "./window.js";

function ksState() {
  return getInternalState();
}

function isElementNode(node: NodeBase | null | undefined): node is Element {
  return node != null && node.nodeType === ELEMENT_NODE;
}

function rootViewport(): { w: number; h: number } {
  try {
    const { viewportW, viewportH } = getInternalState();
    if (viewportW > 0 && viewportH > 0) return { w: viewportW, h: viewportH };
  } catch {}
  return {
    w: DEFAULT_VIEWPORT_WIDTH_CSS_PX,
    h: DEFAULT_VIEWPORT_HEIGHT_CSS_PX,
  };
}

function upgradeIfCustomElement(node: unknown, tag: string): void {
  const hook: unknown = ksGlobal.__ks_upgradeCustomElement;
  if (typeof hook !== "function") return;
  try {
    hook(node, tag);
  } catch {}
}

function isObjectLike(value: unknown): value is object {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

// adoptNode and importNode reject shadow roots but accept plain DocumentFragments.
function isDocumentFragmentNode(node: object): boolean {
  return "nodeType" in node && node.nodeType === DOCUMENT_FRAGMENT_NODE;
}

function shadowRootNodeId(node: object): number | null {
  if (!("_id" in node) || typeof node._id !== "number" || node._id < 0) return null;
  return node._id;
}

// blitz's shadowHostId is >= 0 only for real shadow roots.
function isShadowRootNode(node: unknown): boolean {
  if (node === null || typeof node !== "object") return false;
  if (!isDocumentFragmentNode(node)) return false;
  const id = shadowRootNodeId(node);
  return id !== null && dom.shadowHostId(id) >= 0;
}

// Resolve the mutable <base href> against the caller's fallback URL.
// Memoized per mutationSeq: every constructed CSS rule reads the base,
// and each miss is a whole-document querySelector.
let baseMemo: { seq: number; fallback: string; value: string } | null = null;
function computeDocBaseURI(fallback: string): string {
  const seq = ksState().mutationSeq;
  if (baseMemo && baseMemo.seq === seq && baseMemo.fallback === fallback) return baseMemo.value;
  const value = resolveDocBaseURI(fallback);
  baseMemo = { seq, fallback, value };
  return value;
}
function resolveDocBaseURI(fallback: string): string {
  try {
    const href = documentBaseHref();
    return resolveBaseHref(href, fallback) || fallback;
  } catch {}
  return fallback;
}

function documentBaseElementId(): number {
  return dom ? dom.querySelector("base[href]") : -1;
}

function documentBaseHref(): string | null {
  const baseId = documentBaseElementId();
  if (!(baseId && baseId > 0)) return null;
  // DomHandle has no getAttribute, so read through the Element wrapper.
  const node = nodeFor(baseId);
  return baseElementHrefAttribute(node);
}

function baseElementHrefAttribute(node: Element | null): string | null {
  return node && typeof node.getAttribute === "function" ? node.getAttribute("href") : null;
}

function resolveBaseHref(href: string | null, fallback: string): string | null {
  if (href == null || href === "") return null;
  try {
    return new URL(String(href), fallback).toString();
  } catch {
    // Malformed URLs fall back to the caller's base URL.
    return null;
  }
}

const NODE_CONSTANTS = {
  ELEMENT_NODE,
  TEXT_NODE,
  PROCESSING_INSTRUCTION_NODE,
  COMMENT_NODE,
  DOCUMENT_NODE,
  DOCUMENT_TYPE_NODE: DOCTYPE_NODE,
  DOCUMENT_FRAGMENT_NODE,
  DOCUMENT_POSITION_PRECEDING,
  DOCUMENT_POSITION_FOLLOWING,
  DOCUMENT_POSITION_CONTAINS,
  DOCUMENT_POSITION_CONTAINED_BY,
};

function editingEngine(doc: DocumentImpl): EditingEngine {
  doc.__editing ??= createEditingEngine(
    doc,
    getSelection,
    (element) => windowObj.getComputedStyle(element),
    NODE_CONSTANTS,
  );
  return doc.__editing;
}

const CURRENT_SCRIPT_BODY_KEY_MATCH_THRESHOLD = 8;

interface DocumentFontSet {
  readonly ready: Promise<DocumentFontSet>;
  readonly status: "loading" | "loaded";
  add(face: unknown): DocumentFontSet;
  delete(face: unknown): boolean;
  clear(): void;
  has(face: unknown): boolean;
  readonly size: number;
  forEach(
    callback: (face: unknown, face2: unknown, set: Set<unknown>) => void,
    thisArg?: unknown,
  ): void;
  load(font: string, text?: string): Promise<unknown[]>;
  check(font: string, text?: string): boolean;
  addEventListener(...args: unknown[]): void;
  removeEventListener(...args: unknown[]): void;
  dispatchEvent(...args: unknown[]): boolean;
  [Symbol.iterator](): IterableIterator<unknown>;
}

// Format lastModified in local time.
function formatLastModified(date: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return (
    `${pad(date.getMonth() + 1)}/${pad(date.getDate())}/${pad(date.getFullYear(), 4)} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function copyImportedAttributes(source: Element, destination: Element): void {
  const attrs = source.attributes;
  if (!attrs || typeof attrs.length !== "number") return;
  for (let i = 0; i < attrs.length; i++) {
    copyImportedAttribute(attrs[i], destination);
  }
}

function processingInstructionData(data: string): string {
  return String(data ?? "");
}

function processingInstructionTarget(target: string): string {
  return String(target ?? "");
}

function defineProcessingInstructionNames(
  node: NodeBase,
  target: string,
  configurable: boolean,
): void {
  Object.defineProperty(node, "nodeName", {
    value: processingInstructionTarget(target),
    enumerable: false,
    configurable,
  });
  Object.defineProperty(node, "target", {
    value: processingInstructionTarget(target),
    configurable,
  });
}

function markProcessingInstructionNode(node: NodeBase): void {
  if (node && node._id != null && node._id >= 0) stampedPiIds.add(node._id);
}

function writeDocumentMarkup(document: DocumentImpl, args: string[]): void {
  const markup = args.join("");
  if (!markup) return;
  const host = document.body || document.documentElement;
  if (!host) return;
  const temporary = document.createElement("div");
  temporary.innerHTML = markup;
  while (temporary.firstChild) host.appendChild(temporary.firstChild);
}

type PaintedPointHit = { found: false } | { found: true; element: Element | null };
type DomPointHit = { kind: "hit"; element: Element | null } | { kind: "miss" } | { kind: "panic" };
type CompletedDomPointHit = { completed: true; element: Element | null } | { completed: false };

function normalizedHitTestCoordinate(value: number): number {
  return Number(value) || 0;
}

function paintedElementAtPoint(x: number, y: number): PaintedPointHit {
  if (!hitTestViaPaint) return { found: false };
  try {
    const id = hitTestViaPaint(x, y);
    if (id >= 0) return { found: true, element: nodeFor(id) };
  } catch {}
  return { found: false };
}

function domElementAtPoint(x: number, y: number): DomPointHit {
  try {
    const id = dom.elementFromPoint(x, y);
    if (id >= 0) return { kind: "hit", element: nodeFor(id) };
    return { kind: "miss" };
  } catch {
    return { kind: "panic" };
  }
}

function completedDomPointHit(hit: DomPointHit): CompletedDomPointHit {
  if (hit.kind === "panic") return { completed: false };
  return { completed: true, element: hit.kind === "hit" ? hit.element : null };
}

function cheapElementAtPoint(x: number, y: number): Element | null {
  const id = cheapHit(x, y);
  return id >= 0 ? nodeFor(id) : null;
}

function fallbackCheapElementAtPoint(x: number, y: number): Element | null {
  try {
    return cheapElementAtPoint(x, y);
  } catch {
    return null;
  }
}

function assertCreateDocumentHasArguments(argumentCount: number): void {
  if (argumentCount < 2) {
    throw new TypeError("DOMImplementation.createDocument requires at least 2 arguments");
  }
}

function isDocumentTypeArgument(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "object") return false;
  return (value as { nodeType?: unknown }).nodeType === DOCTYPE_NODE;
}

function assertDocumentTypeArgument(value: unknown): void {
  if (!isDocumentTypeArgument(value)) {
    throw new TypeError("DOMImplementation.createDocument: doctype must be a DocumentType or null");
  }
}

function normalizedDocumentNamespace(namespaceURI: unknown): string | null {
  return namespaceURI == null || namespaceURI === "" ? null : String(namespaceURI);
}

function appendProvidedDocumentType(doc: XMLDocument, doctype: unknown): void {
  if (doctype != null && typeof doctype === "object") {
    doc._topChildren.push(doctype);
    syntheticParent.set(doctype, doc);
    nodeOwnerDoc.set(doctype, doc);
  }
}

function appendDocumentRoot(doc: XMLDocument, namespaceURI: unknown, qualifiedName: unknown): void {
  const qnameValue = qualifiedName === null ? null : String(qualifiedName);
  if (qnameValue !== null && qnameValue !== "") {
    // createElementNS does its own conversion of the raw namespace.
    const root = createElementNSInternal(namespaceURI as string | null, qnameValue);
    // createDocument always makes an XML document, even in the HTML
    // namespace, so tagName keeps its case.
    xmlOwned.add(root._id);
    fastpathMarkSpecial(root._id);
    doc._host.appendChild(root);
    doc._topChildren.push(root);
    nodeOwnerDoc.set(root, doc);
  }
}

function validateDocumentTypeName(name: string): void {
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index);
    if (code <= 0x1f || code === 0x20 || code === 0x3e) {
      throw new DOMException(
        "createDocumentType: '" + name + "' is not a valid qualified name",
        "InvalidCharacterError",
      );
    }
  }
}

function constructDocumentType(
  name: string,
  publicId: unknown,
  systemId: unknown,
  ownerDocument: DocumentImpl | DetachedDocument | ParsedDocument | undefined,
): DocumentTypeNode {
  const synthetic = Object.create(DocumentTypeNode.prototype);
  Object.defineProperty(synthetic, "_info", {
    value: {
      nodeType: DOCTYPE_NODE,
      nodeName: name,
      localName: "",
      nodeValue: "",
    },
    enumerable: false,
  });
  Object.defineProperty(synthetic, "_id", {
    value: nextSyntheticId(),
    enumerable: false,
  });
  Object.defineProperty(synthetic, "name", { value: name });
  Object.defineProperty(synthetic, "publicId", { value: String(publicId ?? "") });
  Object.defineProperty(synthetic, "systemId", { value: String(systemId ?? "") });
  // The doctype belongs to the implementation's document, not the page's.
  if (ownerDocument) nodeOwnerDoc.set(synthetic, ownerDocument);
  return synthetic;
}

const DOCUMENT_INSERTABLE_NODE_TYPES = new Set([
  DOCUMENT_FRAGMENT_NODE,
  DOCTYPE_NODE,
  ELEMENT_NODE,
  TEXT_NODE,
  PROCESSING_INSTRUCTION_NODE,
  COMMENT_NODE,
]);

interface DocumentChildSurvey {
  elementChild: NodeBase | null;
  doctypeChild: NodeBase | null;
}

function assertAllowedDocumentPreInsertionNode(
  node: NodeBase | null,
  document: object,
  operation: string,
): asserts node is NodeBase {
  if (!node) throw new TypeError(operation + ": first argument is not a Node");
  const nodeType = node.nodeType;
  if ((node as unknown) === document) {
    throw new DOMException(
      operation + ": cannot insert a document into itself",
      "HierarchyRequestError",
    );
  }
  if (!DOCUMENT_INSERTABLE_NODE_TYPES.has(nodeType)) {
    throw new DOMException(
      operation + ": node type " + nodeType + " cannot be inserted",
      "HierarchyRequestError",
    );
  }
  if (nodeType === TEXT_NODE) {
    throw new DOMException(
      operation + ": cannot insert a Text node directly under a document",
      "HierarchyRequestError",
    );
  }
}

function shouldSkipReplacedDocumentChild(
  node: NodeBase,
  child: NodeBase | null,
  isReplace: boolean,
): boolean {
  return isReplace && node === child;
}

function rememberDocumentChild(survey: DocumentChildSurvey, node: NodeBase): void {
  if (node.nodeType === ELEMENT_NODE && !survey.elementChild) survey.elementChild = node;
  if (node.nodeType === DOCTYPE_NODE && !survey.doctypeChild) survey.doctypeChild = node;
}

function surveyDocumentChildren(
  children: NodeBase[],
  child: NodeBase | null,
  isReplace: boolean,
): DocumentChildSurvey {
  const survey: DocumentChildSurvey = { elementChild: null, doctypeChild: null };
  for (const node of children) {
    if (shouldSkipReplacedDocumentChild(node, child, isReplace)) continue;
    rememberDocumentChild(survey, node);
  }
  return survey;
}

function documentInsertionIndex(children: NodeBase[], child: NodeBase | null): number {
  return child == null ? children.length : children.indexOf(child);
}

function documentElementBeforePosition(
  children: NodeBase[],
  childIndex: number,
  child: NodeBase | null,
  isReplace: boolean,
): boolean {
  for (let index = 0; index < childIndex; index++) {
    const node = children[index];
    if (shouldSkipReplacedDocumentChild(node, child, isReplace)) continue;
    if (node.nodeType === ELEMENT_NODE) return true;
  }
  return false;
}

function documentDoctypeAfterPosition(
  children: NodeBase[],
  childIndex: number,
  child: NodeBase | null,
  isReplace: boolean,
): boolean {
  for (let index = childIndex + 1; index < children.length; index++) {
    const node = children[index];
    if (shouldSkipReplacedDocumentChild(node, child, isReplace)) continue;
    if (node.nodeType === DOCTYPE_NODE) return true;
  }
  return false;
}

function fragmentInsertionContents(fragment: NodeBase): { elementCount: number; hasText: boolean } {
  let elementCount = 0;
  let hasText = false;
  for (let index = 0; index < fragment.childNodes.length; index++) {
    const child = fragment.childNodes[index];
    if (child.nodeType === ELEMENT_NODE) elementCount++;
    else if (child.nodeType === TEXT_NODE) hasText = true;
  }
  return { elementCount, hasText };
}

function assertElementReferenceIsNotDoctype(
  child: NodeBase | null,
  isReplace: boolean,
  operation: string,
): void {
  if (child == null) return;
  if (isReplace) return;
  if (child.nodeType === DOCTYPE_NODE) {
    throw new DOMException(
      operation + ": cannot insert an element before the doctype",
      "HierarchyRequestError",
    );
  }
}

function assertDocumentElementInsertionAllowed(
  operation: string,
  child: NodeBase | null,
  isReplace: boolean,
  hasElement: boolean,
  children: NodeBase[],
  childIndex: number,
): void {
  if (hasElement) {
    throw new DOMException(
      operation + ": document already has a document element",
      "HierarchyRequestError",
    );
  }
  assertElementReferenceIsNotDoctype(child, isReplace, operation);
  if (
    child != null &&
    !isReplace &&
    documentDoctypeAfterPosition(children, childIndex, child, isReplace)
  ) {
    throw new DOMException(
      operation + ": cannot insert an element before an existing doctype",
      "HierarchyRequestError",
    );
  }
}

function assertDocumentFragmentContentsAllowed(
  fragment: NodeBase,
  operation: string,
  child: NodeBase | null,
  isReplace: boolean,
  hasElement: boolean,
  children: NodeBase[],
  childIndex: number,
): void {
  const contents = fragmentInsertionContents(fragment);
  if (contents.elementCount > 1 || contents.hasText) {
    throw new DOMException(
      operation + ": DocumentFragment has multiple elements or contains text",
      "HierarchyRequestError",
    );
  }
  if (contents.elementCount === 1) {
    assertDocumentElementInsertionAllowed(
      operation,
      child,
      isReplace,
      hasElement,
      children,
      childIndex,
    );
  }
}

function assertDocumentDoctypeInsertionAllowed(
  operation: string,
  child: NodeBase | null,
  hasDoctype: boolean,
  hasElement: boolean,
  children: NodeBase[],
  childIndex: number,
  isReplace: boolean,
): void {
  if (hasDoctype) {
    throw new DOMException(operation + ": document already has a doctype", "HierarchyRequestError");
  }
  if (child != null) {
    if (documentElementBeforePosition(children, childIndex, child, isReplace)) {
      throw new DOMException(
        operation + ": cannot insert a doctype after the document element",
        "HierarchyRequestError",
      );
    }
  } else if (hasElement) {
    throw new DOMException(
      operation + ": cannot append a doctype after the document element",
      "HierarchyRequestError",
    );
  }
}

function isHostBackedDocumentChild(node: NodeBase | null | undefined): node is NodeBase {
  return Boolean(
    node && node.nodeType !== DOCTYPE_NODE && typeof node._id === "number" && node._id >= 0,
  );
}

function detachDocumentNodeForInsertion(document: DetachedDocument, node: NodeBase): number | null {
  const currentParent = node.parentNode;
  if (!currentParent) return null;
  if (currentParent !== document) {
    try {
      currentParent.removeChild(node);
    } catch {}
    return null;
  }
  const existingIndex = document._topChildren.indexOf(node);
  if (existingIndex < 0) return null;
  rangeBeforeRemove(document, existingIndex, node);
  document._topChildren.splice(existingIndex, 1);
  return existingIndex;
}

function insertHostDocumentNodeAtIndex(
  document: DetachedDocument,
  node: NodeBase,
  index: number,
): void {
  const anchor = document._hostAnchorForInsertion(index + 1);
  if (anchor) document._host.insertBefore(node, anchor);
  else document._host.appendChild(node);
}

function assertInsertBeforeArgumentCount(argumentCount: number): void {
  if (argumentCount < 2) {
    throw new TypeError(
      "insertBefore: 2 arguments required, but only " + argumentCount + " present",
    );
  }
}

function assertInsertBeforeReferenceIsNode(ref: NodeBase | null): void {
  if (ref != null && (typeof ref !== "object" || typeof ref.nodeType !== "number")) {
    throw new TypeError("insertBefore: reference is not a Node");
  }
}

function assertInsertBeforeNodeIsValid(node: NodeBase): asserts node is NodeBase {
  if (node == null || typeof node !== "object" || typeof node.nodeType !== "number") {
    throw new TypeError("insertBefore: first argument is not a Node");
  }
}

function assertInsertBeforeReferenceIsChild(
  document: DetachedDocument,
  ref: NodeBase | null,
): void {
  if (ref != null && document._topChildren.indexOf(ref) < 0) {
    throw new DOMException(
      "insertBefore: reference child is not a child of this document",
      "NotFoundError",
    );
  }
}

function insertDocumentFragmentBefore(
  document: DetachedDocument,
  fragment: NodeBase,
  ref: NodeBase | null,
): NodeBase {
  document._validateDocumentPreInsertion(fragment, ref, "insertBefore", false);
  const children = Array.from<NodeBase>(fragment.childNodes);
  let insertIndex = documentInsertionIndex(document._topChildren, ref);
  for (const child of children) {
    document._insertOneAtIndex(child, insertIndex);
    insertIndex++;
  }
  return fragment;
}

function assertOldDocumentChild(document: DetachedDocument, oldNode: NodeBase): void {
  if (oldNode == null || document._topChildren.indexOf(oldNode) < 0) {
    throw new DOMException(
      "replaceChild: old child is not a child of this document",
      "NotFoundError",
    );
  }
}

function validateDocumentReplacement(
  document: DetachedDocument,
  newNode: NodeBase,
  oldNode: NodeBase,
): void {
  if (newNode && newNode.nodeType === DOCUMENT_FRAGMENT_NODE) {
    document._validateDocumentPreInsertion(newNode, oldNode, "replaceChild", true);
  } else {
    document._validateDocumentPreInsertion(newNode, oldNode, "replaceChild", true);
  }
}

function removeReplacedDocumentChild(
  document: DetachedDocument,
  oldNode: NodeBase,
  oldIndex: number,
): void {
  rangeBeforeRemove(document, oldIndex, oldNode);
  document._topChildren.splice(oldIndex, 1);
  if (oldNode.nodeType !== DOCTYPE_NODE) {
    try {
      document._host.removeChild(oldNode);
    } catch {}
  }
}

function insertDocumentReplacement(
  document: DetachedDocument,
  newNode: NodeBase,
  oldIndex: number,
): void {
  if (newNode.nodeType === DOCUMENT_FRAGMENT_NODE) {
    const children = Array.from<NodeBase>(newNode.childNodes);
    let insertIndex = oldIndex;
    for (const child of children) {
      document._insertOneAtIndex(child, insertIndex);
      insertIndex++;
    }
  } else {
    document._insertOneAtIndex(newNode, oldIndex);
  }
}

function findDocumentDescendant(root: Element, tagName: string): Element | null {
  try {
    return root.querySelector ? root.querySelector(tagName) : null;
  } catch {
    return null;
  }
}

function documentTitleText(root: Element | null): string {
  if (!root) return "";
  try {
    return titleTextForRoot(root);
  } catch {
    return "";
  }
}

function titleTextForRoot(root: Element): string {
  const title = root.querySelector ? root.querySelector("title") : null;
  if (!title) return "";
  return normalizedTitleText(title.textContent);
}

function normalizedTitleText(text: string | null): string {
  return (text || "").replace(/[\s]+/g, " ").trim();
}

function createDocumentTitle(
  root: Element,
  createElement: (tagName: string) => Element,
): Element | null {
  try {
    const title = createElement("title");
    const head = findDocumentDescendant(root, "head");
    (head || root).appendChild(title);
    return title;
  } catch {
    return null;
  }
}

function setDocumentTitle(
  root: Element | null,
  value: unknown,
  createElement: (tagName: string) => Element,
): void {
  if (!root) return;
  let title = findDocumentDescendant(root, "title");
  if (!title) title = createDocumentTitle(root, createElement);
  if (title) title.textContent = value == null ? "" : String(value);
}

function equalDocumentChild(left: Idl.Node | null, right: Idl.Node | null): boolean {
  if (!left || !right) return left === right;
  if (typeof left.isEqualNode !== "function") return false;
  return left.isEqualNode(right);
}

function equalDocumentChildLists(left: Idl.NodeList, right: Idl.NodeList): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (!equalDocumentChild(left[index], right[index])) return false;
  }
  return true;
}

function copyDetachedDocumentMetadata(
  source: DetachedDocument,
  destination: DetachedDocument,
): void {
  if (source._contentType) {
    Object.defineProperty(destination, "_contentType", {
      value: source._contentType,
      enumerable: false,
    });
  }
  if (source._baseUrl) {
    Object.defineProperty(destination, "_baseUrl", {
      value: source._baseUrl,
      enumerable: false,
    });
  }
}

function copyDetachedDocumentChildren(
  source: DetachedDocument,
  destination: DetachedDocument,
): void {
  for (const child of source.childNodes) {
    if (child && typeof child.cloneNode === "function") destination.append(child.cloneNode(true));
  }
}

function cloneDetachedDocument(
  source: DetachedDocument,
  deep: boolean | undefined,
): DetachedDocument {
  const clone = new DetachedDocument();
  copyDetachedDocumentMetadata(source, clone);
  if (deep) copyDetachedDocumentChildren(source, clone);
  return clone;
}

function documentChildListContains(children: readonly unknown[], node: unknown): boolean {
  return Boolean(children && children.indexOf(node) >= 0);
}

function documentNodeId(node: unknown): number | null {
  const id = (node as { _id?: unknown })._id;
  return typeof id === "number" ? id : null;
}

function safeDocumentParentId(nodeId: number): number {
  try {
    return dom.parentId(nodeId);
  } catch {
    return -1;
  }
}

function isTerminalDocumentParent(parentId: number, nodeId: number): boolean {
  return parentId < 0 || parentId === nodeId;
}

function hostContainsNode(hostId: number, nodeId: number): boolean {
  if (nodeId === hostId) return true;
  let currentId = nodeId;
  let safety = 0;
  while (safety < MAX_NODE_ANCESTOR_HOPS) {
    const parentId = safeDocumentParentId(currentId);
    if (isTerminalDocumentParent(parentId, currentId)) return false;
    if (parentId === hostId) return true;
    currentId = parentId;
    safety++;
  }
  return false;
}

function detachedDocumentContainsNode(document: DetachedDocument, node: unknown): boolean {
  if (node == null) return false;
  if (documentChildListContains(document._topChildren, node)) return true;
  const nodeId = documentNodeId(node);
  if (nodeId === null) return false;
  return hostContainsNode(document._hostId, nodeId);
}

function copyImportedAttribute(
  attribute: Element["attributes"][number] | undefined,
  destination: Element,
): void {
  if (!attribute) return;
  if (attribute.namespaceURI) {
    destination.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
  } else {
    destination.setAttribute(attribute.name, attribute.value);
  }
}

function assertObjectAdoptionNode(node: NodeBase, operation: string): void {
  if (node == null || typeof node !== "object") {
    throw new TypeError(operation + ": argument must be a Node");
  }
}

function assertNotDocumentAdoptionNode(node: NodeBase, operation: string): void {
  if (node.nodeType === DOCUMENT_NODE) {
    throw new DOMException(operation + ": cannot adopt a Document", "NotSupportedError");
  }
}

function assertNotShadowRootAdoptionNode(node: NodeBase, operation: string): void {
  if (isShadowRootNode(node)) {
    throw new DOMException(operation + ": cannot adopt a ShadowRoot", "HierarchyRequestError");
  }
}

function assertAdoptableNode(node: NodeBase, operation: string): void {
  assertObjectAdoptionNode(node, operation);
  assertNotDocumentAdoptionNode(node, operation);
  assertNotShadowRootAdoptionNode(node, operation);
}

function removeAdoptedNodeFromParent(node: NodeBase): void {
  const parent = node.parentNode;
  if (!parent) return;
  try {
    parent.removeChild(node);
  } catch {}
}

function setAdoptedNodeOwner(node: NodeBase, document: DocumentImpl, isLive: boolean): void {
  if (isLive) nodeOwnerDoc.delete(node);
  else nodeOwnerDoc.set(node, document);
}

function clearAdoptedNodeState(node: NodeBase, isLive: boolean): void {
  if (node.nodeType === DOCTYPE_NODE) syntheticParent.delete(node);
  clearLiveDocumentXmlOwnership(node, isLive);
}

function clearLiveDocumentXmlOwnership(node: NodeBase, isLive: boolean): void {
  if (!isLive) return;
  if (node.nodeType !== ELEMENT_NODE) return;
  if (typeof node._id !== "number") return;
  if (node._id < 0) return;
  xmlOwned.delete(node._id);
}

function stampAdoptedNode(node: NodeBase | null, document: DocumentImpl, isLive: boolean): void {
  if (!node || typeof node !== "object") return;
  setAdoptedNodeOwner(node, document, isLive);
  clearAdoptedNodeState(node, isLive);
  stampAdoptedNodeChildren(node, document, isLive);
}

function stampAdoptedNodeChildren(node: NodeBase, document: DocumentImpl, isLive: boolean): void {
  try {
    const children = node.childNodes;
    if (children) {
      for (let i = 0; i < children.length; i++) stampAdoptedNode(children[i], document, isLive);
    }
  } catch {}
}

function stampDetachedAdoptedXmlState(node: NodeBase, targetIsXml: boolean): void {
  if (node.nodeType !== ELEMENT_NODE) return;
  if (typeof node._id !== "number") return;
  if (node._id < 0) return;
  if (targetIsXml) {
    xmlOwned.add(node._id);
    fastpathMarkSpecial(node._id);
  } else {
    xmlOwned.delete(node._id);
  }
}

function stampDetachedAdoptedNode(
  node: NodeBase | null,
  document: DetachedDocument,
  targetIsXml: boolean,
): void {
  if (!node || typeof node !== "object") return;
  nodeOwnerDoc.set(node, document);
  if (node.nodeType === DOCTYPE_NODE) syntheticParent.delete(node);
  stampDetachedAdoptedXmlState(node, targetIsXml);
  stampDetachedAdoptedChildren(node, document, targetIsXml);
}

function stampDetachedAdoptedChildren(
  node: NodeBase,
  document: DetachedDocument,
  targetIsXml: boolean,
): void {
  try {
    const children = node.childNodes;
    if (children) {
      for (let index = 0; index < children.length; index++) {
        stampDetachedAdoptedNode(children[index], document, targetIsXml);
      }
    }
  } catch {}
}

function stampOwnerDocumentSubtree(node: NodeBase | null, document: DetachedDocument): void {
  if (!node || typeof node !== "object") return;
  nodeOwnerDoc.set(node, document);
  stampOwnerDocumentChildren(node, document);
}

function stampOwnerDocumentChildren(node: NodeBase, document: DetachedDocument): void {
  try {
    const children = node.childNodes;
    if (children) {
      for (let index = 0; index < children.length; index++) {
        stampOwnerDocumentSubtree(children[index], document);
      }
    }
  } catch {}
}

function assertImportNodeIsPresent(node: NodeBase | null): asserts node is NodeBase {
  if (!node) throw notSupported("importNode: node is null/undefined");
}

function assertImportNodeIsNotShadowRoot(node: NodeBase): void {
  if (isShadowRootNode(node)) {
    throw new DOMException("importNode: cannot import a ShadowRoot", "NotSupportedError");
  }
}

function assertDetachedImportNodeIsObject(node: unknown): asserts node is object {
  if (node === null || typeof node !== "object") {
    throw new TypeError("importNode: node must be a Node");
  }
}

function assertDetachedImportNodeIsNotDocument(node: object): void {
  if ("nodeType" in node && node.nodeType === DOCUMENT_NODE) {
    throw new DOMException("importNode: cannot import a Document", "NotSupportedError");
  }
}

function cloneDetachedImportNode(node: object, deep: unknown): unknown {
  if ("cloneNode" in node && typeof node.cloneNode === "function") {
    return node.cloneNode(Boolean(deep));
  }
  throw new TypeError("importNode: node must be a Node");
}

function importDetachedNode(node: unknown, deep: unknown): unknown {
  assertDetachedImportNodeIsObject(node);
  assertDetachedImportNodeIsNotDocument(node);
  if (isShadowRootNode(node)) {
    throw new DOMException("importNode: cannot import a ShadowRoot", "NotSupportedError");
  }
  return cloneDetachedImportNode(node, deep);
}

function importDocumentNode(
  document: DocumentImpl,
  node: NodeBase,
  deep: boolean | Idl.ImportNodeOptions | undefined,
) {
  if (node.nodeType === ELEMENT_NODE) return importElementNode(document, node as Element, deep);
  const textOrComment = importTextOrCommentNode(document, node);
  if (textOrComment) return textOrComment;
  if (node.nodeType === ATTRIBUTE_NODE) return importAttributeNode(node);
  if (node.nodeType === DOCUMENT_FRAGMENT_NODE) return importDocumentFragment(document, node, deep);
  return null;
}

function importElementNode(
  document: DocumentImpl,
  source: Element,
  deep: boolean | Idl.ImportNodeOptions | undefined,
): Element {
  const namespace = importedElementNamespace(source);
  const qualifiedName = importedElementQualifiedName(source);
  const clone = document.createElementNS(namespace, qualifiedName);
  copyImportedAttributesSafely(source, clone);
  appendImportedChildren(document, source, clone, deep);
  return clone;
}

function importedElementNamespace(source: Element): string {
  return source.namespaceURI || HTML_NS;
}

function importedElementQualifiedName(source: Element): string {
  const localName = importedElementLocalName(source);
  const prefix = importedElementPrefix(source);
  return prefix ? `${prefix}:${localName}` : localName;
}

function importedElementLocalName(source: Element): string {
  return source.localName || source._info?.localName || "";
}

function importedElementPrefix(source: Element): string | null {
  return source.prefix || null;
}

function copyImportedAttributesSafely(source: Element, destination: Element): void {
  try {
    copyImportedAttributes(source, destination);
  } catch {}
}

function importTextOrCommentNode(document: DocumentImpl, node: NodeBase) {
  if (node.nodeType === TEXT_NODE) return document.createTextNode(importedTextData(node));
  if (node.nodeType === COMMENT_NODE) return document.createComment(importedCommentData(node));
  return null;
}

function importedTextData(node: NodeBase): string {
  return node.nodeValue || node.textContent || "";
}

function importedCommentData(node: NodeBase): string {
  return node.nodeValue || "";
}

function importAttributeNode(node: NodeBase) {
  return typeof node.cloneNode === "function" ? node.cloneNode(true) : null;
}

function importDocumentFragment(
  document: DocumentImpl,
  source: NodeBase,
  deep: boolean | Idl.ImportNodeOptions | undefined,
): DocumentFragmentImpl {
  const fragment = document.createDocumentFragment();
  appendImportedChildren(document, source, fragment, deep);
  return fragment;
}

function appendImportedChildren(
  document: DocumentImpl,
  source: NodeBase,
  destination: NodeBase,
  deep: boolean | Idl.ImportNodeOptions | undefined,
): void {
  if (deep && source.childNodes) {
    for (let i = 0; i < source.childNodes.length; i++) {
      const childClone = document.importNode(source.childNodes[i], true);
      if (childClone) destination.appendChild(childClone);
    }
  }
}

function normalizedElementNamespace(namespaceURI: string | null): string | null {
  return namespaceURI == null || namespaceURI === "" ? null : String(namespaceURI);
}

function normalizedElementQualifiedName(qualifiedName: string): string {
  return String(qualifiedName === undefined ? "undefined" : qualifiedName);
}

function splitQualifiedElementName(qualifiedName: string): {
  prefix: string | null;
  local: string;
} {
  const colon = qualifiedName.indexOf(":");
  return {
    prefix: colon >= 0 ? qualifiedName.slice(0, colon) : null,
    local: colon >= 0 ? qualifiedName.slice(colon + 1) : qualifiedName,
  };
}

function isElementNameStartCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return code >= 0x80 || /^[A-Za-z_:]$/u.test(character);
}

function hasBlockedElementNameCharacter(name: string): boolean {
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index);
    // Control chars, space and `>` fail anywhere. `<` fails only as the
    // first local char (the NameStartChar check), so "f<oo" is valid.
    if (code <= 0x20 || code === 0x3e) return true;
  }
  return false;
}

function hasInvalidQualifiedElementNameParts(
  qualifiedName: string,
  prefix: string | null,
  localName: string,
): boolean {
  return (
    hasInvalidQualifiedElementNameLength(qualifiedName, prefix, localName) ||
    hasInvalidQualifiedElementNameCharacters(qualifiedName, localName)
  );
}

function hasInvalidQualifiedElementNameLength(
  qualifiedName: string,
  prefix: string | null,
  localName: string,
): boolean {
  return qualifiedName.length === 0 || localName.length === 0 || prefix === "";
}

function hasInvalidQualifiedElementNameCharacters(
  qualifiedName: string,
  localName: string,
): boolean {
  return (
    hasBlockedElementNameCharacter(qualifiedName) || !isElementNameStartCharacter(localName[0])
  );
}

function assertValidQualifiedElementName(
  qualifiedName: string,
  prefix: string | null,
  localName: string,
): void {
  if (hasInvalidQualifiedElementNameParts(qualifiedName, prefix, localName)) {
    throw new DOMException(
      "createElementNS: '" + qualifiedName + "' is not a valid qualified name",
      "InvalidCharacterError",
    );
  }
}

function assertElementPrefixHasNamespace(prefix: string | null, namespace: string | null): void {
  if (prefix && !namespace) {
    throw new DOMException(
      "createElementNS: prefix '" + prefix + "' requires a non-null namespace",
      "NamespaceError",
    );
  }
}

function assertXmlElementPrefix(prefix: string | null, namespace: string | null): void {
  if (prefix === "xml" && namespace !== XML_NS) {
    throw new DOMException(
      "createElementNS: 'xml' prefix is reserved for the XML namespace",
      "NamespaceError",
    );
  }
}

function assertXmlnsElementName(
  qualifiedName: string,
  prefix: string | null,
  namespace: string | null,
): void {
  if ((qualifiedName === "xmlns" || prefix === "xmlns") && namespace !== XMLNS_NS) {
    throw new DOMException(
      "createElementNS: 'xmlns' qualifies only the XMLNS namespace",
      "NamespaceError",
    );
  }
}

function assertXmlnsElementNamespace(
  qualifiedName: string,
  prefix: string | null,
  namespace: string | null,
): void {
  if (namespace === XMLNS_NS && qualifiedName !== "xmlns" && prefix !== "xmlns") {
    throw new DOMException(
      "createElementNS: XMLNS namespace requires the 'xmlns' qname or prefix",
      "NamespaceError",
    );
  }
}

function assertValidElementNamespaceName(
  qualifiedName: string,
  prefix: string | null,
  namespace: string | null,
): void {
  assertElementPrefixHasNamespace(prefix, namespace);
  assertXmlElementPrefix(prefix, namespace);
  assertXmlnsElementName(qualifiedName, prefix, namespace);
  assertXmlnsElementNamespace(qualifiedName, prefix, namespace);
}

function elementLocalNameForWasm(namespace: string | null, localName: string): string {
  return namespace === HTML_NS
    ? localName.replace(/[A-Z]/g, (character) => character.toLowerCase())
    : localName;
}

function elementNamespaceForWasm(namespace: string | null): string {
  return namespace == null ? "" : String(namespace);
}

function requestSvgTextFontOutline(namespace: string | null, localName: string): void {
  if (namespace !== SVG_NS || localName !== "text") return;
  try {
    ksGlobal.__ksFontOutlineDemand?.();
  } catch {}
}

function createElementInNamespace(namespace: string, localName: string): number {
  return typeof (dom as any).createElementNS === "function"
    ? (dom as any).createElementNS(namespace, localName)
    : dom.createElement(localName);
}

type CurrentScriptList = {
  readonly length: number;
  readonly [index: number]: Element | null | undefined;
};

function shouldSearchInlineCurrentScript(src: string, bodyKey: unknown): bodyKey is string {
  return (
    src === "" &&
    typeof bodyKey === "string" &&
    bodyKey.length > CURRENT_SCRIPT_BODY_KEY_MATCH_THRESHOLD
  );
}

function currentScriptList(document: DocumentImpl): CurrentScriptList {
  return document.querySelectorAll("script");
}

function isInlineScript(script: Element | null | undefined): script is Element {
  return !!script && !(script.getAttribute && script.getAttribute("src"));
}

function scriptContainsBodyKey(script: Element, bodyKey: string): boolean {
  return (script.textContent || "").includes(bodyKey);
}

function findInlineCurrentScript(document: DocumentImpl, bodyKey: string): Element | null {
  try {
    const scripts = currentScriptList(document);
    for (let index = 0; index < scripts.length; index++) {
      const script = scripts[index];
      if (!isInlineScript(script)) continue;
      if (scriptContainsBodyKey(script, bodyKey)) return script;
    }
  } catch {}
  return null;
}

function isScriptElement(script: Element | null | undefined): script is Element {
  return (
    !!script && typeof script.tagName === "string" && script.tagName.toUpperCase() === "SCRIPT"
  );
}

function scriptSourceMatches(source: unknown, rawSrc: unknown, src: string): boolean {
  return source === rawSrc || source === src;
}

function hasMatchingScriptSource(script: Element, rawSrc: unknown, src: string): boolean {
  const source = script.getAttribute ? script.getAttribute("src") : null;
  return source != null && scriptSourceMatches(source, rawSrc, src);
}

function matchesCurrentScriptSource(
  script: Element | null | undefined,
  rawSrc: unknown,
  src: string,
): script is Element {
  return isScriptElement(script) && hasMatchingScriptSource(script, rawSrc, src);
}

function indexedCurrentScript(
  scripts: CurrentScriptList,
  domIndex: unknown,
  rawSrc: unknown,
  src: string,
): Element | null | undefined {
  if (
    typeof domIndex === "number" &&
    domIndex >= 0 &&
    matchesCurrentScriptSource(scripts && scripts[domIndex], rawSrc, src)
  ) {
    return scripts[domIndex];
  }
  return null;
}

function firstCurrentScriptWithSource(
  scripts: CurrentScriptList,
  rawSrc: unknown,
  src: string,
): Element | null {
  for (let index = 0; index < scripts.length; index++) {
    if (matchesCurrentScriptSource(scripts[index], rawSrc, src)) return scripts[index] ?? null;
  }
  return null;
}

function findCurrentScriptBySource(
  document: DocumentImpl,
  domIndex: unknown,
  rawSrc: unknown,
  src: string,
): Element | null {
  try {
    const scripts = currentScriptList(document);
    const indexed = indexedCurrentScript(scripts, domIndex, rawSrc, src);
    if (indexed) return indexed;
    return firstCurrentScriptWithSource(scripts, rawSrc, src);
  } catch {}
  return null;
}

type CrossDocumentMethodName = "querySelector" | "querySelectorAll" | "getElementById";

function isCrossDocumentMethodReceiver(
  receiver: unknown,
  methodName: CrossDocumentMethodName,
  ownMethod: unknown,
): boolean {
  if (!isObjectLike(receiver)) return false;
  if (!Reflect.get(receiver, "_dom")) return false;
  if (typeof Reflect.get(receiver, methodName) !== "function") return false;
  return Reflect.get(receiver, methodName) !== ownMethod;
}

function matchesNamespaceAndLocalName(
  element: Element,
  namespace: string | null,
  localName: string,
): boolean {
  const elementNamespace = element.namespaceURI || null;
  return namespaceMatches(elementNamespace, namespace) && localNameMatches(element, localName);
}

function namespaceMatches(elementNamespace: string | null, namespace: string | null): boolean {
  return namespace === "*" || elementNamespace === namespace;
}

function localNameMatches(element: Element, localName: string): boolean {
  return localName === "*" || (element.localName || "") === localName;
}

interface DocumentImpl
  extends
    Pick<
      Idl.Document,
      | "location"
      | "URL"
      | "documentURI"
      | "modelContext"
      | Extract<keyof Idl.Document, `on${string}`>
      | Exclude<SharedDocumentMember, "textContent">
    >,
    SharedDocumentTypeGaps {}

class DocumentImpl extends NodeBase implements Idl.Document {
  // Storage behind the childNodes, doctype and implementation accessors.
  declare _doctype: any;
  declare _docChildNodes: any;
  declare _doctypeMarker: string | null;
  declare _implementation: DOMImplementationCls | undefined;
  // Set on createHTMLDocument documents; undefined on the live document.
  declare _baseUrl: string;
  // Lazy cache for the `fonts` getter.
  declare __fontFaceSet: DocumentFontSet | undefined;
  declare __editing: EditingEngine | undefined;
  constructor() {
    super(DOCUMENT_ID, {
      nodeType: DOCUMENT_NODE,
      nodeName: "#document",
      localName: "",
      nodeValue: "",
    });
    // location is [LegacyUnforgeable]: an own non-configurable accessor on
    // each instance. All instances share one getter and setter function,
    // as WebIDL requires. Assigning a string forwards to location.href.
    Object.defineProperty(this, "location", {
      get: __ks_documentImpl_location_get,
      set: __ks_documentImpl_location_set,
      enumerable: true,
      configurable: false,
    });
    // Own non-configurable accessors, so page JS can't spoof page identity
    // with defineProperty. They read the live URL so pushState shows up.
    Object.defineProperty(this, "URL", {
      get: () => getCurrentUrl(),
      enumerable: true,
      configurable: false,
    });
    Object.defineProperty(this, "documentURI", {
      get: () => getCurrentUrl(),
      enumerable: true,
      configurable: false,
    });
    Object.defineProperty(this, "baseURI", {
      get: () => computeDocBaseURI(getCurrentUrl()),
      enumerable: true,
      configurable: false,
    });
    Object.defineProperty(this, "defaultView", {
      get: () => window,
      enumerable: true,
      configurable: false,
    });
  }
  get nodeName() {
    return "#document";
  }
  // A clone of the live document is a DetachedDocument holding a deep clone
  // of <html>, or an empty one when there is no <html> to clone.
  // Limitation: the clone is always deep.
  cloneNode(_deep?: boolean) {
    const doc = new DetachedDocument();
    Object.defineProperty(doc, "_isHtml", {
      value: true,
      writable: false,
      enumerable: false,
    });
    const htmlId = dom.querySelector("html");
    const cloneId = htmlId < 0 ? 0 : dom.deepCloneNode(htmlId);
    if (cloneId === 0) return doc;
    // Move the clone under the doc's host element and register it in
    // _topChildren: documentElement reads _topChildren, not the host's
    // wasm children.
    try {
      dom.appendChildNode(doc._hostId, cloneId);
    } catch {}
    const htmlWrap = nodeFor(cloneId);
    if (htmlWrap) doc._topChildren.push(htmlWrap);
    return doc;
  }
  get title() {
    return dom.title();
  }
  set title(value) {
    const s = value == null ? "" : String(value);
    let t = Array.prototype.find.call(
      this.getElementsByTagName("title"),
      (el: { namespaceURI?: string | null }) => el.namespaceURI === HTML_NS,
    );
    if (!t) {
      const head = this.head;
      if (!head) return;
      t = this.createElement("title");
      head.appendChild(t);
    }
    t.textContent = s;
  }
  get readyState() {
    return readyState;
  }
  get characterSet() {
    return documentCharacterSet();
  }
  get charset() {
    return documentCharacterSet();
  }
  get inputEncoding() {
    return documentCharacterSet();
  }
  get contentType() {
    return "text/html";
  }
  // A Document's ownerDocument is null. NodeBase's default would return
  // the live document itself.
  get ownerDocument() {
    return null;
  }
  // Reads return the local cookie string, seeded at navigate. Writes apply
  // locally so a read sees them at once, and queue the raw line for the
  // parent to replay into the jar.
  get cookie() {
    return cookieString;
  }
  get referrer() {
    return typeof opts?.referrer === "string" ? opts.referrer : "";
  }
  set cookie(value) {
    const raw = String(value ?? "");
    if (!raw) return;
    applyLocalCookieWrite(raw);
    cookieWrites.push(raw);
  }
  // Blitz drops doctypes during parse, so keep a synthetic node for this document.
  get doctype() {
    if (!this._doctype) {
      const synth: DocumentTypeNode = Object.create(DocumentTypeNode.prototype);
      Object.defineProperty(synth, "_info", {
        value: {
          nodeType: DOCTYPE_NODE,
          nodeName: "html",
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
        value: "html",
        enumerable: false,
      });
      Object.defineProperty(synth, "publicId", {
        value: "",
        enumerable: false,
      });
      Object.defineProperty(synth, "systemId", {
        value: "",
        enumerable: false,
      });
      Object.defineProperty(this, "_doctype", {
        value: synth,
        writable: false,
        enumerable: false,
      });
      syntheticParent.set(synth, this);
      nodeOwnerDoc.set(synth, this);
    }
    return this._doctype;
  }
  // Keep the synthetic doctype at its source position without changing Blitz's XHTML sniff.
  get childNodes() {
    if (!this._docChildNodes) {
      const self = this;
      const id = this._id;
      const list = makeNodeList(() => {
        const ids = Array.from<number>(dom.childIds(id));
        const wasmKids = ids.map((cid) => nodeFor(cid)).filter(Boolean);
        // Keep the marker at its source position; leading comments alter Blitz's XHTML sniff.
        let doctypeIdx = self._doctypeMarker
          ? wasmKids.findIndex(
              (n) => n?.nodeType === COMMENT_NODE && n.data === self._doctypeMarker,
            )
          : -1;
        if (doctypeIdx >= 0) {
          wasmKids.splice(doctypeIdx, 1);
        } else {
          doctypeIdx = wasmKids.findIndex((n) => n && n.nodeType === ELEMENT_NODE);
          if (doctypeIdx < 0) doctypeIdx = wasmKids.length;
        }
        const doctype = self.doctype;
        if (syntheticParent.get(doctype) !== self) return wasmKids;
        return [...wasmKids.slice(0, doctypeIdx), doctype, ...wasmKids.slice(doctypeIdx)];
      });
      Object.defineProperty(this, "_docChildNodes", {
        value: list,
        writable: false,
        enumerable: false,
      });
    }
    return this._docChildNodes;
  }

  // Reject document roots before changing node ownership.
  adoptNode(node: NodeBase) {
    assertAdoptableNode(node, "adoptNode");
    removeAdoptedNodeFromParent(node);
    // nodeOwnerDoc has no entry for nodes of the live document, so adopting
    // into it deletes entries and adopting into a detached document sets them.
    const isLive = this === windowObj.document;
    stampAdoptedNode(node, this, isLive);
    return node;
  }

  // Partial importNode: elements, text, comments, attrs and fragments.
  // The clone is not in xmlOwned, so tagName follows HTML rules.
  importNode(node: NodeBase, deep?: boolean | Idl.ImportNodeOptions) {
    assertImportNodeIsPresent(node);
    // Importing a shadow root is a NotSupportedError.
    assertImportNodeIsNotShadowRoot(node);
    // Limitation: other node types return null.
    return importDocumentNode(this, node, deep);
  }

  get documentElement() {
    const id = dom.querySelector("html");
    if (id < 0) return null;
    const el = nodeFor(id);
    if (!el) return null;
    if (!el.rootStamped) {
      const proto = (name: string): (() => number) | null => {
        let p: any = Object.getPrototypeOf(el);
        while (p) {
          const d = Object.getOwnPropertyDescriptor(p, name);
          if (d && typeof d.get === "function") return d.get as () => number;
          p = Object.getPrototypeOf(p);
        }
        return null;
      };
      const scrollW = proto("scrollWidth");
      const scrollH = proto("scrollHeight");
      const stamp = (name: string, get: () => number) => {
        try {
          Object.defineProperty(el, name, { get, configurable: true, enumerable: false });
        } catch {}
      };
      stamp("clientWidth", () => rootViewport().w);
      stamp("clientHeight", () => rootViewport().h);
      stamp("scrollWidth", () =>
        Math.max(rootViewport().w, scrollW ? Math.round(scrollW.call(el)) : 0),
      );
      stamp("scrollHeight", () =>
        Math.max(rootViewport().h, scrollH ? Math.round(scrollH.call(el)) : 0),
      );
      Object.defineProperty(el, "rootStamped", {
        value: true,
        configurable: true,
        enumerable: false,
      });
    }
    return el;
  }
  get head() {
    const id = dom.querySelector("head");
    return id >= 0 ? nodeFor(id) : null;
  }
  get body() {
    const id = dom.querySelector("body");
    return id >= 0 ? nodeFor(id) : null;
  }
  // ParentNode mixin members. children is a live HTMLCollection of the
  // element nodes in childNodes.
  get children(): Idl.HTMLCollection {
    return makeHtmlCollection(() => {
      const out: Element[] = [];
      const kids = this.childNodes;
      for (let i = 0; i < kids.length; i++) {
        const n = kids[i];
        if (isElementNode(n)) out.push(n);
      }
      return out;
    });
  }
  get firstElementChild(): Idl.Element | null {
    const docEl = this.documentElement;
    if (docEl) return docEl;
    const kids = this.childNodes;
    for (let i = 0; i < kids.length; i++) {
      if (kids[i].nodeType === ELEMENT_NODE) return kids[i];
    }
    return null;
  }
  get lastElementChild(): Idl.Element | null {
    const kids = this.children;
    return kids.length > 0 ? kids[kids.length - 1] : null;
  }
  get childElementCount(): number {
    return this.children.length;
  }
  // document.forms is a live, tree-ordered collection with indexed and
  // named access by id or name.
  get forms() {
    return makeHtmlCollection(() => {
      const ids = dom.querySelectorAll("form");
      const out: Element[] = [];
      for (const id of ids) {
        const n: Element | null = nodeFor(id);
        if (n) out.push(n);
      }
      return out;
    });
  }
  get applets() {
    return makeHtmlCollection(() => []);
  }
  // Plugins never render, but pages probe document.embeds.length.
  get embeds() {
    return makeHtmlCollection(() => {
      const ids = dom.querySelectorAll("embed");
      const out: Element[] = [];
      for (const id of ids) {
        const n: Element | null = nodeFor(id);
        if (n) out.push(n);
      }
      return out;
    });
  }
  get scripts() {
    return makeHtmlCollection(() => {
      const ids = dom.querySelectorAll("script");
      const out: Element[] = [];
      for (const id of ids) {
        const n: Element | null = nodeFor(id);
        if (n) out.push(n);
      }
      return out;
    });
  }
  get images() {
    return makeHtmlCollection(() => {
      const ids = dom.querySelectorAll("img");
      const out: Element[] = [];
      for (const id of ids) {
        const n: Element | null = nodeFor(id);
        if (n) out.push(n);
      }
      return out;
    });
  }
  get links() {
    return makeHtmlCollection(() => {
      const ids = dom.querySelectorAll("a[href], area[href]");
      const out: Element[] = [];
      for (const id of ids) {
        const n: Element | null = nodeFor(id);
        if (n) out.push(n);
      }
      return out;
    });
  }
  get anchors() {
    return makeHtmlCollection(() => {
      const ids = dom.querySelectorAll("a[name]");
      const out: Element[] = [];
      for (const id of ids) {
        const n: Element | null = nodeFor(id);
        if (n) out.push(n);
      }
      return out;
    });
  }
  // A fresh list per call, one sheet per <style> or stylesheet <link>.
  // CSS-in-JS libraries iterate it at boot. insertRule mirrors rules into
  // the owning <style> so blitz paints them.
  get styleSheets(): ReturnType<typeof makeStyleSheetList> {
    return makeStyleSheetList();
  }
  // A Proxy over a real array that mirrors each adopted sheet into a
  // hidden <style> in <head>, so stylo's cascade sees the rules.
  get adoptedStyleSheets() {
    return adoptedStyleSheets;
  }
  set adoptedStyleSheets(v) {
    // Clear, then push each sheet, so the mirror reconcile runs.
    const a: any = adoptedStyleSheets;
    a.length = 0;
    if (v && typeof v[Symbol.iterator] === "function") {
      for (const s of v) a.push(s);
    }
  }
  // body when nothing has focus.
  get activeElement() {
    return activeElement || this.body || null;
  }
  get timeline(): ReturnType<typeof getDocumentTimeline> {
    return getDocumentTimeline();
  }
  getAnimations(): ReturnType<typeof animationsFor> {
    return animationsFor(this, true);
  }

  querySelector(selector: string) {
    if (arguments.length < 1) {
      throw new TypeError(
        "Failed to execute 'querySelector' on 'Document': 1 argument required, but only 0 present.",
      );
    }
    // Cross-doc receiver, see getElementsByTagName.
    if (
      isCrossDocumentMethodReceiver(this, "querySelector", DocumentImpl.prototype.querySelector)
    ) {
      return (this as any).querySelector(selector);
    }
    return scopedQuerySelector(DOCUMENT_ID, selector);
  }
  querySelectorAll(selector: string) {
    if (arguments.length < 1) {
      throw new TypeError(
        "Failed to execute 'querySelectorAll' on 'Document': 1 argument required, but only 0 present.",
      );
    }
    if (
      isCrossDocumentMethodReceiver(
        this,
        "querySelectorAll",
        DocumentImpl.prototype.querySelectorAll,
      )
    ) {
      return (this as any).querySelectorAll(selector);
    }
    return scopedQuerySelectorAll(DOCUMENT_ID, selector);
  }
  getElementById(id: string) {
    // Cross-doc receiver, see getElementsByTagName.
    if (
      isCrossDocumentMethodReceiver(this, "getElementById", DocumentImpl.prototype.getElementById)
    ) {
      return (this as any).getElementById(id);
    }
    // DOMString conversion: null searches for "null". No element matches "".
    const key = String(id);
    if (key === "") return null;
    const nid = dom.getElementById(key);
    return nid >= 0 ? nodeFor(nid) : null;
  }
  getElementsByTagName(name: string) {
    // Respect cross-document receivers; DOMPurify calls this with its parsed document.
    if (
      this &&
      (this as any)._dom &&
      typeof (this as any).getElementsByTagName === "function" &&
      (this as any).getElementsByTagName !== DocumentImpl.prototype.getElementsByTagName
    ) {
      return (this as any).getElementsByTagName(name);
    }
    // Filter `*` in JS: the wasm case-insensitive selector is wrong for
    // non-ASCII tags (see Element.getElementsByTagName).
    const qname = String(name);
    return makeHtmlCollection(() => {
      try {
        const cand = Array.from<Element>(scopedQuerySelectorAll(DOCUMENT_ID, "*"));
        if (qname === "*") return cand;
        return filterByQualifiedName(cand, qname);
      } catch {
        return [];
      }
    });
  }
  getElementsByTagNameNS(namespace: string | null, localName: string) {
    // An empty namespace means null.
    const ns =
      namespace === null || namespace === undefined || namespace === "" ? null : String(namespace);
    const ln = String(localName);
    return makeHtmlCollection(() => {
      try {
        const cand = Array.from<Element>(scopedQuerySelectorAll(DOCUMENT_ID, "*"));
        return cand.filter((element) => matchesNamespaceAndLocalName(element, ns, ln));
      } catch {
        return [];
      }
    });
  }
  // github's Turbo anchor resolver calls getElementsByName(t)[0].
  // Limitation: returns a static Array, not a live NodeList.
  getElementsByName(name: string): Element[] {
    const t = String(name);
    if (t === "") return [];
    try {
      return Array.from<number>(dom.querySelectorAll('[name="' + t.replace(/"/g, '\\"') + '"]'))
        .map((id) => nodeFor(id))
        .filter(Boolean);
    } catch {
      return [];
    }
  }
  getElementsByClassName(name: string) {
    // Split on ASCII whitespace only (see the Element variant).
    const cls = String(name)
      .split(/[\t\n\f\r ]+/)
      .filter(Boolean);
    if (cls.length === 0) return makeHtmlCollection(() => []);
    const sel = cls.map((c) => "." + cssEscape(c)).join("");
    return makeHtmlCollection(() => {
      try {
        return Array.from<Element>(scopedQuerySelectorAll(DOCUMENT_ID, sel));
      } catch {
        return [];
      }
    });
  }

  // ----- Document mutation surface --------------------------------
  // Detached nodes remain in the wasm tree until navigation discards the isolate.
  createElement(localName: string, options?: string | Idl.ElementCreationOptions): Element;
  createElement(tagName: string): Element {
    const t = String(tagName);
    if (t.length === 0 || !isValidXmlName(t)) {
      throw new DOMException(
        "createElement: '" + t + "' is not a valid Name",
        "InvalidCharacterError",
      );
    }
    const asciiLower = t.replace(/[A-Z]/g, (c) => c.toLowerCase());
    const id = dom.createElement(asciiLower);
    if (asciiLower === "script") markRuntimeCreatedScript(id);
    // createElement never splits on a colon: prefix is null. viaNS=false
    // keeps the localName getter from slicing the qname.
    elemNs.set(id, {
      qname: asciiLower,
      ns: HTML_NS,
      viaNS: false,
    });
    const node = nodeFor(id);
    // A defined custom element is constructed synchronously, so its
    // constructor has run when createElement returns. github's behaviors.js
    // reads `createElement("turbo-frame").delegate`, set in the constructor.
    // No connectedCallback: the element is detached.
    upgradeIfCustomElement(node, asciiLower);
    return node;
  }

  createElementNS(
    namespace: string | null,
    qualifiedName: string,
    options?: string | Idl.ElementCreationOptions,
  ): Element;
  createElementNS(namespaceURI: string | null, qualifiedName: string): Element {
    const ns = normalizedElementNamespace(namespaceURI);
    const qn = normalizedElementQualifiedName(qualifiedName);
    // Split on the first colon; later colons stay in the local part. The
    // local part must start with a NameStartChar, and all non-ASCII counts,
    // as in browsers. A prefix must be non-empty but may start with a digit.
    const { prefix, local } = splitQualifiedElementName(qn);
    assertValidQualifiedElementName(qn, prefix, local);
    assertValidElementNamespaceName(qn, prefix, ns);
    const isHtmlNs = ns === HTML_NS;
    const localForWasm = elementLocalNameForWasm(ns, local);
    // Stylo's namespace selectors (`|div`, `*|div`) need the real namespace,
    // including "no namespace".
    const nsForWasm = elementNamespaceForWasm(ns);
    requestSvgTextFontOutline(ns, local);
    const id = createElementInNamespace(nsForWasm, localForWasm);
    // Keyed by node id so the namespace survives a new wrapper.
    elemNs.set(id, {
      qname: qn,
      ns,
      viaNS: true,
    });
    // The namespace lives in elemNs, not in blitz, so the boa-to-blitz
    // fast path must never answer for this node (fastpath.ts).
    fastpathMarkSpecial(id);
    const node = nodeFor(id);
    if (isHtmlNs) upgradeIfCustomElement(node, localForWasm);
    return node;
  }
  createTextNode(data: string): TextNode {
    // WebIDL DOMString conversion preserves "null" and "undefined".
    const id = dom.createTextNode(String(data));
    return nodeFor(id);
  }
  // Blitz has no detached attributes, so this builds the same Attr object
  // that .attributes uses, with no owner element.
  createAttribute(name: string) {
    // WebIDL DOMString conversion preserves "null" and "undefined".
    const nm = String(name);
    validateAttrName(nm);
    // The live document is HTML, so ASCII-lowercase the name.
    const finalName = nm.replace(/[A-Z]/g, (c) => c.toLowerCase());
    const attr = Object.create(AttrCls.prototype);
    attr._name = finalName;
    attr._value = "";
    attr._nodeValue = "";
    attr._textContent = "";
    attr._namespaceURI = null;
    attr._prefix = null;
    attr._localName = finalName;
    attr._ownerElement = null;
    return attr;
  }
  createComment(data: string): CommentNode {
    // WebIDL DOMString conversion preserves "null" and "undefined".
    const text = String(data);
    const id = dom.createComment(text);
    // Blitz's create_comment_node takes no data, so keep it here.
    commentData.set(id, text);
    return nodeFor(id);
  }
  // Limitation: wasm has no PI nodes, so a PI is a Text node stamped with
  // nodeType 7, nodeName and target. DetachedDocument does the same.
  createProcessingInstruction(target: string, data: string): Idl.ProcessingInstruction {
    validatePIArgs(target, data);
    const t = this.createTextNode(processingInstructionData(data));
    Object.defineProperty(t, "nodeType", { value: 7, enumerable: false, configurable: true });
    defineProcessingInstructionNames(t, target, true);
    // Element.textContent skips stamped PI ids. The id stays live because
    // setting textContent detaches nodes without dropping them.
    markProcessingInstructionNode(t);
    return t;
  }
  // A Text node stamped with nodeType 4. Limitation: the spec throws for
  // HTML documents, but this does not.
  createCDATASection(data: string): Idl.CDATASection {
    const t = this.createTextNode(String(data ?? ""));
    Object.defineProperty(t, "nodeType", { value: 4, enumerable: false, configurable: true });
    Object.defineProperty(t, "nodeName", {
      value: "#cdata-section",
      enumerable: false,
      configurable: true,
    });
    return t;
  }
  // The wasm node is a <div>; fragmentIds makes nodeFor wrap it as a
  // DocumentFragment. Limitation: a "div" selector can match the fragment.
  createDocumentFragment(): DocumentFragmentImpl {
    const id = dom.createElement("div");
    fragmentIds.add(id);
    return nodeFor(id);
  }
  createTreeWalker(root: Idl.Node, whatToShow?: number, filter?: Idl.NodeFilter | null) {
    // A non-Node root is a TypeError. A numeric nodeType stands in for the
    // brand check.
    if (root == null || typeof root.nodeType !== "number") {
      throw new TypeError("createTreeWalker: root must be a Node");
    }
    // Only undefined takes the SHOW_ALL default; null converts to 0.
    const w = whatToShow === undefined ? 0xffffffff : whatToShow >>> 0;
    return new TreeWalker(root, w, filter === undefined ? null : filter);
  }
  createNodeIterator(root: Idl.Node, whatToShow?: number, filter?: Idl.NodeFilter | null) {
    if (root == null || typeof root.nodeType !== "number") {
      throw new TypeError("createNodeIterator: root must be a Node");
    }
    const w = whatToShow === undefined ? 0xffffffff : whatToShow >>> 0;
    return new NodeIterator(root, w, filter === undefined ? null : filter);
  }
  // Limitation: write() runs after parse, so it appends the markup to body
  // or documentElement. It must not throw: a throw stops the rest of the
  // classic-script bucket.
  write(...args: string[]) {
    try {
      writeDocumentMarkup(this, args);
    } catch {}
  }
  writeln(...args: string[]) {
    this.write(args.join("") + "\n");
  }
  open() {
    this._reopened = true;
    return this;
  }
  close() {
    if (!this._reopened) return;
    this._reopened = false;
    getInternalState().documentReopened = true;
  }
  // Armed by open(), consumed by close().
  _reopened = false;

  hasFocus() {
    return true;
  }

  get fonts(): DocumentFontSet {
    if (!this.__fontFaceSet) {
      const faces = new Set();
      const fontsReadyHook = (globalThis as { __ks_fontsReady?: () => Promise<void> })
        .__ks_fontsReady;
      const fontsInflightHook = (globalThis as { __ks_fontsInflightCount?: () => number })
        .__ks_fontsInflightCount;
      const self: DocumentFontSet = {
        get ready() {
          const p = fontsReadyHook
            ? (() => {
                try {
                  return fontsReadyHook();
                } catch {
                  return null;
                }
              })()
            : null;
          return (p || Promise.resolve()).then(() => self);
        },
        get status() {
          const n = fontsInflightHook
            ? (() => {
                try {
                  return fontsInflightHook();
                } catch {
                  return 0;
                }
              })()
            : 0;
          return (n | 0) > 0 ? "loading" : "loaded";
        },
        add(f: unknown) {
          faces.add(f);
          return self;
        },
        delete(f: unknown) {
          return faces.delete(f);
        },
        clear() {
          faces.clear();
        },
        has(f: unknown) {
          return faces.has(f);
        },
        get size() {
          return faces.size;
        },
        forEach(cb: (face: unknown, face2: unknown, set: Set<unknown>) => void, thisArg?: unknown) {
          faces.forEach(cb, thisArg);
        },
        load(_font: string, _text?: string) {
          // Limitation: resolves with every added face once fonts are ready,
          // not only the faces matching `font` and `text`.
          const p = fontsReadyHook
            ? (() => {
                try {
                  return fontsReadyHook();
                } catch {
                  return null;
                }
              })()
            : null;
          return (p || Promise.resolve()).then(() => Array.from(faces));
        },
        check(_font: string, _text?: string) {
          return true;
        },
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() {
          return true;
        },
        [Symbol.iterator]() {
          return faces[Symbol.iterator]();
        },
      };
      this.__fontFaceSet = self;
    }
    return this.__fontFaceSet;
  }

  // Unsupported editing commands and internal failures return false.
  execCommand(command: string, showUI: boolean = false, value: string = "") {
    try {
      return editingEngine(this).execCommand(String(command), !!showUI, String(value));
    } catch {
      return false;
    }
  }

  queryCommandSupported(command: string) {
    return editingEngine(this).queryCommandSupported(String(command));
  }

  queryCommandEnabled(command: string) {
    try {
      return editingEngine(this).queryCommandEnabled(String(command));
    } catch {
      return false;
    }
  }

  queryCommandState(command: string) {
    try {
      return editingEngine(this).queryCommandState(String(command));
    } catch {
      return false;
    }
  }

  queryCommandValue(command: string) {
    try {
      return editingEngine(this).queryCommandValue(String(command));
    } catch {
      return "";
    }
  }

  queryCommandIndeterm(command: string) {
    try {
      return editingEngine(this).queryCommandIndeterm(String(command));
    } catch {
      return false;
    }
  }

  // The same Selection as window.getSelection().
  getSelection() {
    return getSelection();
  }

  get currentScript() {
    const src = ksState().currentScriptSrc;
    if (typeof src !== "string") return null;
    const st = ksState();
    const bodyKey = st.currentScriptBodyKey;
    if (shouldSearchInlineCurrentScript(src, bodyKey)) {
      const inlineScript = findInlineCurrentScript(this, bodyKey);
      if (inlineScript) return inlineScript;
    }
    const rawSrc = st.currentScriptRawSrc;
    const domIndex = st.currentScriptDomIndex;
    const sourceScript = findCurrentScriptBySource(this, domIndex, rawSrc, src);
    if (sourceScript) return sourceScript;
    // No live node matched. The synthetic node's src attribute is the
    // authored value, as on a real node.
    return getOrMakeSyntheticScript(src, rawSrc);
  }

  elementFromPoint(x: number, y: number): Element | null {
    const px = normalizedHitTestCoordinate(x);
    const py = normalizedHitTestCoordinate(y);
    const painted = paintedElementAtPoint(px, py);
    if (painted.found) return painted.element;
    const scroll = scrollOffset();
    const dx = px + scroll.x;
    const dy = py + scroll.y;
    if (layoutMode() === "off") return cheapElementAtPoint(dx, dy);
    // A wasm panic unwinds and the DOM survives, so fall back to the cheap walker.
    // Returning null would route the click to body and the input would
    // never focus.
    const domHit = completedDomPointHit(domElementAtPoint(dx, dy));
    if (domHit.completed) return domHit.element;
    return fallbackCheapElementAtPoint(dx, dy);
  }
  elementsFromPoint(x: number, y: number): Element[] {
    // The current hit test returns only the topmost match.
    const top = this.elementFromPoint(x, y);
    return top ? [top] : [];
  }
}

// Document's [Unscopable] ParentNode names, plus the ChildNode names it
// inherits from NodeBase but should not have. Event handler content
// attributes run inside `with(document)`, so a bare `remove` in an
// onclick must not resolve to document.remove.
Object.defineProperty(DocumentImpl.prototype, Symbol.unscopables, {
  value: Object.freeze({
    append: true,
    prepend: true,
    replaceChildren: true,
    // Inherited ChildNode names, see above.
    after: true,
    before: true,
    replaceWith: true,
    remove: true,
  }),
  configurable: true,
  enumerable: false,
  writable: false,
});

// DOMImplementation backs `document.implementation`. The owning Document
// memoizes the instance, so `document.implementation` keeps its identity.
class DOMImplementationCls implements Idl.DOMImplementation {
  readonly #ownerDocument: DocumentImpl | DetachedDocument | ParsedDocument | undefined;
  constructor(ownerDoc?: DocumentImpl | DetachedDocument | ParsedDocument) {
    this.#ownerDocument = ownerDoc;
  }
  hasFeature() {
    return true;
  }
  createHTMLDocument(title?: string): DetachedDocument;
  createHTMLDocument(title?: unknown): DetachedDocument {
    const doc = new DetachedDocument();
    // contentType reports "text/html" instead of the XML default.
    Object.defineProperty(doc, "_isHtml", {
      value: true,
      writable: false,
      enumerable: false,
    });
    const dt = this.createDocumentType("html", "", "");
    const html = createElementInternal("html");
    const head = createElementInternal("head");
    // Only an omitted or undefined title skips the <title>. A given title,
    // even "", gets a Text child.
    if (title !== undefined) {
      const titleEl = createElementInternal("title");
      titleEl.appendChild(createTextNodeInternal(String(title)));
      head.appendChild(titleEl);
    }
    const body = createElementInternal("body");
    html.appendChild(head);
    html.appendChild(body);
    // Seed the children directly instead of through appendChild's
    // validation; <html> still goes into the wasm host tree.
    doc._host.appendChild(html);
    doc._topChildren.push(dt);
    doc._topChildren.push(html);
    syntheticParent.set(dt, doc);
    nodeOwnerDoc.set(dt, doc);
    // The subtree was created through the page document, so re-stamp
    // every node's ownerDocument.
    stampOwnerDocumentSubtree(html, doc);
    return doc;
  }
  createDocument(
    namespace: string | null,
    qualifiedName: string,
    doctype?: Idl.DocumentType | null,
  ): XMLDocument;
  createDocument(namespaceURI: unknown, qualifiedName: unknown, doctype?: unknown): XMLDocument {
    assertCreateDocumentHasArguments(arguments.length);
    // WebIDL nullable DocumentType conversion.
    assertDocumentTypeArgument(doctype);
    const doc = new XMLDocument();
    // Later doc.createElement calls use this namespace; a null or empty
    // namespace means no namespace.
    const requestedNs = normalizedDocumentNamespace(namespaceURI);
    Object.defineProperty(doc, "_createElementNs", {
      value: requestedNs,
      writable: false,
      enumerable: false,
    });
    appendProvidedDocumentType(doc, doctype);
    // DOMString?: null and "" create no root element, undefined creates
    // <undefined>.
    appendDocumentRoot(doc, namespaceURI, qualifiedName);
    return doc;
  }
  createDocumentType(qname: unknown, publicId: unknown, systemId: unknown): DocumentTypeNode {
    // The spec validates qname as a QName, but browsers only reject a
    // space, ">" or a C0 control character.
    const name = String(qname ?? "");
    validateDocumentTypeName(name);
    return constructDocumentType(name, publicId, systemId, this.#ownerDocument);
  }
}

// One shared location getter and setter for every DetachedDocument, as
// WebIDL requires. A detached document has no window, so location is null.
function __ks_detachedDocument_location_get(): null {
  return null;
}
function __ks_detachedDocument_location_set(_v: unknown): void {}

// A live HTMLCollection of the elements in a created document's tree that
// match selector; applets passes null and is always empty.
function hostCollection(doc: DetachedDocument, selector: string | null) {
  return makeHtmlCollection(() => {
    if (selector === null || !doc._host) return [];
    try {
      return Array.from<Element>(doc._host.querySelectorAll(selector));
    } catch {
      return [];
    }
  });
}

// DetachedDocument supplies the Node identity and location that NodeBase does not.
interface DetachedDocument
  extends
    Pick<
      Idl.Document,
      | "nodeType"
      | "nodeName"
      | "ownerDocument"
      | "parentNode"
      | "location"
      | "importNode"
      | "modelContext"
      | Extract<keyof Idl.Document, `on${string}`>
      | SharedDocumentMember
    >,
    SharedDocumentTypeGaps {}

class DetachedDocument implements Idl.Document {
  // Set by the constructor and the createDocument, createHTMLDocument and
  // DOMParser paths.
  declare _dom: any;
  declare _hostId: number;
  declare _host: any;
  declare _topChildren: any[];
  declare _cnList: any;
  declare _baseUrl: string;
  declare _contentType: string;
  declare _isHtml: boolean;
  declare _implementation: any;
  // The namespace createDocument() was given; null for createHTMLDocument
  // and DOMParser. contentType and the element factories branch on it.
  declare _createElementNs: string | null | undefined;
  // A Document's nodeValue is null and setting it does nothing.
  get nodeValue() {
    return null;
  }
  set nodeValue(_v) {
    /* spec: do nothing */
  }
  // about:blank unless the creator set _baseUrl.
  get URL() {
    return this._baseUrl || "about:blank";
  }
  get documentURI() {
    return this._baseUrl || "about:blank";
  }
  get baseURI() {
    return computeDocBaseURI(this._baseUrl || "about:blank");
  }
  get characterSet() {
    return "UTF-8";
  }
  get charset() {
    return "UTF-8";
  }
  get inputEncoding() {
    return "UTF-8";
  }
  // A document is a tree root: no parent and no siblings.
  get nextSibling() {
    return null;
  }
  get previousSibling() {
    return null;
  }
  get parentElement() {
    return null;
  }
  // A document is its own root, so it is always connected.
  getRootNode(_options?: Idl.GetRootNodeOptions) {
    return this;
  }
  get isConnected() {
    return true;
  }
  // Text can't sit directly under a document, so normalize each child.
  normalize() {
    for (const child of this._topChildren) {
      if (child && child.nodeType === ELEMENT_NODE) child.normalize();
    }
  }
  constructor() {
    // [LegacyUnforgeable]: an own non-configurable accessor per instance.
    Object.defineProperty(this, "location", {
      get: __ks_detachedDocument_location_get,
      set: __ks_detachedDocument_location_set,
      enumerable: true,
      configurable: false,
    });
    // The host stores real children; _topChildren also exposes the synthetic doctype.
    const hostId = dom.createElement("div");
    Object.defineProperty(this, "_hostId", {
      value: hostId,
      enumerable: false,
    });
    Object.defineProperty(this, "_host", {
      value: nodeFor(hostId),
      enumerable: false,
    });
    hostIdToDoc.set(hostId, this);
    fastpathMarkSpecial(hostId);
    Object.defineProperty(this, "nodeType", {
      value: DOCUMENT_NODE,
      enumerable: false,
    });
    Object.defineProperty(this, "nodeName", {
      value: "#document",
      enumerable: false,
    });
    Object.defineProperty(this, "ownerDocument", {
      value: null,
      enumerable: false,
    });
    Object.defineProperty(this, "parentNode", {
      value: null,
      enumerable: false,
    });
    // The spec-visible children, read by childNodes, documentElement and
    // the rest. A synthetic doctype lives only here. The wasm nodes also
    // sit under _host, so _host.querySelector still finds them.
    Object.defineProperty(this, "_topChildren", {
      value: [],
      writable: true,
      enumerable: false,
    });
  }
  get contentType() {
    if (this._isHtml) return "text/html";
    const ns = this._createElementNs;
    if (ns === HTML_NS) return "application/xhtml+xml";
    if (ns === SVG_NS) return "image/svg+xml";
    return "application/xml";
  }
  // Memoized: childNodes must return the same live NodeList every time.
  get childNodes() {
    if (!this._cnList) {
      const self = this;
      Object.defineProperty(this, "_cnList", {
        value: makeNodeList(() => self._topChildren.slice()),
        writable: false,
        enumerable: false,
      });
    }
    return this._cnList;
  }
  get firstChild() {
    return this._topChildren.length > 0 ? this._topChildren[0] : null;
  }
  get lastChild() {
    const n = this._topChildren.length;
    return n > 0 ? this._topChildren[n - 1] : null;
  }
  get documentElement() {
    for (let i = 0; i < this._topChildren.length; i++) {
      const c = this._topChildren[i];
      if (c && c.nodeType === ELEMENT_NODE) return c;
    }
    return null;
  }
  get doctype() {
    for (let i = 0; i < this._topChildren.length; i++) {
      const c = this._topChildren[i];
      if (c && c.nodeType === DOCTYPE_NODE) return c;
    }
    return null;
  }
  // Validate Document children before the host mutates the shared wasm tree.
  // Steps 4-6 for a Document parent. With isReplace, `child` is ignored in
  // the survey because replaceChild removes it first.
  _validateDocumentPreInsertion(
    node: NodeBase | null,
    child: NodeBase | null,
    op: string,
    isReplace: boolean,
  ): void {
    assertAllowedDocumentPreInsertionNode(node, this, op);
    const nt = node.nodeType;
    // Step 6 also keeps the doctype before the document element.
    const top = this._topChildren;
    // The existing element and doctype children, ignoring `child` on replace.
    const survey = surveyDocumentChildren(top, child, isReplace);
    // A null child (append) sits past the end.
    const childIdx = documentInsertionIndex(top, child);
    if (nt === DOCUMENT_FRAGMENT_NODE) {
      assertDocumentFragmentContentsAllowed(
        node,
        op,
        child,
        isReplace,
        survey.elementChild !== null,
        top,
        childIdx,
      );
      return;
    }
    if (nt === ELEMENT_NODE) {
      assertDocumentElementInsertionAllowed(
        op,
        child,
        isReplace,
        survey.elementChild !== null,
        top,
        childIdx,
      );
      return;
    }
    if (nt === DOCTYPE_NODE) {
      assertDocumentDoctypeInsertionAllowed(
        op,
        child,
        survey.doctypeChild !== null,
        survey.elementChild !== null,
        top,
        childIdx,
        isReplace,
      );
    }
  }
  // The host child to insert before so host order matches _topChildren:
  // the next wasm-backed node from refIndex on, or null to append.
  _hostAnchorForInsertion(refIndex: number): NodeBase | null {
    const top = this._topChildren;
    for (let i = refIndex; i < top.length; i++) {
      const c = top[i];
      // Synthetic doctypes are not in the host tree.
      if (isHostBackedDocumentChild(c)) return c;
    }
    return null;
  }
  appendChild(node: NodeBase) {
    if (node && node.nodeType === DOCUMENT_FRAGMENT_NODE) {
      // Validate the fragment as a whole, then move each child.
      this._validateDocumentPreInsertion(node, null, "appendChild", false);
      const kids = Array.from<NodeBase>(node.childNodes);
      for (const k of kids) this._appendOne(k);
      return node;
    }
    this._validateDocumentPreInsertion(node, null, "appendChild", false);
    this._appendOne(node);
    return node;
  }
  _appendOne(node: NodeBase): void {
    // Re-appending a child moves it to the end.
    detachDocumentNodeForInsertion(this, node);
    // A doctype has no wasm parent, so syntheticParent gives it one.
    nodeOwnerDoc.set(node, this);
    if (node.nodeType === DOCTYPE_NODE) {
      syntheticParent.set(node, this);
      this._topChildren.push(node);
      // No wasm op ran, so bump the seq that childNodes caches on.
      bumpMutationSeq();
    } else {
      this._host.appendChild(node);
      this._topChildren.push(node);
    }
  }
  insertBefore(node: NodeBase, ref: NodeBase | null) {
    // WebIDL: insertBefore(Node, Node?). Two args required.
    assertInsertBeforeArgumentCount(arguments.length);
    // The reference must be a Node or null.
    assertInsertBeforeReferenceIsNode(ref);
    assertInsertBeforeNodeIsValid(node);
    // Step 3's NotFoundError comes before the hierarchy checks of steps 4-6.
    assertInsertBeforeReferenceIsChild(this, ref);
    if (node.nodeType === DOCUMENT_FRAGMENT_NODE) {
      // Compute the insertion index at validation time so splices stay anchored.
      return insertDocumentFragmentBefore(this, node, ref);
    }
    this._validateDocumentPreInsertion(node, ref, "insertBefore", false);
    const insertIdx = documentInsertionIndex(this._topChildren, ref);
    this._insertOneAtIndex(node, insertIdx);
    return node;
  }
  _insertOneAtIndex(node: NodeBase, idx: number): void {
    const existingIndex = detachDocumentNodeForInsertion(this, node);
    if (existingIndex !== null && existingIndex < idx) idx--;
    // A doctype has no wasm parent, so syntheticParent gives it one.
    nodeOwnerDoc.set(node, this);
    this._topChildren.splice(idx, 0, node);
    if (node.nodeType === DOCTYPE_NODE) syntheticParent.set(node, this);
    else insertHostDocumentNodeAtIndex(this, node, idx);
    // Live range boundaries after idx shift right by one.
    rangeAfterInsert(this, idx, 1);
  }
  removeChild(node: NodeBase) {
    if (node == null) {
      throw new TypeError("removeChild: argument is not a Node");
    }
    const idx = this._topChildren.indexOf(node);
    if (idx < 0) {
      throw new DOMException("removeChild: node is not a child of this document", "NotFoundError");
    }
    rangeBeforeRemove(this, idx, node);
    this._topChildren.splice(idx, 1);
    // A synthetic doctype removal runs no wasm op, so bump the seq here.
    bumpMutationSeq();
    if (node.nodeType === DOCTYPE_NODE) {
      syntheticParent.delete(node);
    } else {
      try {
        this._host.removeChild(node);
      } catch {}
    }
    return node;
  }
  replaceChild(newNode: NodeBase, oldNode: NodeBase) {
    assertOldDocumentChild(this, oldNode);
    validateDocumentReplacement(this, newNode, oldNode);
    if (newNode === oldNode) return oldNode;
    const oldIdx = this._topChildren.indexOf(oldNode);
    removeReplacedDocumentChild(this, oldNode, oldIdx);
    insertDocumentReplacement(this, newNode, oldIdx);
    return oldNode;
  }
  // Document children may contain one Element and one DocumentType, with
  // the Element first; Text children are forbidden. Validate before the
  // host converts string arguments, then mirror accepted nodes into
  // _topChildren because childNodes reads that list.
  append(...nodes: Array<NodeBase | string>) {
    assertDocumentInsertAllowed(this, nodes, "append", false);
    this._host.append(...nodes);
    for (const n of nodes) this._topChildren.push(n);
  }
  prepend(...nodes: Array<NodeBase | string>) {
    assertDocumentInsertAllowed(this, nodes, "prepend", true);
    this._host.prepend(...nodes);
    for (let i = nodes.length - 1; i >= 0; i--) {
      this._topChildren.unshift(nodes[i]);
    }
  }
  replaceChildren(...nodes: Array<NodeBase | string>) {
    // Validate against the current children before removing them, as
    // required by the ensure-pre-insertion-validity steps.
    assertDocumentInsertAllowed(this, nodes, "replaceChildren", false, false);
    this._host.replaceChildren(...nodes);
    this._topChildren.length = 0;
    for (const n of nodes) this._topChildren.push(n);
  }
  // DetachedDocument does not extend NodeBase, so it defines the Node
  // identity, comparison and namespace methods itself.
  isSameNode(other: Idl.Node | null) {
    if (!other) return false;
    return this === other;
  }
  compareDocumentPosition(other: Idl.Node) {
    if (!other) throw new TypeError("compareDocumentPosition: argument required");
    if (other === this) return 0;
    return compareDocumentPosition(this, other);
  }
  // Adoption targets this detached document rather than the live page Document.
  adoptNode(node: NodeBase) {
    assertAdoptableNode(node, "adoptNode");
    removeAdoptedNodeFromParent(node);
    const targetIsXml = !this._isHtml;
    stampDetachedAdoptedNode(node, this, targetIsXml);
    return node;
  }
  // A Document delegates namespace lookup to its documentElement.
  lookupNamespaceURI(prefix: string | null) {
    const root = this.documentElement;
    return root ? root.lookupNamespaceURI(prefix) : null;
  }
  lookupPrefix(namespace: string | null) {
    const root = this.documentElement;
    return root ? root.lookupPrefix(namespace) : null;
  }
  isDefaultNamespace(namespace: string | null) {
    const ns = namespace === "" ? null : namespace;
    return this.lookupNamespaceURI(null) === ns;
  }
  isEqualNode(other: Idl.Node | null) {
    if (!other || other.nodeType !== DOCUMENT_NODE) return false;
    // Documents compare by children only, not by URL or other metadata.
    return equalDocumentChildLists(this.childNodes, other.childNodes);
  }
  cloneNode(deep?: boolean) {
    return cloneDetachedDocument(this, deep);
  }
  // Inclusive descendant check. The document itself is not in the host's
  // parent chain, so self needs its own check.
  contains(other: unknown) {
    if (other === this) return true;
    return detachedDocumentContainsNode(this, other);
  }
  hasChildNodes() {
    return this._host.hasChildNodes();
  }
  // The wasm DOM is one tree, so the factories create nodes through the
  // live document, then stamp this document as their owner.
  createElement(localName: string, options?: string | Idl.ElementCreationOptions): Element;
  createElement(tagName: string) {
    const el = createElementInternal(tagName);
    // NamedNodeMap's own-key filter applies only to HTML elements in HTML
    // documents. No entry means HTML.
    if (!this._isHtml) {
      elementOwnerIsHtml.set(el._id, false);
      // XML keeps the tag name's case. The namespace is HTML only when
      // createDocument asked for it, or for a plain `new Document()`.
      let ns;
      if (this._createElementNs === undefined) {
        ns = HTML_NS;
      } else if (this._createElementNs === HTML_NS) {
        ns = HTML_NS;
      } else {
        ns = null;
      }
      elemNs.set(el._id, {
        qname: String(tagName),
        ns,
        viaNS: true,
      });
      xmlOwned.add(el._id);
      fastpathMarkSpecial(el._id);
    }
    nodeOwnerDoc.set(el, this);
    return el;
  }
  createElementNS(
    namespace: string | null,
    qualifiedName: string,
    options?: string | Idl.ElementCreationOptions,
  ): Element;
  createElementNS(ns: string | null, qname: string) {
    const el = createElementNSInternal(ns, qname);
    if (!this._isHtml) {
      elementOwnerIsHtml.set(el._id, false);
      xmlOwned.add(el._id);
      fastpathMarkSpecial(el._id);
    }
    nodeOwnerDoc.set(el, this);
    return el;
  }
  createTextNode(data: string) {
    // Preserve DOMString conversion: null and undefined become
    // their string forms.
    const node = createTextNodeInternal(data == null ? String(data) : data);
    nodeOwnerDoc.set(node, this);
    return node;
  }
  createComment(data: string) {
    // Preserve DOMString conversion for null and undefined.
    const node = createCommentInternal(data == null ? String(data) : data);
    nodeOwnerDoc.set(node, this);
    return node;
  }
  createDocumentFragment() {
    const frag = createDocumentFragmentInternal();
    nodeOwnerDoc.set(frag, this);
    return frag;
  }
  // Only HTML documents lowercase attribute names; XML documents
  // preserve their case.
  createAttribute(name: string) {
    const nm = String(name == null ? String(name) : name);
    validateAttrName(nm);
    const finalName = this._isHtml ? nm.replace(/[A-Z]/g, (c) => c.toLowerCase()) : nm;
    const attr = Object.create(AttrCls.prototype);
    attr._name = finalName;
    attr._value = "";
    attr._nodeValue = "";
    attr._textContent = "";
    attr._namespaceURI = null;
    attr._prefix = null;
    attr._localName = finalName;
    attr._ownerElement = null;
    return attr;
  }
  // Traversal state is only the root, so the live document's factories work.
  createTreeWalker(root: Idl.Node, whatToShow?: number, filter?: Idl.NodeFilter | null) {
    return liveDocument().createTreeWalker(root, whatToShow, filter);
  }
  createNodeIterator(root: Idl.Node, whatToShow?: number, filter?: Idl.NodeFilter | null) {
    return liveDocument().createNodeIterator(root, whatToShow, filter);
  }
  // Limitation: a CDATA section is a Text node stamped with nodeType 4.
  createCDATASection(data: string): Idl.CDATASection {
    const t = createTextNodeInternal(String(data ?? ""));
    Object.defineProperty(t, "nodeType", { value: 4, enumerable: false });
    Object.defineProperty(t, "nodeName", {
      value: "#cdata-section",
      enumerable: false,
    });
    nodeOwnerDoc.set(t, this);
    return t;
  }
  // Limitation: a PI is a Text node stamped with nodeType 7 and target.
  createProcessingInstruction(target: string, data: string): Idl.ProcessingInstruction {
    validatePIArgs(target, data);
    const t = createTextNodeInternal(processingInstructionData(data));
    Object.defineProperty(t, "nodeType", { value: 7, enumerable: false });
    defineProcessingInstructionNames(t, target, false);
    // Mark id as a PI so Element.textContent skips its data.
    markProcessingInstructionNode(t);
    nodeOwnerDoc.set(t, this);
    return t;
  }
  // Queries scope to this document's tree by running on the host.
  getElementsByTagName(name: string) {
    return this._host.getElementsByTagName(name);
  }
  getElementsByTagNameNS(ns: string | null, localName: string) {
    return this._host.getElementsByTagNameNS(ns, localName);
  }
  getElementsByClassName(name: string) {
    return this._host.getElementsByClassName(name);
  }
  // A subtree query, O(N): blitz's id map covers the whole wasm tree.
  getElementById(id: string) {
    if (typeof id !== "string" || !id) return null;
    try {
      return this._host.querySelector("#" + cssEscape(id));
    } catch {
      return null;
    }
  }
  querySelector(selector: string) {
    return this._host.querySelector(selector);
  }
  querySelectorAll(selector: string) {
    return this._host.querySelectorAll(selector);
  }
  // EventTarget, keyed on the host id. WebIDL requires type and callback.
  addEventListener(
    type: string,
    listener: Idl.EventListener | null,
    options?: Idl.AddEventListenerOptions | boolean,
  ) {
    if (arguments.length < 2) {
      throw new TypeError(
        "Failed to execute 'addEventListener' on 'EventTarget': 2 arguments required, but only " +
          arguments.length +
          " present.",
      );
    }
    addListener(this._hostId, type, listener, options);
  }
  removeEventListener(
    type: string,
    listener: Idl.EventListener | null,
    options?: Idl.EventListenerOptions | boolean,
  ) {
    if (arguments.length < 2) {
      throw new TypeError(
        "Failed to execute 'removeEventListener' on 'EventTarget': 2 arguments required, but only " +
          arguments.length +
          " present.",
      );
    }
    removeListener(this._hostId, type, listener, options);
  }
  dispatchEvent(event: Idl.Event) {
    return dispatchOnKey(() => this._hostId, event);
  }
  // The first <head> under documentElement, or null.
  get head() {
    const root = this.documentElement;
    if (!root) return null;
    try {
      const h = root.querySelector ? root.querySelector("head") : null;
      if (h) return h;
    } catch {}
    return null;
  }
  // The first <body> under documentElement, or null.
  get body() {
    const root = this.documentElement;
    if (!root) return null;
    try {
      const body = root.querySelector ? root.querySelector("body") : null;
      if (body) return body;
    } catch {}
    return null;
  }
  // The first <title>'s text with whitespace collapsed, or "".
  get title() {
    return documentTitleText(this.documentElement);
  }
  set title(v) {
    // No <title>: create one in <head>, or in documentElement without one.
    setDocumentTitle(this.documentElement, v, (tagName) => this.createElement(tagName));
  }
  // The live document is a DocumentImpl, so `document instanceof Document`
  // needs this: anything with nodeType 9 counts.
  static [Symbol.hasInstance](v: unknown): boolean {
    return !!v && (v as { nodeType?: unknown }).nodeType === DOCUMENT_NODE;
  }
  // Limitation: stubs. The parser operations throw and the editing
  // commands report unsupported.
  write(): never {
    throw notSupported("document.write");
  }
  writeln(): never {
    throw notSupported("document.writeln");
  }
  open(): never {
    throw notSupported("document.open");
  }
  close() {
    /* no-op */
  }
  execCommand(_command: string, _showUI?: boolean, _value?: string) {
    return false;
  }
  queryCommandSupported(_command: string) {
    return false;
  }
  queryCommandEnabled(_command: string) {
    return false;
  }
  queryCommandState(_command: string) {
    return false;
  }
  queryCommandValue(_command: string) {
    return "";
  }
  queryCommandIndeterm(_command: string) {
    return false;
  }
  getElementsByName(name: string): Idl.NodeList | [] {
    const t = String(name);
    if (this._host && typeof this._host.querySelectorAll === "function") {
      try {
        return this._host.querySelectorAll('[name="' + t.replace(/"/g, '\\"') + '"]');
      } catch {
        /* fall through */
      }
    }
    return [];
  }
  // A created document never loads.
  get readyState(): Idl.DocumentReadyState {
    return "complete";
  }
  // Defaults for members that mean nothing without a browsing context.
  get referrer(): string {
    return "";
  }
  get pictureInPictureEnabled(): boolean {
    return false;
  }
  get pictureInPictureElement(): null {
    return null;
  }
  get pointerLockElement(): null {
    return null;
  }
  get activeElement(): null {
    return null;
  }
  get currentScript(): null {
    return null;
  }
  get cookie(): string {
    return "";
  }
  set cookie(_v) {}
  get images(): Idl.HTMLCollection {
    return hostCollection(this, "img");
  }
  get links(): Idl.HTMLCollection {
    return hostCollection(this, "a[href], area[href]");
  }
  get forms(): Idl.HTMLCollection {
    return hostCollection(this, "form");
  }
  get scripts(): Idl.HTMLCollection {
    return hostCollection(this, "script");
  }
  get embeds(): Idl.HTMLCollection {
    return hostCollection(this, "embed");
  }
  get applets(): Idl.HTMLCollection {
    return hostCollection(this, null);
  }
  get anchors(): Idl.HTMLCollection {
    return hostCollection(this, "a[name]");
  }
  get all(): Idl.NodeList | [] {
    if (!this._host) return [];
    try {
      return this._host.querySelectorAll("*");
    } catch {
      return [];
    }
  }
  get styleSheets(): Idl.CSSStyleSheet[] {
    return [];
  }
  get adoptedStyleSheets(): Idl.CSSStyleSheet[] {
    return [];
  }
  set adoptedStyleSheets(_v) {}
  getSelection(): null {
    return null;
  }
  hasFocus(): boolean {
    return false;
  }
  exitPictureInPicture(): Promise<void> {
    return Promise.resolve();
  }
  exitPointerLock(): void {}
}
// On* handler IDL attributes for DetachedDocument.prototype are
// installed by index.ts via installIdlHandlersOn (shared installer).

// The members the live document (DocumentImpl) and created documents
// (DetachedDocument) implement the same way. They are defined once here and
// installed on both prototypes, so the two can't drift apart.
type SharedDocumentMember =
  | "compatMode"
  | "designMode"
  | "domain"
  | "fullscreenElement"
  | "fullscreenEnabled"
  | "hidden"
  | "implementation"
  | "plugins"
  | "scrollingElement"
  | "textContent"
  | "visibilityState"
  | "captureEvents"
  | "releaseEvents"
  | "clear"
  | "exitFullscreen"
  | "createAttributeNS"
  | "createExpression"
  | "createNSResolver"
  | "createRange"
  | "evaluate"
  | "lastModified"
  | "fgColor"
  | "linkColor"
  | "vlinkColor"
  | "alinkColor"
  | "bgColor"
  | "dir";
// The shared members idl/type-gaps.json leaves out of Idl.Document.
interface SharedDocumentTypeGaps {
  createEvent(interfaceName: string): KsEvent | KsBeforeUnloadEvent;
}

interface QualifiedAttributeName {
  prefix: string | null;
  localName: string;
}

function splitQualifiedAttributeName(qualifiedName: string): QualifiedAttributeName {
  const colon = qualifiedName.indexOf(":");
  return {
    prefix: colon >= 0 ? qualifiedName.slice(0, colon) : null,
    localName: colon >= 0 ? qualifiedName.slice(colon + 1) : qualifiedName,
  };
}

function assertAttributePrefixNamespace(prefix: string | null, namespace: string | null): void {
  if (prefix && !namespace) {
    throw new DOMException("createAttributeNS: prefix without namespace", "NamespaceError");
  }
}

function assertXmlAttributePrefixNamespace(prefix: string | null, namespace: string | null): void {
  if (prefix === "xml" && namespace !== XML_NS) {
    throw new DOMException(
      "createAttributeNS: xml prefix requires XML namespace",
      "NamespaceError",
    );
  }
}

function assertXmlnsAttributeNamespace(
  qualifiedName: string,
  prefix: string | null,
  namespace: string | null,
): void {
  const isXmlnsNamespace = namespace === XMLNS_NS;
  if ((qualifiedName === "xmlns" || prefix === "xmlns") !== isXmlnsNamespace) {
    throw new DOMException("createAttributeNS: xmlns qname/prefix mismatch", "NamespaceError");
  }
}

function assertValidAttributeNamespaceName(
  qualifiedName: string,
  prefix: string | null,
  namespace: string | null,
): void {
  assertAttributePrefixNamespace(prefix, namespace);
  assertXmlAttributePrefixNamespace(prefix, namespace);
  assertXmlnsAttributeNamespace(qualifiedName, prefix, namespace);
}

function createNamespacedAttribute(
  qualifiedName: string,
  namespace: string | null,
  prefix: string | null,
  localName: string,
) {
  const attribute = Object.create(AttrCls.prototype);
  attribute._name = qualifiedName;
  attribute._value = "";
  attribute._nodeValue = "";
  attribute._textContent = "";
  attribute._namespaceURI = namespace;
  attribute._prefix = prefix;
  attribute._localName = localName;
  attribute._ownerElement = null;
  return attribute;
}

function bodyColor(body: Idl.HTMLElement | null, attribute: string): string {
  return body ? body.getAttribute(attribute) || "" : "";
}
function setBodyColor(body: Idl.HTMLElement | null, attribute: string, value: string | null): void {
  if (body) body.setAttribute(attribute, value === null ? "" : String(value));
}
const sharedDocumentMembers: Pick<Idl.Document, SharedDocumentMember> &
  SharedDocumentTypeGaps &
  ThisType<DocumentImpl | DetachedDocument> = {
  get compatMode() {
    return "CSS1Compat";
  },
  // The response's Last-Modified header isn't kept, so this is the current
  // time, in the spec's format.
  get lastModified() {
    return formatLastModified(new Date());
  },
  // The legacy colors reflect the body's text, link, vlink, alink and
  // bgcolor attributes, with null as "". Without a body they read "" and
  // ignore writes.
  get fgColor() {
    return bodyColor(this.body, "text");
  },
  set fgColor(v: string) {
    setBodyColor(this.body, "text", v);
  },
  get linkColor() {
    return bodyColor(this.body, "link");
  },
  set linkColor(v: string) {
    setBodyColor(this.body, "link", v);
  },
  get vlinkColor() {
    return bodyColor(this.body, "vlink");
  },
  set vlinkColor(v: string) {
    setBodyColor(this.body, "vlink", v);
  },
  get alinkColor() {
    return bodyColor(this.body, "alink");
  },
  set alinkColor(v: string) {
    setBodyColor(this.body, "alink", v);
  },
  get bgColor() {
    return bodyColor(this.body, "bgcolor");
  },
  set bgColor(v: string) {
    setBodyColor(this.body, "bgcolor", v);
  },
  // Editing a whole document is not supported, so designMode stays "off".
  get designMode() {
    return "off";
  },
  set designMode(_v: string) {},
  // The URL's host. github's Turbo cookie helpers throw when this is null.
  // The setter is a deprecated no-op.
  get domain() {
    try {
      const u = this._baseUrl;
      if (!u) return "";
      return new URL(u).hostname;
    } catch {
      return "";
    }
  },
  set domain(_v: string) {},
  // Nothing is ever fullscreen.
  get fullscreenEnabled() {
    return false;
  },
  get fullscreenElement() {
    return null;
  },
  exitFullscreen() {
    return Promise.resolve();
  },
  // There are no background tabs in a session, so the document is visible.
  get hidden() {
    return false;
  },
  get visibilityState(): Idl.DocumentVisibilityState {
    return "visible";
  },
  // One DOMImplementation per document, memoized on first read.
  get implementation() {
    let impl = this._implementation;
    if (!impl) {
      impl = new DOMImplementationCls(this);
      Object.defineProperty(this, "_implementation", {
        value: impl,
        writable: false,
        enumerable: false,
      });
    }
    return impl;
  },
  get plugins() {
    return this.embeds;
  },
  // The root element scrolls the viewport (see Element's scrollTop).
  get scrollingElement() {
    return this.documentElement;
  },
  // A document's textContent is null and setting it does nothing.
  get textContent() {
    return null;
  },
  set textContent(_v: string | null) {},
  // Legacy no-ops.
  clear() {},
  captureEvents() {},
  releaseEvents() {},
  createAttributeNS(namespaceURI: string | null, qualifiedName: string) {
    const ns = namespaceURI ? String(namespaceURI) : null;
    const qn = String(qualifiedName ?? "");
    validateAttrName(qn);
    // The NamespaceError checks setAttributeNS also makes.
    const { prefix, localName } = splitQualifiedAttributeName(qn);
    assertValidAttributeNamespaceName(qn, prefix, ns);
    return createNamespacedAttribute(qn, ns, prefix, localName);
  },
  // XPathEvaluatorBase (DOM §8). Maps' startup reads its preload link
  // through document.evaluate.
  evaluate(
    expression: string,
    contextNode: Idl.Node,
    resolver: Idl.XPathNSResolver | null = null,
    type = 0,
    result: Idl.XPathResult | null = null,
  ) {
    return evaluateXPath(expression, contextNode, resolver, type, result);
  },
  createExpression(expression: string, resolver: Idl.XPathNSResolver | null = null) {
    return createExpression(expression, resolver);
  },
  createNSResolver(nodeResolver: Idl.Node) {
    return nodeResolver;
  },
  // A live Range at (document, 0).
  createRange() {
    return new RangeImpl(this);
  },
  // dir reflects the root element's dir; a non-HTML root has none.
  get dir() {
    const el = this.documentElement;
    return el ? (el as Idl.HTMLElement).dir : "";
  },
  set dir(value: string) {
    const el = this.documentElement;
    if (el) (el as Idl.HTMLElement).dir = value;
  },
  // The legacy event factory: an uninitialized event of the interface the
  // name maps to, matched case-insensitively. An unknown name throws
  // NotSupportedError.
  createEvent(interfaceName: string): KsEvent | KsBeforeUnloadEvent {
    const name = String(interfaceName ?? "").toLowerCase();
    let ev: KsEvent | KsBeforeUnloadEvent;
    switch (name) {
      case "event":
      case "events":
      case "htmlevents":
      case "svgevents":
        ev = new KsEvent("");
        break;
      case "customevent":
        ev = new KsCustomEvent("");
        break;
      case "mouseevent":
      case "mouseevents":
        ev = new KsMouseEvent("");
        break;
      case "keyboardevent":
        ev = new KsKeyboardEvent("");
        break;
      case "uievent":
      case "uievents":
        ev = new KsUIEvent("");
        break;
      case "focusevent":
        ev = new KsFocusEvent("");
        break;
      case "compositionevent":
        ev = new KsCompositionEvent("");
        break;
      // The legacy interface names map to their own subclass, per the
      // spec's createEvent table.
      case "beforeunloadevent":
        ev = new KsBeforeUnloadEvent("");
        break;
      case "devicemotionevent":
        ev = new KsDeviceMotionEvent("");
        break;
      case "deviceorientationevent":
        ev = new KsDeviceOrientationEvent("");
        break;
      case "dragevent":
        ev = new KsDragEvent("");
        break;
      case "hashchangeevent":
        ev = new KsHashChangeEvent("");
        break;
      case "messageevent":
        ev = new KsMessageEvent("");
        break;
      case "storageevent":
        ev = new KsStorageEvent("");
        break;
      case "textevent":
        ev = new KsTextEvent("");
        break;
      case "touchevent":
        ev = new KsTouchEvent("");
        break;
      default:
        throw new DOMException(
          "createEvent('" + interfaceName + "') is not supported",
          "NotSupportedError",
        );
    }
    // Spec: createEvent's result has its initialized flag UNSET;
    // dispatching before initEvent throws InvalidStateError. We
    // approximate by clearing the flag; dispatch checks it.
    const state = eventState(ev);
    state.initialized = false;
    state.dispatched = false;
    return ev;
  },
};
for (const proto of [DocumentImpl.prototype, DetachedDocument.prototype]) {
  Object.defineProperties(proto, Object.getOwnPropertyDescriptors(sharedDocumentMembers));
}

// Keep XMLDocument's interface identity separate from other Document nodes.
class XMLDocument extends DetachedDocument implements Idl.XMLDocument {
  static [Symbol.hasInstance](v: unknown): boolean {
    return (
      v !== null &&
      (typeof v === "object" || typeof v === "function") &&
      XMLDocument.prototype.isPrototypeOf(v)
    );
  }
}

Object.defineProperty(DetachedDocument.prototype, "importNode", {
  value: function importNode(node: unknown, deep?: unknown) {
    return importDetachedNode(node, deep);
  },
  writable: true,
  configurable: true,
  enumerable: true,
});

// The Node constants, also inherited by XMLDocument.
Object.assign(DetachedDocument.prototype, {
  ELEMENT_NODE: 1,
  ATTRIBUTE_NODE: 2,
  TEXT_NODE: 3,
  CDATA_SECTION_NODE: 4,
  ENTITY_REFERENCE_NODE: 5,
  ENTITY_NODE: 6,
  PROCESSING_INSTRUCTION_NODE: 7,
  COMMENT_NODE: 8,
  DOCUMENT_NODE: 9,
  DOCUMENT_TYPE_NODE: 10,
  DOCUMENT_FRAGMENT_NODE: 11,
  NOTATION_NODE: 12,
});

// ---------------------------------------------------------------------
// Exports.
export {
  DocumentImpl,
  DOMImplementationCls,
  DetachedDocument,
  XMLDocument,
  __ks_detachedDocument_location_get,
  __ks_detachedDocument_location_set,
};

// For page-script's HTMLElement constructor: a wrapper with no upgrade.
// `new CustomElementCtor()` already runs the user constructor, and a
// second run throws when V8 re-initializes private fields.
ksGlobal.__ks_createElementNoUpgrade = (tag: string) => {
  try {
    const id = dom.createElement(String(tag).toLowerCase());
    return nodeFor(id);
  } catch {
    return null;
  }
};
