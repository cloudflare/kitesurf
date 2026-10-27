// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Builds parser-owned DOMParser documents and their limited wrapper and mutation surface.

import type { DomHandle } from "../../core/pkg/kitesurf_core";
import { dom, liveDocument, pageUrl, opts } from "./state.js";
import { parsedHandleXml } from "./registries.js";
import {
  ELEMENT_NODE,
  TEXT_NODE,
  COMMENT_NODE,
  DOCUMENT_NODE,
  DOCUMENT_FRAGMENT_NODE,
  HTML_NS,
  notSupported,
} from "./constants.js";
import type * as Idl from "./idl/types.generated.js";
import { ksSpan } from "./otel.js";
import { validateXMLName, validateAndExtract, XML_NS, XMLNS_NS } from "./util/validation.js";
import { camelToDash } from "./util/strings.js";
import { DOMImplementationCls } from "./document.js";
import type { DetachedDocument, DocumentImpl } from "./document.js";
import {
  NodeListCls,
  CSSStyleSheetCtor,
  styleSheetFields,
  selectorHasPseudoElement,
} from "./collections.js";
import { RangeImpl } from "./range.js";
import { adoptIntoDom, parsedAttrs, type NodeBase, type DocumentTypeNode } from "./node-base.js";
import { ALL_EVENT_HANDLERS } from "./event-handler-names.js";
import { createExpression, evaluateXPath } from "./xpath.js";
type XPathResolver = Parameters<typeof evaluateXPath>[2];
type ParsedAttribute = ReturnType<typeof parsedAttrs>[number];
type ParsedNode = NodeBase | ParsedElement | ParsedFragment;
type ParsedOwnerDocument = (DocumentImpl | DetachedDocument | ParsedDocument) & {
  _contentType?: string;
  _mutable?: boolean;
};
type ParsedOwnerDocumentValue = ParsedOwnerDocument | null;

function DomHandleCtor(html: string, baseUrl: string): DomHandle {
  // The wasm instance constructor creates an independent parser handle.
  return new (dom as any).constructor(html, baseUrl);
}

const parsedNodeCache = new WeakMap<object, Map<number, ParsedElement>>();

function getOrCreateParsedNode(
  handle: DomHandle,
  id: number,
  ownerDoc: ParsedOwnerDocumentValue | undefined,
): ParsedElement | null {
  if (id == null || id < 0) return null;
  return parsedNodeFor(handle, id, ownerDoc);
}

function cachedParsedNode(
  inner: Map<number, ParsedElement> | undefined,
  id: number,
  ownerDoc: ParsedOwnerDocumentValue | undefined,
): ParsedElement | null {
  if (!inner) return null;
  const cached = inner.get(id);
  if (!cached) return null;
  return !ownerDoc || cached.ownerDocument === ownerDoc ? cached : null;
}

function parsedNodeFor(
  handle: DomHandle,
  id: number,
  ownerDoc: ParsedOwnerDocumentValue | undefined,
): ParsedElement {
  let inner = parsedNodeCache.get(handle);
  const cached = cachedParsedNode(inner, id, ownerDoc);
  if (cached) return cached;
  const el = new ParsedElement(handle, id, ownerDoc);
  if (!inner) {
    inner = new Map();
    parsedNodeCache.set(handle, inner);
  }
  inner.set(id, el);
  return el;
}

function isParsedObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isParsedNamespaceNode(
  value: unknown,
): value is Record<string, unknown> & { nodeType: number } {
  return isParsedObject(value) && typeof value.nodeType === "number";
}

function hasParsedGetAttribute(
  value: Record<string, unknown>,
): value is Record<string, unknown> & { getAttribute: (name: string) => unknown } {
  return typeof value.getAttribute === "function";
}

type ParsedNamespaceElement = Record<string, unknown> & { nodeType: number };

function isParsedElement(value: unknown): value is ParsedNamespaceElement {
  return isParsedNamespaceNode(value) && value.nodeType === ELEMENT_NODE;
}

function parsedElementRoot(node: unknown): ParsedNamespaceElement | null {
  let element = node;
  while (isParsedNamespaceNode(element) && element.nodeType !== ELEMENT_NODE) {
    element = element.nodeType === DOCUMENT_NODE ? element.documentElement : element.parentNode;
  }
  return isParsedElement(element) ? element : null;
}

function namespaceForPrefix(prefix: string | null): string | null {
  if (prefix === "xml") return XML_NS;
  if (prefix === "xmlns") return XMLNS_NS;
  return null;
}

function parsedElementPrefix(element: ParsedNamespaceElement): unknown {
  return element.prefix === undefined ? null : element.prefix;
}

function parsedElementNamespaceValue(element: ParsedNamespaceElement): string | null {
  return typeof element.namespaceURI === "string" ? element.namespaceURI : null;
}

function parsedDeclarationName(prefix: string | null): string {
  return prefix === null ? "xmlns" : `xmlns:${prefix}`;
}

function isMissingNamespaceDeclaration(value: unknown): boolean {
  return value === null || value === undefined;
}

function matchesParsedNamespace(
  namespace: string | null,
  elementPrefix: unknown,
  prefix: string | null,
): boolean {
  return !!namespace && elementPrefix === prefix;
}

function namespaceForParsedElement(
  element: ParsedNamespaceElement,
  prefix: string | null,
): string | null | undefined {
  const elementPrefix = parsedElementPrefix(element);
  const elementNamespace = parsedElementNamespaceValue(element);
  if (matchesParsedNamespace(elementNamespace, elementPrefix, prefix)) return elementNamespace;

  if (!hasParsedGetAttribute(element)) return undefined;
  const declaration = element.getAttribute(parsedDeclarationName(prefix));
  if (isMissingNamespaceDeclaration(declaration)) return undefined;
  return declaration === "" ? null : String(declaration);
}

function findParsedNamespace(
  element: ParsedNamespaceElement,
  prefix: string | null,
): string | null | undefined {
  let current: ParsedNamespaceElement | null = element;
  while (current) {
    const namespace = namespaceForParsedElement(current, prefix);
    if (namespace !== undefined) return namespace;
    const parent: unknown = current.parentNode;
    current = isParsedElement(parent) ? parent : null;
  }
  return undefined;
}

function lookupParsedNamespaceURI(node: unknown, prefix: unknown): string | null {
  const p = normalizeParsedPrefix(prefix);
  const element = parsedElementRoot(node);
  if (!element) return null;
  const knownNamespace = namespaceForPrefix(p);
  if (knownNamespace) return knownNamespace;
  return findParsedNamespace(element, p) ?? null;
}

function normalizeParsedPrefix(prefix: unknown): string | null {
  if (typeof prefix === "symbol") {
    throw new TypeError("Cannot convert a Symbol value to a string");
  }
  const prefixString = prefix === null || prefix === undefined ? null : String(prefix);
  return prefixString === "" ? null : prefixString;
}

function removeParsedChild(parent: Record<string, unknown>, child: unknown): void {
  const removeChild = parent.removeChild;
  if (typeof removeChild !== "function") {
    throw new TypeError("Parsed node cannot remove text children");
  }
  Reflect.apply(removeChild, parent, [child]);
}

function normalizeParsedText(
  parent: Record<string, unknown>,
  children: unknown[],
  index: number,
  child: Record<string, unknown>,
): number {
  const data = String(child.nodeValue ?? "");
  if (data === "") {
    removeParsedChild(parent, child);
    children[index] = null;
    return index;
  }

  let merged = data;
  let nextIndex = index + 1;
  while (nextIndex < children.length) {
    const nextChild = children[nextIndex];
    if (!isParsedObject(nextChild) || nextChild.nodeType !== TEXT_NODE) break;
    merged += String(nextChild.nodeValue ?? "");
    removeParsedChild(parent, nextChild);
    children[nextIndex] = null;
    nextIndex++;
  }
  if (merged !== data) child.nodeValue = merged;
  return nextIndex - 1;
}

function normalizeParsedSubtree(parent: unknown): void {
  const parents: unknown[] = [parent];
  while (parents.length > 0) {
    const current = parents.pop();
    if (!isParsedObject(current) || !Array.isArray(current.childNodes)) continue;
    const children: unknown[] = [...current.childNodes];
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (!isParsedObject(child)) continue;
      if (child.nodeType === TEXT_NODE) {
        i = normalizeParsedText(current, children, i, child);
      } else if (child.nodeType === ELEMENT_NODE) {
        parents.push(child);
      }
    }
  }
}

function parsedInfo(handle: DomHandle, id: number) {
  try {
    return handle.nodeInfo(id);
  } catch {
    return null;
  }
}

function parsedNodeType(info: ReturnType<DomHandle["nodeInfo"]>): number {
  return info ? info.nodeType : ELEMENT_NODE;
}

function parsedLocalName(info: ReturnType<DomHandle["nodeInfo"]>): string {
  return info ? info.localName || "" : "";
}

function parsedNodeName(info: ReturnType<DomHandle["nodeInfo"]>): string {
  return info ? info.nodeName : "";
}

function parsedOwnerContentType(ownerDoc: ParsedOwnerDocumentValue): string | null {
  return ownerDoc && ownerDoc._contentType ? String(ownerDoc._contentType) : null;
}

function isParsedHtmlDocument(ownerContentType: string | null): boolean {
  return ownerContentType === "text/html" || ownerContentType == null;
}

function parsedXmlNamespace(handle: DomHandle, id: number): string | null {
  try {
    const attrs = parsedAttrs(handle, id);
    for (const attr of attrs) if (attr.name === "xmlns") return attr.value;
  } catch {}
  return null;
}

function parsedElementNamespace(handle: DomHandle, id: number, nodeType: number): string | null {
  if (nodeType !== ELEMENT_NODE) return null;
  return parsedHandleXml.has(handle) ? parsedXmlNamespace(handle, id) : HTML_NS;
}

function parsedCharacterDataInfo(element: ParsedElement) {
  if (element.nodeType !== TEXT_NODE && element.nodeType !== COMMENT_NODE) return null;
  return parsedInfo(element._dom, element._id);
}

function parsedContainsDescendant(element: ParsedElement, other: ParsedElement): boolean {
  let descendants;
  try {
    descendants = Array.from(element._dom.descendantsOf(element._id));
  } catch {
    return false;
  }
  return descendants.indexOf(other._id) >= 0;
}

function parsedSelectorError(
  method: string,
  target: string,
  selector: string,
  error: unknown,
): DOMException {
  return new DOMException(
    "Failed to execute '" +
      method +
      "' on " +
      (target === "Element" ? "'Element'" : target) +
      ": '" +
      selector +
      "' is not a valid selector. " +
      errorMessage(error),
    "SyntaxError",
  );
}

function queryParsedSelector(
  handle: DomHandle,
  rootId: number,
  selector: string,
  method: string,
  target: string,
): number[] {
  try {
    return Array.from<number>(handle.querySelectorAllInSubtree(rootId, selector));
  } catch (error) {
    throw parsedSelectorError(method, target, selector, error);
  }
}

function scopedSelectorString(selector: unknown): string {
  if (typeof selector === "string") return selector;
  try {
    return String(selector);
  } catch {
    throw new DOMException(
      "Failed to execute 'querySelector' on parsed document: selector argument is not a valid string",
      "SyntaxError",
    );
  }
}

interface ParsedAppendParent {
  _dom: DomHandle;
  _id: number;
  ownerDocument: ParsedOwnerDocumentValue;
}

interface ParsedAppendCandidate {
  _dom?: DomHandle;
  _id?: number;
  parentNode?: unknown;
  ownerDocument?: unknown;
}

function assertParsedMutable(ownerDocument: ParsedOwnerDocumentValue, message: string): void {
  if (!ownerDocument || !ownerDocument._mutable) throw notSupported(message);
}

function assertParsedCandidatePresent(candidate: ParsedAppendCandidate): void {
  if (!candidate) throw notSupported("appendChild: null/undefined child");
}

function adoptParsedCandidate(parent: ParsedAppendParent, candidate: ParsedAppendCandidate): void {
  if (candidate._dom && candidate._dom !== parent._dom) {
    adoptIntoDom(parent._dom, candidate, parent.ownerDocument);
  }
}

function validateParsedAppendCandidate(
  candidate: ParsedAppendCandidate,
): asserts candidate is ParsedAppendCandidate & { _id: number } {
  if (typeof candidate._id !== "number" || candidate._id < 0) {
    throw notSupported("appendChild: unsupported child shape");
  }
}

function appendParsedCandidate(
  parent: ParsedAppendParent,
  candidate: ParsedAppendCandidate & { _id: number },
): void {
  try {
    parent._dom.appendChildNode(parent._id, candidate._id);
  } catch {}
  try {
    candidate.parentNode = parent;
  } catch {}
  try {
    candidate.ownerDocument = parent.ownerDocument;
  } catch {}
}

function appendParsedChild<T>(parent: ParsedAppendParent, child: T, readOnlyMessage: string): T {
  assertParsedMutable(parent.ownerDocument, readOnlyMessage);
  const candidate = child as any;
  assertParsedCandidatePresent(candidate);
  adoptParsedCandidate(parent, candidate);
  validateParsedAppendCandidate(candidate);
  appendParsedCandidate(parent, candidate);
  return child;
}

function removeParsedElementChild(handle: DomHandle, child: ParsedAppendCandidate): void {
  if (!child || typeof child._id !== "number") {
    throw notSupported("removeChild: invalid child");
  }
  try {
    handle.removeNode(child._id);
  } catch {}
}

function parsedDeepCloneId(handle: DomHandle, id: number): number {
  let newId = -1;
  try {
    if (typeof handle.deepCloneNode === "function") newId = handle.deepCloneNode(id);
  } catch {}
  return newId;
}

function parsedCloneFallbackId(handle: DomHandle, tagName: string): number {
  try {
    return handle.createElement((tagName || "div").toLowerCase());
  } catch {
    throw notSupported("cloneNode: wasm trap");
  }
}

function cloneParsedElement(element: ParsedElement): ParsedElement | null {
  const handle = element._dom;
  const id = element._id;
  let newId = parsedDeepCloneId(handle, id);
  if (newId < 0) newId = parsedCloneFallbackId(handle, element.tagName);
  return getOrCreateParsedNode(handle, newId, element.ownerDocument);
}

function fragmentChildIds(handle: DomHandle, fragmentId: number): number[] {
  try {
    return Array.from(handle.childIds(fragmentId));
  } catch {
    return [];
  }
}

function parsedNodeList(
  handle: DomHandle,
  ids: number[],
  ownerDoc: ParsedOwnerDocumentValue,
): ReadonlyArray<ParsedElement | null> {
  const nodes = ids.map((id) => getOrCreateParsedNode(handle, id, ownerDoc));
  Object.setPrototypeOf(nodes, NodeListCls.prototype);
  Object.freeze(nodes);
  return nodes;
}

function emptyParsedNodeList(): ReadonlyArray<ParsedElement | null> {
  const empty: Array<ParsedElement | null> = [];
  Object.setPrototypeOf(empty, NodeListCls.prototype);
  Object.freeze(empty);
  return empty;
}

class ParsedElement {
  declare _dom: DomHandle;
  declare _id: number;
  declare __ks_isParsedElement: true;
  declare nodeType: number;
  declare nodeName: string;
  declare tagName: string;
  declare localName: string;
  declare ownerDocument: ParsedOwnerDocumentValue;
  declare namespaceURI: string | null;
  declare prefix: string | null;
  constructor(handle: DomHandle, id: number, ownerDoc?: ParsedOwnerDocumentValue) {
    this._dom = handle;
    this._id = id;
    const info = parsedInfo(handle, id);
    this.nodeType = parsedNodeType(info);
    this.localName = parsedLocalName(info);
    const ownerCt = parsedOwnerContentType(ownerDoc || null);
    const isHtmlDoc = isParsedHtmlDocument(ownerCt);
    if (this.nodeType !== ELEMENT_NODE) {
      this.nodeName = parsedNodeName(info);
      this.tagName = "";
    } else if (isHtmlDoc) {
      this.nodeName = parsedNodeName(info);
      this.tagName = this.nodeName;
    } else {
      this.nodeName = this.localName;
      this.tagName = this.localName;
    }
    this.ownerDocument = ownerDoc || null;
    this.namespaceURI = parsedElementNamespace(handle, id, this.nodeType);
    this.prefix = null;
  }
  get textContent(): string {
    try {
      return this._dom.textContent(this._id);
    } catch {
      return "";
    }
  }
  get innerHTML(): string {
    try {
      return this._dom.innerHTML(this._id);
    } catch {
      return "";
    }
  }
  get outerHTML(): string {
    try {
      return this._dom.outerHTML(this._id);
    } catch {
      return "";
    }
  }
  get nodeValue(): string | null {
    const info = parsedCharacterDataInfo(this);
    return info ? info.nodeValue || "" : null;
  }
  set nodeValue(value) {
    if (this.nodeType !== TEXT_NODE && this.nodeType !== COMMENT_NODE) return;
    if (!this.ownerDocument?._mutable) {
      throw notSupported("CharacterData.nodeValue on DOMParser result (read-only)");
    }
    const text = String(value ?? "");
    const updated =
      this.nodeType === COMMENT_NODE
        ? this._dom.setCommentData(this._id, text)
        : this._dom.setNodeText(this._id, text);
    if (!updated) {
      throw new Error("CharacterData.nodeValue: stale parsed node");
    }
  }
  getAttribute(name: string): string | null {
    if (this.nodeType !== ELEMENT_NODE) return null;
    const attrs = parsedAttrs(this._dom, this._id);
    for (const a of attrs) if (a.name === name) return a.value;
    return null;
  }
  lookupNamespaceURI(prefix: unknown): string | null {
    return lookupParsedNamespaceURI(this, prefix);
  }
  hasAttribute(name: string): boolean {
    return this.getAttribute(name) !== null;
  }
  getAttributeNames(): string[] {
    return parsedAttrs(this._dom, this._id).map((a) => a.name);
  }
  get attributes(): ParsedAttribute[] {
    const list = parsedAttrs(this._dom, this._id);
    Object.defineProperty(list, "getNamedItem", {
      value: (name: string) => list.find((a) => a.name === name) || null,
    });
    return list;
  }
  get id(): string {
    return this.getAttribute("id") || "";
  }
  set id(v) {
    this.setAttribute("id", String(v));
  }
  get className(): string {
    return this.getAttribute("class") || "";
  }
  set className(v) {
    this.setAttribute("class", String(v));
  }
  get dataset(): Record<string, string | undefined> {
    const element = this;
    return new Proxy(Object.create(null), {
      get(_target, property) {
        if (typeof property !== "string") return undefined;
        return element.getAttribute("data-" + camelToDash(property)) ?? undefined;
      },
      has(_target, property) {
        return (
          typeof property === "string" && element.hasAttribute("data-" + camelToDash(property))
        );
      },
    });
  }
  get classList(): string[] & { contains(token: string): boolean } {
    const cls = this.className;
    const tokens = cls.split(/\s+/).filter(Boolean);
    // The snapshot is an array with one extra method, not a live DOMTokenList.
    const out = tokens.slice() as string[] & { contains(token: string): boolean };
    out.contains = (t: string) => tokens.indexOf(t) >= 0;
    out.length = tokens.length;
    return out;
  }
  get children(): Array<ParsedElement | null> {
    const ids = this._childIds();
    const out: (ParsedElement | null)[] = [];
    for (const id of ids) {
      let info;
      try {
        info = this._dom.nodeInfo(id);
      } catch {
        continue;
      }
      if (info && info.nodeType === ELEMENT_NODE)
        out.push(getOrCreateParsedNode(this._dom, id, this.ownerDocument));
    }
    return out;
  }
  hasChildNodes(): boolean {
    return this._childIds().length > 0;
  }
  get childNodes(): Array<ParsedElement | null> {
    return this._childIds().map((id) => getOrCreateParsedNode(this._dom, id, this.ownerDocument));
  }
  normalize(): void {
    normalizeParsedSubtree(this);
  }
  get firstChild(): ParsedElement | null {
    const ids = this._childIds();
    return ids.length > 0 ? getOrCreateParsedNode(this._dom, ids[0], this.ownerDocument) : null;
  }
  get lastChild(): ParsedElement | null {
    const ids = this._childIds();
    return ids.length > 0
      ? getOrCreateParsedNode(this._dom, ids[ids.length - 1], this.ownerDocument)
      : null;
  }
  get firstElementChild(): ParsedElement | null {
    const kids = this.children;
    return kids.length > 0 ? kids[0] : null;
  }
  get lastElementChild(): ParsedElement | null {
    const kids = this.children;
    return kids.length > 0 ? kids[kids.length - 1] : null;
  }
  get parentNode(): ParsedOwnerDocumentValue | ParsedElement | null {
    let parentId: number | null;
    try {
      const id = this._dom.parentId(this._id);
      parentId = id < 0 ? null : id;
    } catch {
      return null;
    }
    if (parentId === null) return null;
    const info = parsedInfo(this._dom, parentId);
    if (!info) return null;
    if (info.nodeType === DOCUMENT_NODE) return this.ownerDocument || null;
    return getOrCreateParsedNode(this._dom, parentId, this.ownerDocument);
  }
  get parentElement(): ParsedOwnerDocumentValue | ParsedElement {
    const p = this.parentNode;
    return p && p.nodeType === ELEMENT_NODE ? p : null;
  }
  get nextSibling(): ParsedElement | null {
    return this._sibling(1);
  }
  get previousSibling(): ParsedElement | null {
    return this._sibling(-1);
  }
  _childIds(): number[] {
    try {
      return Array.from<number>(this._dom.childIds(this._id));
    } catch {
      return [];
    }
  }
  _sibling(offset: number): ParsedElement | null {
    const parentId: number = this._dom.parentId(this._id);
    if (parentId < 0) return null;
    const siblings = Array.from<number>(this._dom.childIds(parentId));
    const index = siblings.indexOf(this._id);
    const siblingId = index < 0 ? undefined : siblings[index + offset];
    return siblingId === undefined
      ? null
      : getOrCreateParsedNode(this._dom, siblingId, this.ownerDocument);
  }
  querySelector(selector: unknown): ParsedElement | null {
    if (arguments.length === 0) {
      throw new TypeError("querySelector: 1 argument required");
    }
    const ids = this._scopedQS(selector);
    return ids.length > 0 ? getOrCreateParsedNode(this._dom, ids[0], this.ownerDocument) : null;
  }
  querySelectorAll(selector: unknown): ReadonlyArray<ParsedElement | null> {
    if (arguments.length === 0) {
      throw new TypeError("querySelectorAll: 1 argument required");
    }
    const arr = this._scopedQS(selector).map((id) =>
      getOrCreateParsedNode(this._dom, id, this.ownerDocument),
    );
    Object.setPrototypeOf(arr, NodeListCls.prototype);
    Object.freeze(arr);
    return arr;
  }
  getElementsByTagName(name: unknown): ReadonlyArray<ParsedElement | null> {
    return this.querySelectorAll(name);
  }
  getElementsByClassName(name: unknown): ReadonlyArray<ParsedElement | null> {
    return this.querySelectorAll("." + String(name).replace(/[^a-zA-Z0-9_-]/g, "\\$&"));
  }
  matches(selector: string): boolean {
    if (arguments.length === 0) {
      throw new TypeError("matches: 1 argument required");
    }
    const pid = this._dom.parentId(this._id);
    const rootId = pid >= 0 ? pid : this._id;
    const ids = queryParsedSelector(this._dom, rootId, selector, "matches", "Element");
    return ids.indexOf(this._id) >= 0;
  }
  webkitMatchesSelector(selector: string): boolean {
    return this.matches(selector);
  }
  contains(other: unknown): boolean {
    if (!other || !(other instanceof ParsedElement)) return false;
    if (other._dom !== this._dom) return false;
    if (other._id === this._id) return true;
    return parsedContainsDescendant(this, other);
  }
  _scopedQS(selector: unknown): number[] {
    const normalizedSelector = scopedSelectorString(selector);
    if (selectorHasPseudoElement(normalizedSelector)) return [];
    return queryParsedSelector(
      this._dom,
      this._id,
      normalizedSelector,
      "querySelector",
      "parsed document",
    );
  }
  // Page-owned wrappers use dynamic slots across live and parser-owned handles.
  appendChild<T>(child: T): T {
    return appendParsedChild(this, child, "appendChild on DOMParser result (read-only)");
  }
  // Page-owned wrappers may carry dynamic handle metadata.
  removeChild<T>(child: T): T {
    assertParsedMutable(this.ownerDocument, "removeChild on DOMParser result (read-only)");
    const candidate = child as any;
    removeParsedElementChild(this._dom, candidate);
    return child;
  }
  // Node wrappers stay dynamic; a non-null reference remains unsupported.
  insertBefore<T>(newChild: T, refChild: unknown): T {
    if (!this.ownerDocument || !this.ownerDocument._mutable) {
      throw notSupported("insertBefore on DOMParser result (read-only)");
    }
    if (refChild == null) return this.appendChild(newChild);
    throw notSupported(
      "insertBefore with non-null refChild on iframe doc " +
        "(Phase-iframes-2 limitation; appendChild-equivalent only)",
    );
  }
  replaceChild(): never {
    throw notSupported("replaceChild on DOMParser result (read-only)");
  }
  setAttribute(name: unknown, value: unknown): void {
    if (!this.ownerDocument || !this.ownerDocument._mutable) {
      throw notSupported("setAttribute on DOMParser result (read-only)");
    }
    try {
      this._dom.setAttribute(this._id, String(name), String(value));
    } catch {}
  }
  setAttributeNS(_namespaceURI: unknown, qualifiedName: unknown, value: unknown): void {
    if (!this.ownerDocument || !this.ownerDocument._mutable) {
      throw notSupported("setAttributeNS on DOMParser result (read-only)");
    }
    const name = String(qualifiedName);
    try {
      this._dom.setAttribute(this._id, name, String(value));
    } catch {}
  }
  getAttributeNS(_namespaceURI: unknown, localName: unknown): string | null {
    return this.getAttribute(String(localName));
  }
  hasAttributeNS(_namespaceURI: unknown, localName: unknown): boolean {
    return this.hasAttribute(String(localName));
  }
  removeAttributeNS(_namespaceURI: unknown, localName: unknown): void {
    this.removeAttribute(String(localName));
  }
  cloneNode(_deep?: unknown): ParsedElement | null {
    return cloneParsedElement(this);
  }
  removeAttribute(name: unknown): void {
    if (!this.ownerDocument || !this.ownerDocument._mutable) {
      throw notSupported("removeAttribute on DOMParser result (read-only)");
    }
    try {
      const fn = this._dom.removeAttribute;
      if (typeof fn === "function") fn.call(this._dom, this._id, String(name));
    } catch {}
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean {
    return false;
  }
}
class ParsedFragment {
  declare _dom: DomHandle;
  declare _id: number;
  declare nodeType: number;
  declare nodeName: string;
  declare ownerDocument: ParsedOwnerDocumentValue;
  declare parentNode: ParsedNode | ParsedOwnerDocumentValue;
  constructor(handle: DomHandle, id: number, ownerDoc: ParsedOwnerDocumentValue) {
    this._dom = handle;
    this._id = id;
    this.nodeType = DOCUMENT_FRAGMENT_NODE;
    this.nodeName = "#document-fragment";
    this.ownerDocument = ownerDoc || null;
    this.parentNode = null;
  }
  lookupNamespaceURI(prefix: unknown): string | null {
    return lookupParsedNamespaceURI(this, prefix);
  }
  get childNodes(): Array<ParsedElement | null> {
    let kids;
    try {
      kids = Array.from<number>(this._dom.childIds(this._id));
    } catch {
      return [];
    }
    return kids.map((cid) => getOrCreateParsedNode(this._dom, cid, this.ownerDocument));
  }
  get children(): Array<ParsedElement | null> {
    const handle = this._dom;
    const ids = fragmentChildIds(this._dom, this._id);
    const ownerDoc = this.ownerDocument;
    const out: Array<ParsedElement | null> = [];
    for (const id of ids) {
      let info;
      try {
        info = handle.nodeInfo(id);
      } catch {
        continue;
      }
      if (info && info.nodeType === ELEMENT_NODE) {
        out.push(getOrCreateParsedNode(handle, id, ownerDoc));
      }
    }
    return out;
  }
  get firstChild(): ParsedElement | null {
    const k = this.childNodes;
    return k.length > 0 ? k[0] : null;
  }
  get lastChild(): ParsedElement | null {
    const k = this.childNodes;
    return k.length > 0 ? k[k.length - 1] : null;
  }
  normalize(): void {
    normalizeParsedSubtree(this);
  }
  // Page-owned wrappers use dynamic slots across live and parser-owned handles.
  appendChild<T>(child: T): T {
    return appendParsedChild(this, child, "appendChild on read-only fragment");
  }
  removeChild<T>(child: T): T {
    if (!this.ownerDocument || !this.ownerDocument._mutable) {
      throw notSupported("removeChild on read-only fragment");
    }
    if (!isParsedObject(child) || child._dom !== this._dom || typeof child._id !== "number") {
      throw notSupported("removeChild: unsupported fragment child");
    }
    if (this._dom.parentId(child._id) !== this._id || !this._dom.removeNode(child._id)) {
      throw new DOMException("removeChild: child is not a child of parent", "NotFoundError");
    }
    return child;
  }
  querySelector(selector: unknown): ParsedElement | null {
    if (arguments.length === 0) {
      throw new TypeError("querySelector: 1 argument required");
    }
    const sel = String(selector);
    if (selectorHasPseudoElement(sel)) return null;
    const ids = queryParsedSelector(this._dom, this._id, sel, "querySelector", "DocumentFragment");
    return ids.length > 0 ? getOrCreateParsedNode(this._dom, ids[0], this.ownerDocument) : null;
  }
  querySelectorAll(selector: unknown): ReadonlyArray<ParsedElement | null> {
    if (arguments.length === 0) {
      throw new TypeError("querySelectorAll: 1 argument required");
    }
    const sel = String(selector);
    if (selectorHasPseudoElement(sel)) {
      return emptyParsedNodeList();
    }
    const ids = queryParsedSelector(
      this._dom,
      this._id,
      sel,
      "querySelectorAll",
      "DocumentFragment",
    );
    return parsedNodeList(this._dom, ids, this.ownerDocument);
  }
  getElementById(id: unknown): ParsedElement | null {
    const ids = this.querySelectorAll("#" + String(id).replace(/[^a-zA-Z0-9_-]/g, "\\$&"));
    return ids.length > 0 ? ids[0] : null;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean {
    return false;
  }
}
Object.assign(ParsedFragment.prototype, {
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

Object.assign(ParsedElement.prototype, {
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

// Parsed documents own separate wasm handles; release them when the document becomes unreachable.
const domHandleFinalizer =
  typeof FinalizationRegistry !== "undefined"
    ? new FinalizationRegistry((heldHandle: DomHandle) => {
        try {
          heldHandle.free();
        } catch {}
      })
    : null;

interface DoctypeInfo {
  name: string;
  publicId: string;
  systemId: string;
}

// The source's leading `<!DOCTYPE name [PUBLIC "p" ["s"] | SYSTEM "s"]>`,
// or null when it has none. Approximates the tokenizer's doctype state:
// enough to answer document.doctype, not to validate it.
function quotedDoctypeId(source: string): RegExpExecArray | null {
  return /^\s*("([^"]*)"|'([^']*)')/.exec(source);
}

function doctypeIdValue(match: RegExpExecArray): string {
  return match[2] ?? match[3] ?? "";
}

function isPublicDoctypeKeyword(keyword: RegExpExecArray): boolean {
  return (keyword[1] ?? "").toLowerCase() === "public";
}

function isElementNodeInfo(info: ReturnType<DomHandle["nodeInfo"]>): boolean {
  return !!info && info.nodeType === ELEMENT_NODE;
}

function doctypeIdentifiers(rest: string): Pick<DoctypeInfo, "publicId" | "systemId"> {
  let publicId = "";
  let systemId = "";
  const kw = /^\s*(public|system)/i.exec(rest);
  if (!kw) return { publicId, systemId };
  const afterKeyword = rest.slice(kw[0].length);
  const first = quotedDoctypeId(afterKeyword);
  if (!first) return { publicId, systemId };
  const value = doctypeIdValue(first);
  const afterFirst = afterKeyword.slice(first[0].length);
  if (!isPublicDoctypeKeyword(kw)) {
    return { publicId, systemId: value };
  }
  publicId = value;
  const second = quotedDoctypeId(afterFirst);
  systemId = second ? doctypeIdValue(second) : "";
  return { publicId, systemId };
}

function leadingDoctype(source: string, html: boolean): DoctypeInfo | null {
  const match = /^<!doctype(?:\s+([^\s>]+))?([^>]*)>/i.exec(source);
  if (!match) return null;
  const name = match[1] ?? "";
  return {
    name: html ? name.toLowerCase() : name,
    ...doctypeIdentifiers(match[2] ?? ""),
  };
}

function parsedDocumentQuerySelector(handle: DomHandle, selector: string): number {
  try {
    return handle.querySelector(selector);
  } catch (error) {
    throw parsedSelectorError("querySelector", "Document", selector, error);
  }
}

function parsedDocumentQuerySelectorAll(handle: DomHandle, selector: string): number[] {
  try {
    return Array.from(handle.querySelectorAll(selector));
  } catch (error) {
    throw parsedSelectorError("querySelectorAll", "Document", selector, error);
  }
}

// XML qualified-name matcher: browser-permissive, NOT strict XML 1.0
// 5e. Rejects digits / "-" / "." / "<" / ">" / control as NameStart,
// rejects ">" anywhere; accepts any non-ASCII ≥ \u00C0 (broader than
// the spec, matches Chrome/Firefox).

class ParsedDocument {
  declare _dom: DomHandle;
  declare _baseUrl: string;
  declare _contentType: string;
  declare _characterSet: string;
  declare _compatMode: string;
  declare _referrer: string | undefined;
  declare _doctypeInfo: DoctypeInfo | null | undefined;
  declare _doctypeNode: DocumentTypeNode | undefined;
  declare _implementation: DOMImplementationCls | undefined;
  declare _mutable: boolean;
  declare _isXml: boolean;
  declare _id: number;
  declare nodeType: number;
  declare nodeName: string;
  declare ownerDocument: null;
  declare defaultView: null;
  declare parentNode: null;
  declare parentElement: null;
  constructor(handle: DomHandle, baseUrl: string, contentType?: string, compatMode?: string) {
    this._dom = handle;
    this._baseUrl = baseUrl;
    this._contentType = contentType || "text/html";
    this._characterSet = "UTF-8";
    this._compatMode = compatMode || "CSS1Compat";
    this._mutable = true;
    this._isXml = !!(contentType && contentType !== "text/html");
    this.nodeType = DOCUMENT_NODE;
    this.nodeName = "#document";
    this.ownerDocument = null;
    this.defaultView = null;
    this.parentNode = null;
    this.parentElement = null;
    if (domHandleFinalizer) {
      domHandleFinalizer.register(this, handle);
    }
  }
  get URL(): string {
    return this._baseUrl;
  }
  get documentURI(): string {
    return this._baseUrl;
  }
  get baseURI(): string {
    return this._baseUrl;
  }
  get contentType(): string {
    return this._contentType;
  }
  get compatMode(): string {
    return this._compatMode;
  }
  get location(): null {
    return null;
  }
  get characterSet(): string {
    return this._characterSet;
  }
  get charset(): string {
    return this._characterSet;
  }
  get inputEncoding(): string {
    return this._characterSet;
  }
  get readyState(): "complete" {
    return "complete";
  }
  evaluate(
    expression: unknown,
    contextNode: unknown,
    resolver: XPathResolver = null,
    type = 0,
    result: unknown = null,
  ): ReturnType<typeof evaluateXPath> {
    return evaluateXPath(expression, contextNode, resolver, type, result);
  }
  createExpression(
    expression: unknown,
    resolver: XPathResolver = null,
  ): ReturnType<typeof createExpression> {
    return createExpression(expression, resolver);
  }
  createNSResolver(nodeResolver: unknown): unknown {
    return nodeResolver;
  }
  // "" for a DOMParser document, which no request produced. The
  // page-script iframe installers stamp `_referrer` on frame documents.
  get referrer(): string {
    return this._referrer ?? "";
  }
  // Blitz drops the doctype node during parse, so it is rebuilt from the
  // source's leading `<!DOCTYPE>` and is absent from childNodes.
  get doctype(): DocumentTypeNode | null {
    const info = this._doctypeInfo;
    if (!info) return null;
    if (!this._doctypeNode) {
      this._doctypeNode = this.implementation.createDocumentType(
        info.name,
        info.publicId,
        info.systemId,
      );
    }
    return this._doctypeNode;
  }
  // Parsed sheets are a snapshot of inline text; later edits are not reflected.
  get styleSheets(): Array<InstanceType<typeof CSSStyleSheetCtor>> {
    const list: Array<InstanceType<typeof CSSStyleSheetCtor>> = [];
    try {
      const ids = Array.from<number>(
        typeof this._dom.querySelectorAllInSubtree === "function"
          ? this._dom.querySelectorAllInSubtree(
              this._dom.documentNodeId(),
              "style, link[rel='stylesheet']",
            )
          : this._dom.querySelectorAll("style, link[rel='stylesheet']"),
      );
      for (const id of ids) {
        const sheet = new CSSStyleSheetCtor();
        // Read the <style> text content and parse it into rules.
        let text = "";
        try {
          text = this._dom.textContent(id) || "";
        } catch {}
        if (text) sheet.replaceSync(text);
        try {
          styleSheetFields(sheet).ownerNode = getOrCreateParsedNode(this._dom, id, this);
        } catch {}
        list.push(sheet);
      }
    } catch {}
    Object.defineProperty(list, "item", {
      value: (i: number): InstanceType<typeof CSSStyleSheetCtor> | null => list[i] || null,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    return list;
  }
  get title(): string {
    try {
      return this._dom.title();
    } catch {
      return "";
    }
  }
  get documentElement(): ParsedElement | null {
    const handle = this._dom;
    const rootId = handle.documentNodeId();
    let children: number[];
    try {
      children = Array.from(handle.childIds(rootId));
    } catch {
      return null;
    }
    for (const id of children) {
      let info;
      try {
        info = handle.nodeInfo(id);
      } catch {
        continue;
      }
      if (isElementNodeInfo(info)) return getOrCreateParsedNode(handle, id, this);
    }
    return null;
  }
  lookupNamespaceURI(prefix: unknown): string | null {
    const root = this.documentElement;
    return root ? root.lookupNamespaceURI(prefix) : null;
  }
  get body(): ParsedElement | null {
    let ids;
    try {
      ids = Array.from<number>(this._dom.querySelectorAll("body"));
    } catch {
      return null;
    }
    return ids.length > 0 ? getOrCreateParsedNode(this._dom, ids[0], this) : null;
  }
  get head(): ParsedElement | null {
    let ids;
    try {
      ids = Array.from<number>(this._dom.querySelectorAll("head"));
    } catch {
      return null;
    }
    return ids.length > 0 ? getOrCreateParsedNode(this._dom, ids[0], this) : null;
  }
  get children(): ParsedElement[] {
    const docEl = this.documentElement;
    return docEl ? [docEl] : [];
  }
  normalize(): void {
    normalizeParsedSubtree(this);
  }
  get childNodes(): Array<ParsedElement | null> {
    const ids = Array.from<number>(this._dom.childIds(this._dom.documentNodeId()));
    return ids.map((id) => getOrCreateParsedNode(this._dom, id, this));
  }
  get firstChild(): ParsedElement | null {
    return this.childNodes[0] ?? null;
  }
  get firstElementChild(): ParsedElement | null {
    return this.documentElement;
  }
  querySelector(selector: unknown): ParsedElement | null {
    if (arguments.length === 0) {
      throw new TypeError("querySelector: 1 argument required");
    }
    const sel = String(selector);
    if (selectorHasPseudoElement(sel)) return null;
    const id = parsedDocumentQuerySelector(this._dom, sel);
    return id >= 0 ? getOrCreateParsedNode(this._dom, id, this) : null;
  }
  querySelectorAll(selector: unknown): ReadonlyArray<ParsedElement | null> {
    if (arguments.length === 0) {
      throw new TypeError("querySelectorAll: 1 argument required");
    }
    const sel = String(selector);
    if (selectorHasPseudoElement(sel)) {
      return emptyParsedNodeList();
    }
    const ids = parsedDocumentQuerySelectorAll(this._dom, sel);
    return parsedNodeList(this._dom, ids, this);
  }
  getElementById(id: unknown): ParsedElement | null {
    if (typeof id !== "string" || id === "") return null;
    const escaped = id.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
    return this.querySelector("#" + escaped);
  }
  getElementsByTagName(name: unknown): ReadonlyArray<ParsedElement | null> {
    return this.querySelectorAll(name);
  }
  getElementsByClassName(name: unknown): ReadonlyArray<ParsedElement | null> {
    if (typeof name !== "string" || name === "") return [];
    const escaped = name.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
    return this.querySelectorAll("." + escaped);
  }
  createElement(tagName: unknown): ParsedElement {
    if (!this._mutable) {
      throw notSupported("Document.createElement on DOMParser result");
    }
    const ct = this._contentType;
    const isHtmlDoc = ct === "text/html";
    const ns = isHtmlDoc || ct === "application/xhtml+xml" ? HTML_NS : null;
    const tag = String(tagName);
    validateXMLName(isHtmlDoc ? tag.toLowerCase() : tag);
    let id;
    try {
      if (!isHtmlDoc && typeof this._dom.createElementVerbatim === "function") {
        id = this._dom.createElementVerbatim(tag, ns || "");
      } else {
        id = this._dom.createElement(tag);
      }
    } catch (e) {
      throw new Error("createElement: wasm trap: " + (e instanceof Error ? e.message : String(e)));
    }
    const el = parsedNodeFor(this._dom, id, this);
    el.ownerDocument = this;
    el.namespaceURI = ns;
    return el;
  }
  createElementNS(namespaceURI: unknown, qualifiedName: unknown): ParsedElement {
    if (!this._mutable) {
      throw notSupported("Document.createElementNS on DOMParser result");
    }
    const ns = namespaceURI == null || namespaceURI === "" ? null : String(namespaceURI);
    const qn = qualifiedName == null ? String(qualifiedName) : String(qualifiedName);
    const [, prefix] = validateAndExtract(ns, qn);
    let id;
    try {
      id =
        typeof this._dom.createElementNS === "function"
          ? this._dom.createElementNS(ns || "", qn)
          : this._dom.createElement(qn.split(":").pop() || qn);
    } catch (e) {
      throw new Error(
        "createElementNS: wasm trap: " + (e instanceof Error ? e.message : String(e)),
      );
    }
    const el = parsedNodeFor(this._dom, id, this);
    el.namespaceURI = ns;
    el.prefix = prefix;
    return el;
  }
  createTextNode(text: unknown): ParsedElement {
    if (!this._mutable) {
      throw notSupported("Document.createTextNode on DOMParser result");
    }
    let id;
    try {
      id = this._dom.createTextNode(String(text));
    } catch (e) {
      throw new Error("createTextNode: wasm trap: " + (e instanceof Error ? e.message : String(e)));
    }
    const el = parsedNodeFor(this._dom, id, this);
    el.ownerDocument = this;
    return el;
  }
  createDocumentFragment(): ParsedFragment {
    if (!this._mutable) {
      throw notSupported("Document.createDocumentFragment on DOMParser result");
    }
    let id;
    try {
      id = this._dom.createElement("kitesurf-fragment");
    } catch (e) {
      throw new Error(
        "createDocumentFragment: wasm trap: " + (e instanceof Error ? e.message : String(e)),
      );
    }
    return new ParsedFragment(this._dom, id, this);
  }
  createRange(): RangeImpl {
    return new RangeImpl(this);
  }
  createTreeWalker(
    root: Idl.Node,
    whatToShow?: number,
    filter?: Idl.NodeFilter | null,
  ): Idl.TreeWalker {
    return liveDocument().createTreeWalker(root, whatToShow, filter);
  }
  createNodeIterator(
    root: Idl.Node,
    whatToShow?: number,
    filter?: Idl.NodeFilter | null,
  ): Idl.NodeIterator {
    return liveDocument().createNodeIterator(root, whatToShow, filter);
  }
  createCDATASection(data: unknown): ParsedElement {
    if (!this._mutable) {
      throw notSupported("Document.createCDATASection on DOMParser result");
    }
    const t = this.createTextNode(String(data ?? ""));
    try {
      Object.defineProperty(t, "nodeType", { value: 4, configurable: true });
    } catch {}
    return t;
  }
  get implementation(): DOMImplementationCls {
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
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean {
    return false;
  }
}

const parsedDocHandlerSlots = new WeakMap<object, Map<string, Function | null>>();
for (const propName of ALL_EVENT_HANDLERS) {
  const getter = function (this: object) {
    return parsedDocHandlerSlots.get(this)?.get(propName) ?? null;
  };
  const setter = function (this: object, v: unknown) {
    let slots = parsedDocHandlerSlots.get(this);
    if (!slots) {
      slots = new Map();
      parsedDocHandlerSlots.set(this, slots);
    }
    slots.set(propName, typeof v === "function" ? v : null);
  };
  Object.defineProperty(getter, "name", {
    value: "get " + propName,
    writable: false,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(setter, "name", {
    value: "set " + propName,
    writable: false,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(ParsedDocument.prototype, propName, {
    configurable: true,
    enumerable: true,
    get: getter,
    set: setter,
  });
}

Object.assign(ParsedDocument.prototype, {
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

function makeParseErrorDocument(message: string, baseUrl: string): ParsedDocument {
  const errorHtml =
    '<html><body><parsererror style="color:red">' +
    String(message).replace(/[<>&]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;")) +
    "</parsererror></body></html>";
  const handle = DomHandleCtor(errorHtml, baseUrl);
  return new ParsedDocument(handle, baseUrl);
}

const XML_MIME_TYPES = new Set([
  "text/xml",
  "application/xml",
  "application/xhtml+xml",
  "image/svg+xml",
]);

const errorMessage = (err: unknown): string =>
  err && (err as Error).message ? (err as Error).message : String(err);

function parsedDocumentMime(type: unknown): string {
  return (typeof type === "string" ? type : "text/html").toLowerCase().split(";")[0].trim();
}

function parsedDocumentBaseUrl(): string {
  return opts && typeof opts.getCurrentUrl === "function" ? opts.getCurrentUrl() : pageUrl;
}

function canonicalizeHtmlParserInput(input: string): string {
  let html = input;
  if (input.startsWith("<?")) {
    const end = input.indexOf(">");
    const data = input.slice(1, end < 0 ? undefined : end);
    html = `<!--${data}-->${end < 0 ? "" : input.slice(end + 1)}`;
  }
  return html;
}

function parseHtmlDocument(input: string, baseUrl: string): ParsedDocument {
  let handle: DomHandle;
  try {
    // In HTML, a leading `<?` is a bogus comment token, not an XML PI.
    // Canonicalize it because the parser backend drops the document tree.
    handle = DomHandleCtor(canonicalizeHtmlParserInput(input), baseUrl);
  } catch (error) {
    return makeParseErrorDocument("DOMParser: HTML parse failed: " + errorMessage(error), baseUrl);
  }
  // Only an exact `<!DOCTYPE html>` gives no-quirks mode. This regex
  // approximates the parser's doctype rules.
  const trimmed = input.replace(/^\uFEFF/, "").trim();
  const compat = /^<!doctype\s+html\s*>/i.test(trimmed) ? "CSS1Compat" : "BackCompat";
  const document = new ParsedDocument(handle, baseUrl, "text/html", compat);
  document._doctypeInfo = leadingDoctype(trimmed, true);
  return document;
}

function parseXmlDocument(input: string, mime: string, baseUrl: string): ParsedDocument {
  try {
    // There is no XML parser, so XML, XHTML and SVG go through the
    // forgiving HTML parser. The handle is tagged so its elements default
    // to the null namespace. XML documents are always no-quirks.
    const handle = DomHandleCtor(input, baseUrl);
    parsedHandleXml.add(handle);
    const document = new ParsedDocument(handle, baseUrl, mime, "CSS1Compat");
    document._doctypeInfo = leadingDoctype(
      input
        .replace(/^\uFEFF/, "")
        .replace(/^\s*<\?xml[^>]*\?>/, "")
        .trim(),
      false,
    );
    return document;
  } catch (error) {
    return makeParseErrorDocument(
      "DOMParser: XML/SVG via HTML-parser fallback failed: " + errorMessage(error),
      baseUrl,
    );
  }
}

function parseDocument(input: string, type: unknown): ParsedDocument {
  const mime = parsedDocumentMime(type);
  const baseUrl = parsedDocumentBaseUrl();
  if (mime === "text/html") return parseHtmlDocument(input, baseUrl);
  if (XML_MIME_TYPES.has(mime)) return parseXmlDocument(input, mime, baseUrl);
  throw new TypeError(
    "Failed to execute 'parseFromString' on 'DOMParser': The provided value '" +
      mime +
      "' is not a valid enum value of type SupportedType.",
  );
}

class DOMParser implements Idl.DOMParser {
  /**
   * Parses to a separate document; unsupported string MIME types throw `TypeError`.
   * XML MIME types use the forgiving HTML parser, so malformed XML yields no parser error.
   */
  parseFromString(str: unknown, type: unknown): ParsedDocument {
    const input = typeof str === "string" ? str : String(str ?? "");
    return ksSpan("dom.parseFromString", { html_bytes: input.length }, () =>
      parseDocument(input, type),
    );
  }
}

Object.assign(ParsedElement.prototype, { __ks_isParsedElement: true });

export {
  DOMParser,
  ParsedElement,
  ParsedFragment,
  ParsedDocument,
  parsedNodeCache,
  getOrCreateParsedNode,
  makeParseErrorDocument,
};
