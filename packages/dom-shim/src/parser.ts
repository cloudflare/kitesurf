// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Builds parser-owned DOMParser documents and their limited wrapper and mutation surface.

import type { DomHandle } from "../../core/pkg/kitesurf_core";
import { dom, liveDocument, pageUrl, opts } from "./state.js";
import {
  parsedHandle,
  parsedHandleXml,
  registerFinalizationHeld,
  registerParsedHandle,
  weakMapLookup,
  weakMapStore,
  weakSetContains,
  weakSetInsert,
} from "./registries.js";
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
import {
  adoptIntoDom,
  parsedAttrs,
  type AdoptableNode,
  type NodeBase,
  type DocumentTypeNode,
} from "./node-base.js";
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
  return new (dom.constructor as typeof DomHandle)(html, baseUrl);
}

const parsedNodeCache = new WeakMap<object, Map<number, ParsedElement>>();

// The handle of a wrapper this module created, read from the private registry
// rather than from the page-visible object.
function requireParsedHandle(node: object): DomHandle {
  const handle = parsedHandle(node);
  if (!handle) throw new TypeError("Illegal invocation: not a parser-owned wrapper");
  return handle;
}

function getOrCreateParsedNode(
  handle: DomHandle,
  id: number,
  ownerDoc: ParsedOwnerDocumentValue | undefined,
): ParsedElement | null {
  if (id == null || id < 0) return null;
  return parsedNodeFor(handle, id, ownerDoc);
}

function parsedNodeFor(
  handle: DomHandle,
  id: number,
  ownerDoc: ParsedOwnerDocumentValue | undefined,
): ParsedElement {
  let inner = weakMapLookup(parsedNodeCache, handle);
  if (inner) {
    const cached = inner.get(id);
    if (cached) {
      if (!ownerDoc || cached.ownerDocument === ownerDoc) {
        return cached;
      }
    }
  }
  const el = new ParsedElement(handle, id, ownerDoc);
  if (!inner) {
    inner = new Map();
    weakMapStore(parsedNodeCache, handle, inner);
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

function lookupParsedNamespaceURI(node: unknown, prefix: unknown): string | null {
  if (typeof prefix === "symbol") {
    throw new TypeError("Cannot convert a Symbol value to a string");
  }
  const prefixString = prefix === null || prefix === undefined ? null : String(prefix);
  const p = prefixString === "" ? null : prefixString;
  let element: unknown = node;
  while (isParsedNamespaceNode(element) && element.nodeType !== ELEMENT_NODE) {
    element = element.nodeType === DOCUMENT_NODE ? element.documentElement : element.parentNode;
  }
  if (!isParsedNamespaceNode(element) || element.nodeType !== ELEMENT_NODE) return null;
  if (p === "xml") return XML_NS;
  if (p === "xmlns") return XMLNS_NS;

  while (isParsedNamespaceNode(element) && element.nodeType === ELEMENT_NODE) {
    const elementPrefix = element.prefix === undefined ? null : element.prefix;
    const elementNamespace = typeof element.namespaceURI === "string" ? element.namespaceURI : null;
    if (elementNamespace && elementPrefix === p) return elementNamespace;

    const declarationName = p === null ? "xmlns" : `xmlns:${p}`;
    let declaration: unknown = null;
    if (hasParsedGetAttribute(element)) {
      declaration = element.getAttribute(declarationName);
    }
    if (declaration !== null && declaration !== undefined) {
      return declaration === "" ? null : String(declaration);
    }
    const parent = element.parentNode;
    element = isParsedNamespaceNode(parent) && parent.nodeType === ELEMENT_NODE ? parent : null;
  }
  return null;
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

class ParsedElement {
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
    registerParsedHandle(this, handle);
    this._id = id;
    let info;
    try {
      info = handle.nodeInfo(id);
    } catch {
      info = null;
    }
    this.nodeType = info ? info.nodeType : ELEMENT_NODE;
    this.localName = info ? info.localName || "" : "";
    const ownerCt: string | null =
      ownerDoc && "_contentType" in ownerDoc && ownerDoc._contentType
        ? String(ownerDoc._contentType)
        : null;
    const isHtmlDoc = ownerCt === "text/html" || ownerCt == null;
    if (this.nodeType !== ELEMENT_NODE) {
      this.nodeName = info ? info.nodeName : "";
      this.tagName = "";
    } else if (isHtmlDoc) {
      this.nodeName = info ? info.nodeName : "";
      this.tagName = this.nodeName;
    } else {
      this.nodeName = this.localName;
      this.tagName = this.localName;
    }
    this.ownerDocument = ownerDoc || null;
    if (this.nodeType !== ELEMENT_NODE) {
      this.namespaceURI = null;
    } else if (weakSetContains(parsedHandleXml, handle)) {
      const xmlnsAttr = (() => {
        try {
          const attrs = parsedAttrs(handle, id);
          for (const a of attrs) if (a.name === "xmlns") return a.value;
        } catch {}
        return null;
      })();
      this.namespaceURI = xmlnsAttr;
    } else {
      this.namespaceURI = HTML_NS;
    }
    this.prefix = null;
  }
  get textContent(): string {
    try {
      return requireParsedHandle(this).textContent(this._id);
    } catch {
      return "";
    }
  }
  get innerHTML(): string {
    try {
      return requireParsedHandle(this).innerHTML(this._id);
    } catch {
      return "";
    }
  }
  get outerHTML(): string {
    try {
      return requireParsedHandle(this).outerHTML(this._id);
    } catch {
      return "";
    }
  }
  get nodeValue(): string | null {
    if (this.nodeType !== TEXT_NODE && this.nodeType !== COMMENT_NODE) return null;
    let info;
    try {
      info = requireParsedHandle(this).nodeInfo(this._id);
    } catch {
      return null;
    }
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
        ? requireParsedHandle(this).setCommentData(this._id, text)
        : requireParsedHandle(this).setNodeText(this._id, text);
    if (!updated) {
      throw new Error("CharacterData.nodeValue: stale parsed node");
    }
  }
  getAttribute(name: string): string | null {
    if (this.nodeType !== ELEMENT_NODE) return null;
    const attrs = parsedAttrs(requireParsedHandle(this), this._id);
    for (const a of attrs) if (a.name === name) return a.value;
    return null;
  }
  lookupNamespaceURI(prefix: string | null): string | null {
    return lookupParsedNamespaceURI(this, prefix);
  }
  hasAttribute(name: string): boolean {
    return this.getAttribute(name) !== null;
  }
  getAttributeNames(): string[] {
    return parsedAttrs(requireParsedHandle(this), this._id).map((a) => a.name);
  }
  get attributes(): ParsedAttribute[] {
    const list = parsedAttrs(requireParsedHandle(this), this._id);
    Object.defineProperty(list, "getNamedItem", {
      value: (name: unknown) => list.find((a) => a.name === name) || null,
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
        info = requireParsedHandle(this).nodeInfo(id);
      } catch {
        continue;
      }
      if (info && info.nodeType === ELEMENT_NODE)
        out.push(getOrCreateParsedNode(requireParsedHandle(this), id, this.ownerDocument));
    }
    return out;
  }
  hasChildNodes(): boolean {
    return this._childIds().length > 0;
  }
  get childNodes(): Array<ParsedElement | null> {
    return this._childIds().map((id) =>
      getOrCreateParsedNode(requireParsedHandle(this), id, this.ownerDocument),
    );
  }
  normalize(): void {
    normalizeParsedSubtree(this);
  }
  get firstChild(): ParsedElement | null {
    const ids = this._childIds();
    return ids.length > 0
      ? getOrCreateParsedNode(requireParsedHandle(this), ids[0], this.ownerDocument)
      : null;
  }
  get lastChild(): ParsedElement | null {
    const ids = this._childIds();
    return ids.length > 0
      ? getOrCreateParsedNode(requireParsedHandle(this), ids[ids.length - 1], this.ownerDocument)
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
    let pid;
    try {
      pid = requireParsedHandle(this).parentId(this._id);
    } catch {
      return null;
    }
    if (pid < 0) return null;
    let info;
    try {
      info = requireParsedHandle(this).nodeInfo(pid);
    } catch {
      return null;
    }
    if (!info) return null;
    if (info.nodeType === DOCUMENT_NODE) return this.ownerDocument || null;
    return getOrCreateParsedNode(requireParsedHandle(this), pid, this.ownerDocument);
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
      return Array.from<number>(requireParsedHandle(this).childIds(this._id));
    } catch {
      return [];
    }
  }
  _sibling(offset: number): ParsedElement | null {
    const parentId: number = requireParsedHandle(this).parentId(this._id);
    if (parentId < 0) return null;
    const siblings = Array.from<number>(requireParsedHandle(this).childIds(parentId));
    const index = siblings.indexOf(this._id);
    const siblingId = index < 0 ? undefined : siblings[index + offset];
    return siblingId === undefined
      ? null
      : getOrCreateParsedNode(requireParsedHandle(this), siblingId, this.ownerDocument);
  }
  querySelector(selector: unknown): ParsedElement | null {
    if (arguments.length === 0) {
      throw new TypeError("querySelector: 1 argument required");
    }
    const ids = this._scopedQS(selector);
    return ids.length > 0
      ? getOrCreateParsedNode(requireParsedHandle(this), ids[0], this.ownerDocument)
      : null;
  }
  querySelectorAll(selector: unknown): ReadonlyArray<ParsedElement | null> {
    if (arguments.length === 0) {
      throw new TypeError("querySelectorAll: 1 argument required");
    }
    const arr = this._scopedQS(selector).map((id) =>
      getOrCreateParsedNode(requireParsedHandle(this), id, this.ownerDocument),
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
    const pid = requireParsedHandle(this).parentId(this._id);
    const rootId = pid >= 0 ? pid : this._id;
    let ids;
    try {
      ids = Array.from(requireParsedHandle(this).querySelectorAllInSubtree(rootId, selector));
    } catch (err) {
      throw new DOMException(
        "Failed to execute 'matches' on 'Element': '" +
          selector +
          "' is not a valid selector. " +
          (err && (err as Error).message ? (err as Error).message : String(err)),
        "SyntaxError",
      );
    }
    return ids.indexOf(this._id) >= 0;
  }
  webkitMatchesSelector(selector: string): boolean {
    return this.matches(selector);
  }
  contains(other: Idl.Node | null): boolean {
    if (!other || !(other instanceof ParsedElement)) return false;
    if (parsedHandle(other) !== requireParsedHandle(this)) return false;
    if (other._id === this._id) return true;
    let descendants;
    try {
      descendants = Array.from(requireParsedHandle(this).descendantsOf(this._id));
    } catch {
      return false;
    }
    return descendants.indexOf(other._id) >= 0;
  }
  _scopedQS(selectorArg: unknown): number[] {
    let selector: string;
    if (typeof selectorArg === "string") {
      selector = selectorArg;
    } else {
      try {
        selector = String(selectorArg);
      } catch {
        throw new DOMException(
          "Failed to execute 'querySelector' on parsed document: selector argument is not a valid string",
          "SyntaxError",
        );
      }
    }
    if (selectorHasPseudoElement(selector)) return [];
    try {
      return Array.from<number>(
        requireParsedHandle(this).querySelectorAllInSubtree(this._id, selector),
      );
    } catch (err) {
      throw new DOMException(
        "Failed to execute 'querySelector' on parsed document: '" +
          selector +
          "' is not a valid selector. " +
          (err && (err as Error).message ? (err as Error).message : String(err)),
        "SyntaxError",
      );
    }
  }
  // Page-owned wrappers use dynamic slots across live and parser-owned handles.
  appendChild<T extends AdoptableNode | null | undefined>(child: T): T {
    if (!this.ownerDocument || !this.ownerDocument._mutable) {
      throw notSupported("appendChild on DOMParser result (read-only)");
    }
    const candidate = child;
    if (!candidate) throw notSupported("appendChild: null/undefined child");
    const handle = requireParsedHandle(this);
    const candidateDom = parsedHandle(candidate);
    if (candidateDom && candidateDom !== handle) {
      adoptIntoDom(handle, candidate, this.ownerDocument);
    }
    if (typeof candidate._id !== "number" || candidate._id < 0) {
      throw notSupported("appendChild: unsupported child shape");
    }
    try {
      handle.appendChildNode(this._id, candidate._id);
    } catch {}
    try {
      candidate.parentNode = this;
    } catch {}
    try {
      candidate.ownerDocument = this.ownerDocument;
    } catch {}
    return child;
  }
  // Page-owned wrappers may carry dynamic handle metadata.
  removeChild<T extends Idl.Node>(child: T): T {
    if (!this.ownerDocument || !this.ownerDocument._mutable) {
      throw notSupported("removeChild on DOMParser result (read-only)");
    }
    const childId: unknown = child ? Reflect.get(Object(child), "_id") : undefined;
    if (typeof childId !== "number") {
      throw notSupported("removeChild: invalid child");
    }
    try {
      requireParsedHandle(this).removeNode(childId);
    } catch {}
    return child;
  }
  // Node wrappers stay dynamic; a non-null reference remains unsupported.
  insertBefore<T extends AdoptableNode | null | undefined>(
    newChild: T,
    refChild: Idl.Node | null,
  ): T {
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
  setAttribute(name: string, value: string | Idl.TrustedType): void {
    if (!this.ownerDocument || !this.ownerDocument._mutable) {
      throw notSupported("setAttribute on DOMParser result (read-only)");
    }
    try {
      requireParsedHandle(this).setAttribute(this._id, String(name), String(value));
    } catch {}
  }
  setAttributeNS(
    _namespaceURI: string | null,
    qualifiedName: string,
    value: string | Idl.TrustedType,
  ): void {
    if (!this.ownerDocument || !this.ownerDocument._mutable) {
      throw notSupported("setAttributeNS on DOMParser result (read-only)");
    }
    const name = String(qualifiedName);
    try {
      requireParsedHandle(this).setAttribute(this._id, name, String(value));
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
    let newId = -1;
    try {
      newId = requireParsedHandle(this).deepCloneNode(this._id);
    } catch {}
    if (newId < 0) {
      try {
        const tag = (this.tagName || "div").toLowerCase();
        newId = requireParsedHandle(this).createElement(tag);
      } catch {
        throw notSupported("cloneNode: wasm trap");
      }
    }
    return getOrCreateParsedNode(requireParsedHandle(this), newId, this.ownerDocument);
  }
  removeAttribute(name: unknown): void {
    if (!this.ownerDocument || !this.ownerDocument._mutable) {
      throw notSupported("removeAttribute on DOMParser result (read-only)");
    }
    try {
      requireParsedHandle(this).removeAttribute(this._id, String(name));
    } catch {}
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean {
    return false;
  }
}
class ParsedFragment {
  declare _id: number;
  declare nodeType: number;
  declare nodeName: string;
  declare ownerDocument: ParsedOwnerDocumentValue;
  declare parentNode: ParsedNode | ParsedOwnerDocumentValue;
  constructor(handle: DomHandle, id: number, ownerDoc: ParsedOwnerDocumentValue) {
    registerParsedHandle(this, handle);
    this._id = id;
    this.nodeType = DOCUMENT_FRAGMENT_NODE;
    this.nodeName = "#document-fragment";
    this.ownerDocument = ownerDoc || null;
    this.parentNode = null;
  }
  lookupNamespaceURI(prefix: string | null): string | null {
    return lookupParsedNamespaceURI(this, prefix);
  }
  get childNodes(): Array<ParsedElement | null> {
    let kids;
    try {
      kids = Array.from(requireParsedHandle(this).childIds(this._id));
    } catch {
      return [];
    }
    return kids.map((cid) =>
      getOrCreateParsedNode(requireParsedHandle(this), cid, this.ownerDocument),
    );
  }
  get children(): Array<ParsedElement | null> {
    const out: Array<ParsedElement | null> = [];
    let kids;
    try {
      kids = Array.from(requireParsedHandle(this).childIds(this._id));
    } catch {
      return out;
    }
    for (const cid of kids) {
      let info;
      try {
        info = requireParsedHandle(this).nodeInfo(cid);
      } catch {
        continue;
      }
      if (info && info.nodeType === ELEMENT_NODE)
        out.push(getOrCreateParsedNode(requireParsedHandle(this), cid, this.ownerDocument));
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
  appendChild<T extends AdoptableNode | null | undefined>(child: T): T {
    if (!this.ownerDocument || !this.ownerDocument._mutable) {
      throw notSupported("appendChild on read-only fragment");
    }
    const candidate = child;
    if (!candidate) throw notSupported("appendChild: null/undefined child");
    const handle = requireParsedHandle(this);
    const candidateDom = parsedHandle(candidate);
    if (candidateDom && candidateDom !== handle) {
      adoptIntoDom(handle, candidate, this.ownerDocument);
    }
    if (typeof candidate._id !== "number" || candidate._id < 0) {
      throw notSupported("appendChild: unsupported child shape");
    }
    try {
      handle.appendChildNode(this._id, candidate._id);
    } catch {}
    try {
      candidate.parentNode = this;
    } catch {}
    try {
      candidate.ownerDocument = this.ownerDocument;
    } catch {}
    return child;
  }
  removeChild<T extends Idl.Node>(child: T): T {
    if (!this.ownerDocument || !this.ownerDocument._mutable) {
      throw notSupported("removeChild on read-only fragment");
    }
    const handle = requireParsedHandle(this);
    if (!isParsedObject(child) || parsedHandle(child) !== handle || typeof child._id !== "number") {
      throw notSupported("removeChild: unsupported fragment child");
    }
    if (handle.parentId(child._id) !== this._id || !handle.removeNode(child._id)) {
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
    let ids;
    try {
      ids = Array.from(requireParsedHandle(this).querySelectorAllInSubtree(this._id, sel));
    } catch (err) {
      throw new DOMException(
        "Failed to execute 'querySelector' on DocumentFragment: '" +
          sel +
          "' is not a valid selector. " +
          (err && (err as Error).message ? (err as Error).message : String(err)),
        "SyntaxError",
      );
    }
    return ids.length > 0
      ? getOrCreateParsedNode(requireParsedHandle(this), ids[0], this.ownerDocument)
      : null;
  }
  querySelectorAll(selector: unknown): ReadonlyArray<ParsedElement | null> {
    if (arguments.length === 0) {
      throw new TypeError("querySelectorAll: 1 argument required");
    }
    const sel = String(selector);
    if (selectorHasPseudoElement(sel)) {
      const empty: Array<ParsedElement | null> = [];
      Object.setPrototypeOf(empty, NodeListCls.prototype);
      Object.freeze(empty);
      return empty;
    }
    let ids;
    try {
      ids = Array.from(requireParsedHandle(this).querySelectorAllInSubtree(this._id, sel));
    } catch (err) {
      throw new DOMException(
        "Failed to execute 'querySelectorAll' on DocumentFragment: '" +
          sel +
          "' is not a valid selector. " +
          (err && (err as Error).message ? (err as Error).message : String(err)),
        "SyntaxError",
      );
    }
    const arr = ids.map((id) =>
      getOrCreateParsedNode(requireParsedHandle(this), id, this.ownerDocument),
    );
    Object.setPrototypeOf(arr, NodeListCls.prototype);
    Object.freeze(arr);
    return arr;
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
function leadingDoctype(source: string, html: boolean): DoctypeInfo | null {
  const m = /^<!doctype(?:\s+([^\s>]+))?([^>]*)>/i.exec(source);
  if (!m) return null;
  const rest = m[2] ?? "";
  const quoted = (s: string) => /^\s*("([^"]*)"|'([^']*)')/.exec(s);
  let publicId = "";
  let systemId = "";
  const kw = /^\s*(public|system)/i.exec(rest);
  if (kw) {
    let after = rest.slice(kw[0].length);
    const first = quoted(after);
    if (first) {
      const value = first[2] ?? first[3] ?? "";
      after = after.slice(first[0].length);
      if ((kw[1] ?? "").toLowerCase() === "public") {
        publicId = value;
        const second = quoted(after);
        if (second) systemId = second[2] ?? second[3] ?? "";
      } else {
        systemId = value;
      }
    }
  }
  const name = m[1] ?? "";
  return { name: html ? name.toLowerCase() : name, publicId, systemId };
}

// XML qualified-name matcher: browser-permissive, NOT strict XML 1.0
// 5e. Rejects digits / "-" / "." / "<" / ">" / control as NameStart,
// rejects ">" anywhere; accepts any non-ASCII ≥ \u00C0 (broader than
// the spec, matches Chrome/Firefox).

class ParsedDocument {
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
    registerParsedHandle(this, handle);
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
      registerFinalizationHeld(domHandleFinalizer, this, handle);
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
    expression: string,
    contextNode: Idl.Node,
    resolver: XPathResolver = null,
    type = 0,
    result: Idl.XPathResult | null = null,
  ): ReturnType<typeof evaluateXPath> {
    return evaluateXPath(expression, contextNode, resolver, type, result);
  }
  createExpression(
    expression: string,
    resolver: XPathResolver = null,
  ): ReturnType<typeof createExpression> {
    return createExpression(expression, resolver);
  }
  createNSResolver<T extends Idl.Node>(nodeResolver: T): T {
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
      const handle = requireParsedHandle(this);
      const ids = Array.from<number>(
        handle.querySelectorAllInSubtree(handle.documentNodeId(), "style, link[rel='stylesheet']"),
      );
      for (const id of ids) {
        const sheet = new CSSStyleSheetCtor();
        // Read the <style> text content and parse it into rules.
        let text = "";
        try {
          text = handle.textContent(id) || "";
        } catch {}
        if (text) sheet.replaceSync(text);
        try {
          styleSheetFields(sheet).ownerNode = getOrCreateParsedNode(handle, id, this);
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
      return requireParsedHandle(this).title();
    } catch {
      return "";
    }
  }
  get documentElement(): ParsedElement | null {
    const handle = requireParsedHandle(this);
    const rootId = handle.documentNodeId();
    let kids;
    try {
      kids = Array.from(handle.childIds(rootId));
    } catch {
      return null;
    }
    for (const id of kids) {
      let info;
      try {
        info = handle.nodeInfo(id);
      } catch {
        continue;
      }
      if (info && info.nodeType === ELEMENT_NODE) {
        return getOrCreateParsedNode(handle, id, this);
      }
    }
    return null;
  }
  lookupNamespaceURI(prefix: string | null): string | null {
    const root = this.documentElement;
    return root ? root.lookupNamespaceURI(prefix) : null;
  }
  get body(): ParsedElement | null {
    let ids;
    try {
      ids = Array.from(requireParsedHandle(this).querySelectorAll("body"));
    } catch {
      return null;
    }
    return ids.length > 0 ? getOrCreateParsedNode(requireParsedHandle(this), ids[0], this) : null;
  }
  get head(): ParsedElement | null {
    let ids;
    try {
      ids = Array.from(requireParsedHandle(this).querySelectorAll("head"));
    } catch {
      return null;
    }
    return ids.length > 0 ? getOrCreateParsedNode(requireParsedHandle(this), ids[0], this) : null;
  }
  get children(): ParsedElement[] {
    const docEl = this.documentElement;
    return docEl ? [docEl] : [];
  }
  normalize(): void {
    normalizeParsedSubtree(this);
  }
  get childNodes(): Array<ParsedElement | null> {
    const handle = requireParsedHandle(this);
    const ids = Array.from<number>(handle.childIds(handle.documentNodeId()));
    return ids.map((id) => getOrCreateParsedNode(handle, id, this));
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
    let id;
    try {
      id = requireParsedHandle(this).querySelector(sel);
    } catch (err) {
      throw new DOMException(
        "Failed to execute 'querySelector' on Document: '" +
          sel +
          "' is not a valid selector. " +
          (err && (err as Error).message ? (err as Error).message : String(err)),
        "SyntaxError",
      );
    }
    return id >= 0 ? getOrCreateParsedNode(requireParsedHandle(this), id, this) : null;
  }
  querySelectorAll(selector: unknown): ReadonlyArray<ParsedElement | null> {
    if (arguments.length === 0) {
      throw new TypeError("querySelectorAll: 1 argument required");
    }
    const sel = String(selector);
    if (selectorHasPseudoElement(sel)) {
      const empty: Array<ParsedElement | null> = [];
      Object.setPrototypeOf(empty, NodeListCls.prototype);
      Object.freeze(empty);
      return empty;
    }
    let ids;
    try {
      ids = Array.from(requireParsedHandle(this).querySelectorAll(sel));
    } catch (err) {
      throw new DOMException(
        "Failed to execute 'querySelectorAll' on Document: '" +
          sel +
          "' is not a valid selector. " +
          (err && (err as Error).message ? (err as Error).message : String(err)),
        "SyntaxError",
      );
    }
    const arr = ids.map((id) => getOrCreateParsedNode(requireParsedHandle(this), id, this));
    Object.setPrototypeOf(arr, NodeListCls.prototype);
    Object.freeze(arr);
    return arr;
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
      if (!isHtmlDoc) {
        id = requireParsedHandle(this).createElementVerbatim(tag, ns || "");
      } else {
        id = requireParsedHandle(this).createElement(tag);
      }
    } catch (e) {
      throw new Error("createElement: wasm trap: " + (e instanceof Error ? e.message : String(e)));
    }
    const el = parsedNodeFor(requireParsedHandle(this), id, this);
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
      id = requireParsedHandle(this).createElementNS(ns || "", qn);
    } catch (e) {
      throw new Error(
        "createElementNS: wasm trap: " + (e instanceof Error ? e.message : String(e)),
      );
    }
    const el = parsedNodeFor(requireParsedHandle(this), id, this);
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
      id = requireParsedHandle(this).createTextNode(String(text));
    } catch (e) {
      throw new Error("createTextNode: wasm trap: " + (e instanceof Error ? e.message : String(e)));
    }
    const el = parsedNodeFor(requireParsedHandle(this), id, this);
    el.ownerDocument = this;
    return el;
  }
  createDocumentFragment(): ParsedFragment {
    if (!this._mutable) {
      throw notSupported("Document.createDocumentFragment on DOMParser result");
    }
    let id;
    try {
      id = requireParsedHandle(this).createElement("kitesurf-fragment");
    } catch (e) {
      throw new Error(
        "createDocumentFragment: wasm trap: " + (e instanceof Error ? e.message : String(e)),
      );
    }
    return new ParsedFragment(requireParsedHandle(this), id, this);
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

function parseDocument(input: string, type: unknown): ParsedDocument {
  const mime = (typeof type === "string" ? type : "text/html").toLowerCase().split(";")[0].trim();
  const baseUrl = opts && typeof opts.getCurrentUrl === "function" ? opts.getCurrentUrl() : pageUrl;
  if (mime === "text/html") {
    let handle;
    try {
      // In HTML, a leading `<?` is a bogus comment token, not an XML PI.
      // Canonicalize it because the parser backend drops the document tree.
      let html = input;
      if (input.startsWith("<?")) {
        const end = input.indexOf(">");
        const data = input.slice(1, end < 0 ? undefined : end);
        html = `<!--${data}-->${end < 0 ? "" : input.slice(end + 1)}`;
      }
      handle = DomHandleCtor(html, baseUrl);
    } catch (err) {
      return makeParseErrorDocument("DOMParser: HTML parse failed: " + errorMessage(err), baseUrl);
    }
    // Only an exact `<!DOCTYPE html>` gives no-quirks mode. This regex
    // approximates the parser's doctype rules.
    const trimmed = input.replace(/^\uFEFF/, "").trim();
    const compat = /^<!doctype\s+html\s*>/i.test(trimmed) ? "CSS1Compat" : "BackCompat";
    const doc = new ParsedDocument(handle, baseUrl, "text/html", compat);
    doc._doctypeInfo = leadingDoctype(trimmed, true);
    return doc;
  }
  if (XML_MIME_TYPES.has(mime)) {
    // There is no XML parser, so XML, XHTML and SVG go through the
    // forgiving HTML parser. The handle is tagged so its elements default
    // to the null namespace. XML documents are always no-quirks.
    try {
      const handle = DomHandleCtor(input, baseUrl);
      weakSetInsert(parsedHandleXml, handle);
      const doc = new ParsedDocument(handle, baseUrl, mime, "CSS1Compat");
      doc._doctypeInfo = leadingDoctype(
        input
          .replace(/^\uFEFF/, "")
          .replace(/^\s*<\?xml[^>]*\?>/, "")
          .trim(),
        false,
      );
      return doc;
    } catch (err) {
      return makeParseErrorDocument(
        "DOMParser: XML/SVG via HTML-parser fallback failed: " + errorMessage(err),
        baseUrl,
      );
    }
  }
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
  parseFromString(str: Idl.TrustedHTML | string, type: Idl.DOMParserSupportedType): ParsedDocument {
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
