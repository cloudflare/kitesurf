// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Live and detached Document implementations; parser-backed documents live in parser.ts.

import {
  dom,
  liveDocument,
  liveWindow,
  windowProxy as window,
  getCurrentUrl,
  hitTestViaPaint,
  nodeFor,
  elementFor,
  isElementNode,
  isDoctypeNode,
  mintedNode,
  makeNodeList,
  makeHtmlCollection,
  activeElement,
  readyState,
  cookieString,
  cookieWrites,
  documentOpaqueOrigin,
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
  formBehindProxy,
  hasParsedHandle,
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
import { cssEscape, cssString } from "./util/strings.js";
import { isHtmlTag } from "./element/html-tag.js";
import {
  validateAttrName,
  isValidXmlName,
  validatePIArgs,
  XML_NS,
  XMLNS_NS,
} from "./util/validation.js";
import { bumpMutationSeq } from "./mutations/seq.js";
import {
  markForceAsyncScript,
  markRuntimeCreatedScript,
  markWrittenScript,
} from "./mutations/observer.js";
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
  type HtmlCollectionCls,
  type NodeListCls,
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
  cloneWrapper,
  assertDocumentInsertAllowed,
  compareDocumentPosition,
  documentBaseURI,
} from "./node-base.js";
import { __ks_documentImpl_location_get, __ks_documentImpl_location_set } from "./window.js";
import { ksInternals } from "./internals.js";

function ksState() {
  return getInternalState();
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
  const hook: unknown = ksInternals.upgradeCustomElement;
  if (typeof hook !== "function") return;
  try {
    hook(node, tag);
  } catch {}
}

// adoptNode and importNode must reject a shadow root but accept a plain
// DocumentFragment. The input is page-controlled, so every property read is
// narrowed first. blitz's shadowHostId is >= 0 only for real shadow roots.
function isShadowRootNode(node: unknown): boolean {
  if (node === null || typeof node !== "object") return false;
  if (!("nodeType" in node) || node.nodeType !== DOCUMENT_FRAGMENT_NODE) return false;
  if (!("_id" in node) || typeof node._id !== "number" || node._id < 0) {
    return false;
  }
  return dom.shadowHostId(node._id) >= 0;
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
    // The untyped WPT engine also passes a parentNode that may not be an
    // element; the shim's getComputedStyle answers an empty style for it.
    (element) => liveWindow().getComputedStyle(element as Idl.Element),
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
    const attribute = attrs[i];
    if (!attribute) continue;
    if (attribute.namespaceURI) {
      destination.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
    } else {
      destination.setAttribute(attribute.name, attribute.value);
    }
  }
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

type ForeignDocumentMethod =
  | "querySelector"
  | "querySelectorAll"
  | "getElementById"
  | "getElementsByTagName";
// DOMPurify calls document.getElementsByTagName on a parsed document, which
// must not answer from the live DOM. Such a receiver (a registered parsed
// document) answers with its own method. It isn't a DocumentImpl, whatever the
// method's `this` type says, so the cast below carries the same fiction.
function foreignDocumentMethod<K extends ForeignDocumentMethod>(
  self: unknown,
  name: K,
): DocumentImpl[K] | null {
  if (!self || typeof self !== "object" || !hasParsedHandle(self)) return null;
  const method: unknown = Reflect.get(self, name);
  if (typeof method !== "function" || method === DocumentImpl.prototype[name]) return null;
  return method as DocumentImpl[K];
}

class DocumentImpl extends NodeBase implements Idl.Document {
  // Storage behind the childNodes, doctype and implementation accessors.
  declare _doctype: DocumentTypeNode | undefined;
  declare _docChildNodes: NodeListCls<NodeBase> | undefined;
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
      get: () => documentBaseURI(getCurrentUrl()),
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
  // An opaque-origin document has no cookie store, as in Chrome.
  get cookie() {
    if (documentOpaqueOrigin) {
      throw new DOMException(
        "Failed to read the 'cookie' property from 'Document': The document is sandboxed and lacks the 'allow-same-origin' flag.",
        "SecurityError",
      );
    }
    return cookieString;
  }
  get referrer() {
    return typeof opts?.referrer === "string" ? opts.referrer : "";
  }
  set cookie(value) {
    if (documentOpaqueOrigin) {
      throw new DOMException(
        "Failed to set the 'cookie' property on 'Document': The document is sandboxed and lacks the 'allow-same-origin' flag.",
        "SecurityError",
      );
    }
    const raw = String(value ?? "");
    if (!raw) return;
    applyLocalCookieWrite(raw);
    cookieWrites.push(raw);
  }
  // Blitz drops doctypes during parse, so keep a synthetic node for this document.
  get doctype(): DocumentTypeNode {
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
      return synth;
    }
    return this._doctype;
  }
  // Keep the synthetic doctype at its source position without changing Blitz's XHTML sniff.
  get childNodes(): NodeListCls<NodeBase> {
    if (!this._docChildNodes) {
      const self = this;
      const id = this._id;
      const list = makeNodeList(() => {
        const ids = Array.from(dom.childIds(id));
        const wasmKids = ids.map((cid) => nodeFor(cid)).filter((n): n is NodeBase => n !== null);
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
      return list;
    }
    return this._docChildNodes;
  }

  // Reject document roots before changing node ownership.
  adoptNode(node: NodeBase) {
    if (node == null || typeof node !== "object") {
      throw new TypeError("adoptNode: argument must be a Node");
    }
    if (node.nodeType === DOCUMENT_NODE) {
      throw new DOMException("adoptNode: cannot adopt a Document", "NotSupportedError");
    }
    // Adopting a shadow root is a HierarchyRequestError.
    if (isShadowRootNode(node)) {
      throw new DOMException("adoptNode: cannot adopt a ShadowRoot", "HierarchyRequestError");
    }
    const parent = node.parentNode;
    if (parent) {
      try {
        parent.removeChild(node);
      } catch {}
    }
    // nodeOwnerDoc has no entry for nodes of the live document, so adopting
    // into it deletes entries and adopting into a detached document sets them.
    const isLive = this === liveWindow().document;
    const stamp = (n: NodeBase | null) => {
      if (!n || typeof n !== "object") return;
      if (isLive) {
        nodeOwnerDoc.delete(n);
      } else {
        nodeOwnerDoc.set(n, this);
      }
      // An adopted doctype has no parent.
      if (n.nodeType === DOCTYPE_NODE) {
        if (isLive) {
          syntheticParent.delete(n);
        } else {
          syntheticParent.delete(n);
        }
      }
      // Into the live HTML document: drop the XML flag so tagName upper-cases.
      // DetachedDocument.adoptNode handles HTML to XML.
      if (isLive && n.nodeType === ELEMENT_NODE && typeof n._id === "number" && n._id >= 0) {
        xmlOwned.delete(n._id);
      }
      try {
        const kids = n.childNodes;
        if (kids) for (let i = 0; i < kids.length; i++) stamp(kids[i]);
      } catch {}
    };
    stamp(node);
    return node;
  }

  // Partial importNode: elements, text, comments, attrs and fragments.
  // The clone is not in xmlOwned, so tagName follows HTML rules.
  importNode(
    node: NodeBase,
    deep?: boolean | Idl.ImportNodeOptions,
  ): ReturnType<NodeBase["cloneNode"]> {
    if (!node) throw notSupported("importNode: node is null/undefined");
    // Importing a shadow root is a NotSupportedError.
    if (isShadowRootNode(node)) {
      throw new DOMException("importNode: cannot import a ShadowRoot", "NotSupportedError");
    }
    if (node.nodeType === ELEMENT_NODE) {
      // An element clones through createElementNS, which records its
      // namespace and qualified name; only attribute names and values are
      // copied.
      const el = node as Element;
      const ns = el.namespaceURI || HTML_NS;
      const localName = el.localName || el._info?.localName || "";
      const prefix = el.prefix || null;
      const qname = prefix ? `${prefix}:${localName}` : localName;
      const clone = this.createElementNS(ns, qname);
      try {
        copyImportedAttributes(el, clone);
      } catch {}
      if (deep && node.childNodes) {
        for (let i = 0; i < node.childNodes.length; i++) {
          const child = node.childNodes[i];
          const childClone = this.importNode(child, true);
          // A child is never a document, so its import is a wrapper (with an _id).
          if (childClone && "_id" in childClone) clone.appendChild(childClone);
        }
      }
      return clone;
    }
    if (node.nodeType === TEXT_NODE) {
      return this.createTextNode(node.nodeValue || node.textContent || "");
    }
    if (node.nodeType === COMMENT_NODE) {
      return this.createComment(node.nodeValue || "");
    }
    if (node.nodeType === ATTRIBUTE_NODE) {
      // Attr. AttrCls.cloneNode copies namespace, prefix, localName and value
      // and leaves ownerElement null, as importNode requires.
      if (typeof node.cloneNode === "function") {
        return node.cloneNode(true);
      }
    }
    if (node.nodeType === DOCUMENT_FRAGMENT_NODE) {
      const frag = this.createDocumentFragment();
      if (deep && node.childNodes) {
        for (let i = 0; i < node.childNodes.length; i++) {
          const childClone = this.importNode(node.childNodes[i], true);
          // A child is never a document, so its import is a wrapper (with an _id).
          if (childClone && "_id" in childClone) frag.appendChild(childClone);
        }
      }
      return frag;
    }
    // Limitation: other node types return null.
    return null;
  }

  get documentElement() {
    const id = dom.querySelector("html");
    if (id < 0) return null;
    const el = elementFor(id);
    if (!el) return null;
    if (!el.rootStamped) {
      const proto = (name: string): (() => number) | null => {
        let p: object | null = Object.getPrototypeOf(el);
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
  get head(): Element | null {
    const id = dom.querySelector("head");
    const el = id >= 0 ? elementFor(id) : null;
    return isHtmlTag(el, "head") ? el : null;
  }
  get body(): Element | null {
    const id = dom.querySelector("body");
    const el = id >= 0 ? elementFor(id) : null;
    return isHtmlTag(el, "body") ? el : null;
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
      const kid = kids[i];
      if (isElementNode(kid)) return kid;
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
        const n = elementFor(id);
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
        const n = elementFor(id);
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
        const n = elementFor(id);
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
        const n = elementFor(id);
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
        const n = elementFor(id);
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
        const n = elementFor(id);
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
  // The IDL's type; the page's value is not checked beyond being iterable.
  set adoptedStyleSheets(v: Idl.CSSStyleSheet[]) {
    // Clear, then push each sheet, so the mirror reconcile runs.
    const a = adoptedStyleSheets;
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

  querySelector(selector: string): Element | null {
    if (arguments.length < 1) {
      throw new TypeError(
        "Failed to execute 'querySelector' on 'Document': 1 argument required, but only 0 present.",
      );
    }
    // Cross-doc receiver, see getElementsByTagName.
    const foreign = foreignDocumentMethod(this, "querySelector");
    if (foreign) return foreign.call(this, selector);
    return scopedQuerySelector(DOCUMENT_ID, selector);
  }
  querySelectorAll(selector: string): NodeListCls<Element> {
    if (arguments.length < 1) {
      throw new TypeError(
        "Failed to execute 'querySelectorAll' on 'Document': 1 argument required, but only 0 present.",
      );
    }
    const foreign = foreignDocumentMethod(this, "querySelectorAll");
    if (foreign) return foreign.call(this, selector);
    return scopedQuerySelectorAll(DOCUMENT_ID, selector);
  }
  getElementById(id: string): Element | null {
    // Cross-doc receiver, see getElementsByTagName.
    const foreign = foreignDocumentMethod(this, "getElementById");
    if (foreign) return foreign.call(this, id);
    // DOMString conversion: null searches for "null". No element matches "".
    const key = String(id);
    if (key === "") return null;
    const nid = dom.getElementById(key);
    return nid >= 0 ? elementFor(nid) : null;
  }
  getElementsByTagName(name: string): HtmlCollectionCls {
    const foreign = foreignDocumentMethod(this, "getElementsByTagName");
    if (foreign) return foreign.call(this, name);
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
        const cand = Array.from(scopedQuerySelectorAll(DOCUMENT_ID, "*"));
        return cand.filter((el) => {
          const elNs = el.namespaceURI || null;
          if (ns !== "*" && elNs !== ns) return false;
          if (ln === "*") return true;
          return (el.localName || "") === ln;
        });
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
      return Array.from(dom.querySelectorAll(`[name=${cssString(t)}]`))
        .map((id) => elementFor(id))
        .filter((n): n is Element => n !== null);
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
    if (asciiLower === "script") {
      markRuntimeCreatedScript(id);
      markForceAsyncScript(id);
    }
    // createElement never splits on a colon: prefix is null. viaNS=false
    // keeps the localName getter from slicing the qname.
    elemNs.set(id, {
      qname: asciiLower,
      ns: HTML_NS,
      viaNS: false,
    });
    const node = mintedNode(id, ELEMENT_NODE);
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
    const ns = namespaceURI == null || namespaceURI === "" ? null : String(namespaceURI);
    const qn = String(qualifiedName === undefined ? "undefined" : qualifiedName);
    // Split on the first colon; later colons stay in the local part. The
    // local part must start with a NameStartChar, and all non-ASCII counts,
    // as in browsers. A prefix must be non-empty but may start with a digit.
    const colon = qn.indexOf(":");
    const prefix = colon >= 0 ? qn.slice(0, colon) : null;
    const local = colon >= 0 ? qn.slice(colon + 1) : qn;
    function isNameStartChar(ch: string) {
      const c = ch.charCodeAt(0);
      if (c >= 0x80) return true;
      return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f || c === 0x3a;
    }
    function hasBlockedChar(s: string) {
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        // Control chars, space and `>` fail anywhere. `<` fails only as the
        // first local char (the NameStartChar check), so "f<oo" is valid.
        if (c <= 0x20 || c === 0x3e) return true;
      }
      return false;
    }
    if (
      qn.length === 0 ||
      local.length === 0 ||
      prefix === "" ||
      hasBlockedChar(qn) ||
      !isNameStartChar(local[0])
    ) {
      throw new DOMException(
        "createElementNS: '" + qn + "' is not a valid qualified name",
        "InvalidCharacterError",
      );
    }
    if (prefix && !ns) {
      throw new DOMException(
        "createElementNS: prefix '" + prefix + "' requires a non-null namespace",
        "NamespaceError",
      );
    }
    if (prefix === "xml" && ns !== XML_NS) {
      throw new DOMException(
        "createElementNS: 'xml' prefix is reserved for the XML namespace",
        "NamespaceError",
      );
    }
    if ((qn === "xmlns" || prefix === "xmlns") && ns !== XMLNS_NS) {
      throw new DOMException(
        "createElementNS: 'xmlns' qualifies only the XMLNS namespace",
        "NamespaceError",
      );
    }
    if (ns === XMLNS_NS && qn !== "xmlns" && prefix !== "xmlns") {
      throw new DOMException(
        "createElementNS: XMLNS namespace requires the 'xmlns' qname or prefix",
        "NamespaceError",
      );
    }
    const isHtmlNs = ns === HTML_NS;
    const localForWasm = isHtmlNs ? local.replace(/[A-Z]/g, (c) => c.toLowerCase()) : local;
    // Stylo's namespace selectors (`|div`, `*|div`) need the real namespace,
    // including "no namespace".
    const nsForWasm = ns == null ? "" : String(ns);
    if (ns === SVG_NS && local === "text") {
      try {
        ksInternals.demandFontOutlines?.();
      } catch {}
    }
    const id = dom.createElementNS(nsForWasm, localForWasm);
    // Keyed by node id so the namespace survives a new wrapper.
    elemNs.set(id, {
      qname: qn,
      ns,
      viaNS: true,
    });
    // The namespace lives in elemNs, not in blitz, so the boa-to-blitz
    // fast path must never answer for this node (fastpath.ts).
    fastpathMarkSpecial(id);
    const node = mintedNode(id, ELEMENT_NODE);
    if (isHtmlNs) upgradeIfCustomElement(node, localForWasm);
    return node;
  }
  createTextNode(data: string): TextNode {
    // WebIDL DOMString conversion preserves "null" and "undefined".
    const id = dom.createTextNode(String(data));
    return mintedNode(id, TEXT_NODE);
  }
  // Blitz has no detached attributes, so this builds the same Attr object
  // that .attributes uses, with no owner element.
  createAttribute(name: string) {
    // WebIDL DOMString conversion preserves "null" and "undefined".
    const nm = String(name);
    validateAttrName(nm);
    // The live document is HTML, so ASCII-lowercase the name.
    const finalName = nm.replace(/[A-Z]/g, (c) => c.toLowerCase());
    const attr: AttrCls = Object.create(AttrCls.prototype);
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
    return mintedNode(id, COMMENT_NODE);
  }
  // Limitation: wasm has no PI nodes, so a PI is a Text node stamped with
  // nodeType 7, nodeName and target. DetachedDocument does the same.
  createProcessingInstruction(target: string, data: string): TextNode & Idl.ProcessingInstruction {
    validatePIArgs(target, data);
    const t = this.createTextNode(String(data ?? ""));
    Object.defineProperty(t, "nodeType", { value: 7, enumerable: false, configurable: true });
    Object.defineProperty(t, "nodeName", {
      value: String(target ?? ""),
      enumerable: false,
      configurable: true,
    });
    Object.defineProperty(t, "target", {
      value: String(target ?? ""),
      configurable: true,
    });
    // Element.textContent skips stamped PI ids. The id stays live because
    // setting textContent detaches nodes without dropping them.
    if (t && t._id != null && t._id >= 0) stampedPiIds.add(t._id);
    // The stamps above make the text node a processing instruction.
    return t as TextNode & Idl.ProcessingInstruction;
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
    return mintedNode(id, DOCUMENT_FRAGMENT_NODE);
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
  write(...args: Array<Idl.TrustedHTML | string>) {
    try {
      const markup = args.join("");
      if (!markup) return;
      const host = this.body || this.documentElement;
      if (!host) return;
      const tmp = this.createElement("div");
      tmp.innerHTML = markup;
      // innerHTML marks its scripts already-started, but written scripts run:
      // pre-ES6 loaders write `<script src>` from inside a script. Marking
      // them lets the insert hook, notified by the append below, run them.
      const scripts = tmp.querySelectorAll("script");
      for (let i = 0; i < scripts.length; i++) {
        const id = scripts[i]?._id;
        if (typeof id === "number") markWrittenScript(id);
      }
      while (tmp.firstChild) host.appendChild(tmp.firstChild);
    } catch {}
  }
  writeln(...args: Array<Idl.TrustedHTML | string>) {
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
      const fontsReadyHook = ksInternals.fontsReady;
      const fontsInflightHook = ksInternals.fontsInflightCount;
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
    if (
      src === "" &&
      typeof bodyKey === "string" &&
      bodyKey.length > CURRENT_SCRIPT_BODY_KEY_MATCH_THRESHOLD
    ) {
      try {
        const scripts = this.querySelectorAll("script");
        for (let i = 0; i < scripts.length; i++) {
          const s = scripts[i];
          if (!s || (s.getAttribute && s.getAttribute("src"))) continue;
          if ((s.textContent || "").includes(bodyKey)) return s;
        }
      } catch {}
    }
    const rawSrc = st.currentScriptRawSrc;
    const matchNode = (node: Element | null | undefined): boolean => {
      if (!node || typeof node.tagName !== "string" || node.tagName.toUpperCase() !== "SCRIPT")
        return false;
      const a = node.getAttribute ? node.getAttribute("src") : null;
      return a != null && (a === rawSrc || a === src);
    };
    const domIndex = st.currentScriptDomIndex;
    try {
      const scripts = this.querySelectorAll("script");
      if (
        typeof domIndex === "number" &&
        domIndex >= 0 &&
        matchNode(scripts && scripts[domIndex])
      ) {
        return scripts[domIndex];
      }
      for (let i = 0; i < scripts.length; i++) {
        if (matchNode(scripts[i])) return scripts[i];
      }
    } catch {}
    // No live node matched. The synthetic node's src attribute is the
    // authored value, as on a real node.
    return getOrMakeSyntheticScript(src, rawSrc);
  }

  elementFromPoint(x: number, y: number): Element | null {
    const px = Number(x) || 0;
    const py = Number(y) || 0;
    if (hitTestViaPaint) {
      try {
        const id = hitTestViaPaint(px, py);
        if (id >= 0) return elementFor(id);
      } catch {}
    }
    const scroll = scrollOffset();
    const dx = px + scroll.x;
    const dy = py + scroll.y;
    if (layoutMode() === "off") {
      const id = cheapHit(dx, dy);
      if (id < 0) return null;
      return elementFor(id);
    }
    // A wasm panic unwinds and the DOM survives, so fall back to the cheap walker.
    // Returning null would route the click to body and the input would
    // never focus.
    try {
      const id = dom.elementFromPoint(dx, dy);
      if (id >= 0) return elementFor(id);
      // A clean miss: the cheap walker would just guess body.
      return null;
    } catch {
      // wasm panic.
    }
    try {
      const id = cheapHit(dx, dy);
      if (id >= 0) return elementFor(id);
    } catch {}
    return null;
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
    function stamp(node: NodeBase | null) {
      if (!node || typeof node !== "object") return;
      nodeOwnerDoc.set(node, doc);
      try {
        const kids = node.childNodes;
        if (kids) for (let i = 0; i < kids.length; i++) stamp(kids[i]);
      } catch {}
    }
    stamp(html);
    return doc;
  }
  createDocument(
    namespace: string | null,
    qualifiedName: string,
    doctype?: Idl.DocumentType | null,
  ): XMLDocument;
  createDocument(namespaceURI: unknown, qualifiedName: unknown, doctype?: unknown): XMLDocument {
    if (arguments.length < 2) {
      throw new TypeError("DOMImplementation.createDocument requires at least 2 arguments");
    }
    // WebIDL nullable DocumentType conversion.
    if (
      doctype !== undefined &&
      doctype !== null &&
      (typeof doctype !== "object" || (doctype as { nodeType?: unknown }).nodeType !== DOCTYPE_NODE)
    ) {
      throw new TypeError(
        "DOMImplementation.createDocument: doctype must be a DocumentType or null",
      );
    }
    const doc = new XMLDocument();
    // Later doc.createElement calls use this namespace; a null or empty
    // namespace means no namespace.
    const requestedNs = namespaceURI == null || namespaceURI === "" ? null : String(namespaceURI);
    Object.defineProperty(doc, "_createElementNs", {
      value: requestedNs,
      writable: false,
      enumerable: false,
    });
    if (doctype != null && typeof doctype === "object") {
      // The check above let only nodeType-10 objects through: a doctype.
      doc._topChildren.push(doctype as DocumentTypeNode);
      syntheticParent.set(doctype, doc);
      nodeOwnerDoc.set(doctype, doc);
    }
    // DOMString?: null and "" create no root element, undefined creates
    // <undefined>.
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
    return doc;
  }
  createDocumentType(qname: string, publicId: string, systemId: string): DocumentTypeNode {
    // The spec validates qname as a QName, but browsers only reject a
    // space, ">" or a C0 control character.
    const name = String(qname ?? "");
    for (let i = 0; i < name.length; i++) {
      const c = name.charCodeAt(i);
      if (c <= 0x1f || c === 0x20 || c === 0x3e) {
        throw new DOMException(
          "createDocumentType: '" + name + "' is not a valid qualified name",
          "InvalidCharacterError",
        );
      }
    }
    const synth: DocumentTypeNode = Object.create(DocumentTypeNode.prototype);
    Object.defineProperty(synth, "_info", {
      value: {
        nodeType: DOCTYPE_NODE,
        nodeName: name,
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
      value: name,
    });
    Object.defineProperty(synth, "publicId", {
      value: String(publicId ?? ""),
    });
    Object.defineProperty(synth, "systemId", {
      value: String(systemId ?? ""),
    });
    // The doctype belongs to the implementation's document, not the page's.
    if (this.#ownerDocument) {
      nodeOwnerDoc.set(synth, this.#ownerDocument);
    }
    return synth;
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
      | "location"
      | "modelContext"
      | Extract<keyof Idl.Document, `on${string}`>
      | SharedDocumentMember
    >,
    SharedDocumentTypeGaps {}

class DetachedDocument implements Idl.Document {
  // The constructor defines both as null own properties: a document has no
  // parent and no owner document.
  declare readonly parentNode: null;
  declare readonly ownerDocument: null;
  declare _hostId: number;
  declare _host: Element;
  declare _topChildren: NodeBase[];
  declare _cnList: NodeListCls<NodeBase> | undefined;
  declare _baseUrl: string;
  declare _contentType: string;
  declare _isHtml: boolean;
  declare _implementation: DOMImplementationCls | undefined;
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
    return documentBaseURI(this._baseUrl || "about:blank");
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
      value: mintedNode(hostId, ELEMENT_NODE),
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
  get childNodes(): NodeListCls<NodeBase> {
    if (!this._cnList) {
      const self = this;
      const list = makeNodeList(() => self._topChildren.slice());
      Object.defineProperty(this, "_cnList", {
        value: list,
        writable: false,
        enumerable: false,
      });
      return list;
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
  get documentElement(): Element | null {
    for (let i = 0; i < this._topChildren.length; i++) {
      const c = this._topChildren[i];
      if (isElementNode(c)) return c;
    }
    return null;
  }
  get doctype(): DocumentTypeNode | null {
    for (let i = 0; i < this._topChildren.length; i++) {
      const c = this._topChildren[i];
      if (isDoctypeNode(c)) return c;
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
    if (!node) {
      throw new TypeError(op + ": first argument is not a Node");
    }
    const nt = node.nodeType;
    // Step 2: a document has no ancestors, but inserting it into itself
    // still fails.
    if ((node as unknown) === this) {
      throw new DOMException(
        op + ": cannot insert a document into itself",
        "HierarchyRequestError",
      );
    }
    // Step 4: fragment, doctype, element, text, PI or comment.
    const okTypes =
      nt === DOCUMENT_FRAGMENT_NODE ||
      nt === DOCTYPE_NODE ||
      nt === ELEMENT_NODE ||
      nt === TEXT_NODE ||
      nt === PROCESSING_INSTRUCTION_NODE ||
      nt === COMMENT_NODE;
    if (!okTypes) {
      throw new DOMException(
        op + ": node type " + nt + " cannot be inserted",
        "HierarchyRequestError",
      );
    }
    // Step 5: no Text under a Document.
    if (nt === TEXT_NODE) {
      throw new DOMException(
        op + ": cannot insert a Text node directly under a document",
        "HierarchyRequestError",
      );
    }
    // Step 6 also keeps the doctype before the document element.
    const top = this._topChildren;
    // The existing element and doctype children, ignoring `child` on replace.
    let elementChild: NodeBase | null = null;
    let doctypeChild: NodeBase | null = null;
    for (let i = 0; i < top.length; i++) {
      const c = top[i];
      if (isReplace && c === child) continue;
      if (c.nodeType === ELEMENT_NODE && !elementChild) elementChild = c;
      if (c.nodeType === DOCTYPE_NODE && !doctypeChild) doctypeChild = c;
    }
    // A null child (append) sits past the end.
    const childIdx = child == null ? top.length : top.indexOf(child);
    function elementBeforeChildPosition() {
      for (let i = 0; i < childIdx; i++) {
        const c = top[i];
        if (isReplace && c === child) continue;
        if (c.nodeType === ELEMENT_NODE) return true;
      }
      return false;
    }
    function doctypeAfterChildPosition() {
      for (let i = childIdx + 1; i < top.length; i++) {
        const c = top[i];
        if (isReplace && c === child) continue;
        if (c.nodeType === DOCTYPE_NODE) return true;
      }
      return false;
    }
    if (nt === DOCUMENT_FRAGMENT_NODE) {
      let elemCount = 0;
      let hasText = false;
      for (let i = 0; i < node.childNodes.length; i++) {
        const c = node.childNodes[i];
        if (c.nodeType === ELEMENT_NODE) elemCount++;
        else if (c.nodeType === TEXT_NODE) hasText = true;
      }
      if (elemCount > 1 || hasText) {
        throw new DOMException(
          op + ": DocumentFragment has multiple elements or contains text",
          "HierarchyRequestError",
        );
      }
      if (elemCount === 1) {
        if (elementChild) {
          throw new DOMException(
            op + ": document already has a document element",
            "HierarchyRequestError",
          );
        }
        if (child != null && !isReplace) {
          if (child.nodeType === DOCTYPE_NODE) {
            throw new DOMException(
              op + ": cannot insert an element before the doctype",
              "HierarchyRequestError",
            );
          }
          if (doctypeAfterChildPosition()) {
            throw new DOMException(
              op + ": cannot insert an element before an existing doctype",
              "HierarchyRequestError",
            );
          }
        }
      }
      return;
    }
    if (nt === ELEMENT_NODE) {
      if (elementChild) {
        throw new DOMException(
          op + ": document already has a document element",
          "HierarchyRequestError",
        );
      }
      if (child != null && !isReplace) {
        if (child.nodeType === DOCTYPE_NODE) {
          throw new DOMException(
            op + ": cannot insert an element before the doctype",
            "HierarchyRequestError",
          );
        }
        if (doctypeAfterChildPosition()) {
          throw new DOMException(
            op + ": cannot insert an element before an existing doctype",
            "HierarchyRequestError",
          );
        }
      }
      return;
    }
    if (nt === DOCTYPE_NODE) {
      if (doctypeChild) {
        throw new DOMException(op + ": document already has a doctype", "HierarchyRequestError");
      }
      if (child != null) {
        if (elementBeforeChildPosition()) {
          throw new DOMException(
            op + ": cannot insert a doctype after the document element",
            "HierarchyRequestError",
          );
        }
      } else if (elementChild) {
        // Appending would put the doctype after the element.
        throw new DOMException(
          op + ": cannot append a doctype after the document element",
          "HierarchyRequestError",
        );
      }
      return;
    }
  }
  // The host child to insert before so host order matches _topChildren:
  // the next wasm-backed node from refIndex on, or null to append.
  _hostAnchorForInsertion(refIndex: number): NodeBase | null {
    const top = this._topChildren;
    for (let i = refIndex; i < top.length; i++) {
      const c = top[i];
      // Synthetic doctypes are not in the host tree.
      if (c && c.nodeType !== DOCTYPE_NODE && typeof c._id === "number" && c._id >= 0) {
        return c;
      }
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
    const curParent = node.parentNode;
    if (curParent && curParent !== this) {
      try {
        curParent.removeChild(node);
      } catch {}
    } else if (curParent === this) {
      // Re-appending a child moves it to the end.
      const idx = this._topChildren.indexOf(node);
      if (idx >= 0) {
        rangeBeforeRemove(this, idx, node);
        this._topChildren.splice(idx, 1);
      }
    }
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
    if (arguments.length < 2) {
      throw new TypeError(
        "insertBefore: 2 arguments required, but only " + arguments.length + " present",
      );
    }
    // The reference must be a Node or null.
    if (ref != null && (typeof ref !== "object" || typeof ref.nodeType !== "number")) {
      throw new TypeError("insertBefore: reference is not a Node");
    }
    if (node == null || typeof node !== "object" || typeof node.nodeType !== "number") {
      throw new TypeError("insertBefore: first argument is not a Node");
    }
    // Step 3's NotFoundError comes before the hierarchy checks of steps 4-6.
    if (ref != null && this._topChildren.indexOf(ref) < 0) {
      throw new DOMException(
        "insertBefore: reference child is not a child of this document",
        "NotFoundError",
      );
    }
    if (node.nodeType === DOCUMENT_FRAGMENT_NODE) {
      this._validateDocumentPreInsertion(node, ref, "insertBefore", false);
      const kids = Array.from<NodeBase>(node.childNodes);
      // Compute insertion index at validation time so subsequent
      // splices stay anchored to the original ref position.
      let insertIdx = ref == null ? this._topChildren.length : this._topChildren.indexOf(ref);
      for (const k of kids) {
        this._insertOneAtIndex(k, insertIdx);
        insertIdx++;
      }
      return node;
    }
    this._validateDocumentPreInsertion(node, ref, "insertBefore", false);
    let insertIdx = ref == null ? this._topChildren.length : this._topChildren.indexOf(ref);
    this._insertOneAtIndex(node, insertIdx);
    return node;
  }
  _insertOneAtIndex(node: NodeBase, idx: number): void {
    const curParent = node.parentNode;
    if (curParent && curParent !== this) {
      try {
        curParent.removeChild(node);
      } catch {}
    } else if (curParent === this) {
      const existing = this._topChildren.indexOf(node);
      if (existing >= 0) {
        rangeBeforeRemove(this, existing, node);
        this._topChildren.splice(existing, 1);
        if (existing < idx) idx--;
      }
    }
    // A doctype has no wasm parent, so syntheticParent gives it one.
    nodeOwnerDoc.set(node, this);
    if (node.nodeType === DOCTYPE_NODE) {
      this._topChildren.splice(idx, 0, node);
      syntheticParent.set(node, this);
    } else {
      this._topChildren.splice(idx, 0, node);
      const hostAnchor = this._hostAnchorForInsertion(idx + 1);
      if (hostAnchor) {
        this._host.insertBefore(node, hostAnchor);
      } else {
        this._host.appendChild(node);
      }
    }
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
    if (oldNode == null || this._topChildren.indexOf(oldNode) < 0) {
      throw new DOMException(
        "replaceChild: old child is not a child of this document",
        "NotFoundError",
      );
    }
    if (newNode && newNode.nodeType === DOCUMENT_FRAGMENT_NODE) {
      this._validateDocumentPreInsertion(newNode, oldNode, "replaceChild", true);
    } else {
      this._validateDocumentPreInsertion(newNode, oldNode, "replaceChild", true);
    }
    if (newNode === oldNode) return oldNode;
    const oldIdx = this._topChildren.indexOf(oldNode);
    rangeBeforeRemove(this, oldIdx, oldNode);
    this._topChildren.splice(oldIdx, 1);
    if (oldNode.nodeType !== DOCTYPE_NODE) {
      try {
        this._host.removeChild(oldNode);
      } catch {}
    }
    if (newNode.nodeType === DOCUMENT_FRAGMENT_NODE) {
      const kids = Array.from<NodeBase>(newNode.childNodes);
      let insertIdx = oldIdx;
      for (const k of kids) {
        this._insertOneAtIndex(k, insertIdx);
        insertIdx++;
      }
    } else {
      this._insertOneAtIndex(newNode, oldIdx);
    }
    return oldNode;
  }
  // Document children may contain one Element and one DocumentType, with
  // the Element first; Text children are forbidden. Validate before the
  // host converts string arguments, then mirror accepted nodes into
  // _topChildren because childNodes reads that list.
  append(...nodes: Array<NodeBase | string>) {
    assertDocumentInsertAllowed(this, nodes, "append", /*atFront*/ false);
    this._host.append(...nodes);
    // assertDocumentInsertAllowed rejected any string (a Text child).
    for (const n of nodes) if (typeof n !== "string") this._topChildren.push(n);
  }
  prepend(...nodes: Array<NodeBase | string>) {
    assertDocumentInsertAllowed(this, nodes, "prepend", /*atFront*/ true);
    this._host.prepend(...nodes);
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (typeof n !== "string") this._topChildren.unshift(n);
    }
  }
  replaceChildren(...nodes: Array<NodeBase | string>) {
    // Validate against the current children before removing them, as
    // required by the ensure-pre-insertion-validity steps.
    assertDocumentInsertAllowed(
      this,
      nodes,
      "replaceChildren",
      /*atFront*/ false,
      /*ignoreExisting*/ false,
    );
    this._host.replaceChildren(...nodes);
    this._topChildren.length = 0;
    for (const n of nodes) if (typeof n !== "string") this._topChildren.push(n);
  }
  // DetachedDocument does not extend NodeBase, so it defines the Node
  // identity, comparison and namespace methods itself.
  isSameNode(other: Idl.Node | null) {
    if (!other) return false;
    return this === other;
  }
  compareDocumentPosition(other: Idl.Node) {
    return compareDocumentPosition(this, other);
  }
  // Adoption targets this detached document rather than the live page Document.
  adoptNode(node: NodeBase) {
    if (node == null || typeof node !== "object") {
      throw new TypeError("adoptNode: argument must be a Node");
    }
    if (node.nodeType === DOCUMENT_NODE) {
      throw new DOMException("adoptNode: cannot adopt a Document", "NotSupportedError");
    }
    // Adopting a shadow root is a HierarchyRequestError.
    if (isShadowRootNode(node)) {
      throw new DOMException("adoptNode: cannot adopt a ShadowRoot", "HierarchyRequestError");
    }
    const parent = node.parentNode;
    if (parent) {
      try {
        parent.removeChild(node);
      } catch {}
    }
    const targetIsXml = !this._isHtml;
    const stamp = (n: NodeBase | null) => {
      if (!n || typeof n !== "object") return;
      nodeOwnerDoc.set(n, this);
      if (n.nodeType === DOCTYPE_NODE) {
        syntheticParent.delete(n);
      }
      if (n.nodeType === ELEMENT_NODE && typeof n._id === "number" && n._id >= 0) {
        if (targetIsXml) {
          xmlOwned.add(n._id);
          // XML tagName casing lives in xmlOwned, so the node must never
          // take the fast path (fastpath.ts).
          fastpathMarkSpecial(n._id);
        } else {
          xmlOwned.delete(n._id);
        }
      }
      try {
        const kids = n.childNodes;
        if (kids) for (let i = 0; i < kids.length; i++) stamp(kids[i]);
      } catch {}
    };
    stamp(node);
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
    const a = this.childNodes;
    const b = other.childNodes;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const ai = a[i],
        bi = b[i];
      if (!ai || !bi) return ai === bi;
      if (typeof ai.isEqualNode !== "function") return false;
      if (!ai.isEqualNode(bi)) return false;
    }
    return true;
  }
  cloneNode(deep?: boolean): DetachedDocument {
    const c = new DetachedDocument();
    if (this._contentType) {
      Object.defineProperty(c, "_contentType", {
        value: this._contentType,
        enumerable: false,
      });
    }
    if (this._baseUrl) {
      Object.defineProperty(c, "_baseUrl", {
        value: this._baseUrl,
        enumerable: false,
      });
    }
    if (deep) {
      for (const child of this.childNodes) {
        if (child && typeof child.cloneNode === "function") {
          c.append(cloneWrapper(child, true));
        }
      }
    }
    return c;
  }
  // Inclusive descendant check. The document itself is not in the host's
  // parent chain, so self needs its own check.
  contains(other: Idl.Node | null) {
    if (other === this) return true;
    if (other == null) return false;
    // A synthetic doctype is not in the wasm parent chain.
    if (this._topChildren && (this._topChildren as readonly unknown[]).indexOf(other) >= 0) {
      return true;
    }
    // Wasm-backed descendants reach _hostId through their parent chain.
    const otherId = (other as { _id?: unknown })._id;
    if (typeof otherId !== "number") return false;
    try {
      if (otherId === this._hostId) return true;
      let cur = otherId;
      let safety = 0;
      while (safety < MAX_NODE_ANCESTOR_HOPS) {
        let p;
        try {
          p = dom.parentId(cur);
        } catch {
          return false;
        }
        if (p < 0 || p === cur) return false;
        if (p === this._hostId) return true;
        cur = p;
        safety++;
      }
    } catch {}
    return false;
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
    const attr: AttrCls = Object.create(AttrCls.prototype);
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
  createProcessingInstruction(target: string, data: string): TextNode & Idl.ProcessingInstruction {
    validatePIArgs(target, data);
    const t = createTextNodeInternal(String(data ?? ""));
    Object.defineProperty(t, "nodeType", { value: 7, enumerable: false });
    Object.defineProperty(t, "nodeName", {
      value: String(target ?? ""),
      enumerable: false,
    });
    Object.defineProperty(t, "target", {
      value: String(target ?? ""),
    });
    // Mark id as a PI so Element.textContent skips its data.
    if (t && t._id != null && t._id >= 0) stampedPiIds.add(t._id);
    nodeOwnerDoc.set(t, this);
    // The stamps above make the text node a processing instruction.
    return t as TextNode & Idl.ProcessingInstruction;
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
  get head(): Element | null {
    const root = this.documentElement;
    if (!root) return null;
    try {
      const h = root.querySelector ? root.querySelector("head") : null;
      if (h) return h;
    } catch {}
    return null;
  }
  // The first <body> under documentElement, or null.
  get body(): Element | null {
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
    const root = this.documentElement;
    if (!root) return "";
    try {
      const t = root.querySelector ? root.querySelector("title") : null;
      if (t) return (t.textContent || "").replace(/[\s]+/g, " ").trim();
    } catch {}
    return "";
  }
  set title(v) {
    const root = this.documentElement;
    if (!root) return;
    let t: Element | null = null;
    try {
      t = root.querySelector ? root.querySelector("title") : null;
    } catch {}
    if (!t) {
      // No <title>: create one in <head>, or in documentElement without one.
      try {
        t = this.createElement("title");
        let head: Element | null = null;
        try {
          head = root.querySelector ? root.querySelector("head") : null;
        } catch {}
        (head || root).appendChild(t);
      } catch {}
    }
    if (t) t.textContent = v == null ? "" : String(v);
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
        return this._host.querySelectorAll(`[name=${cssString(t)}]`);
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
function bodyColor(body: Element | null, attribute: string): string {
  return body ? body.getAttribute(attribute) || "" : "";
}
function setBodyColor(body: Element | null, attribute: string, value: string | null): void {
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
    const colon = qn.indexOf(":");
    const prefix = colon >= 0 ? qn.slice(0, colon) : null;
    const local = colon >= 0 ? qn.slice(colon + 1) : qn;
    if (prefix && !ns) {
      throw new DOMException("createAttributeNS: prefix without namespace", "NamespaceError");
    }
    if (prefix === "xml" && ns !== XML_NS) {
      throw new DOMException(
        "createAttributeNS: xml prefix requires XML namespace",
        "NamespaceError",
      );
    }
    const isXmlnsNs = ns === XMLNS_NS;
    if ((qn === "xmlns" || prefix === "xmlns") !== isXmlnsNs) {
      throw new DOMException("createAttributeNS: xmlns qname/prefix mismatch", "NamespaceError");
    }
    const attr: AttrCls = Object.create(AttrCls.prototype);
    attr._name = qn;
    attr._value = "";
    attr._nodeValue = "";
    attr._textContent = "";
    attr._namespaceURI = ns;
    attr._prefix = prefix;
    attr._localName = local;
    attr._ownerElement = null;
    return attr;
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
    if (!el) return "";
    // Every element wrapper is an HTMLElement, which has dir.
    const dir: unknown = Reflect.get(el, "dir");
    return typeof dir === "string" ? dir : "";
  },
  set dir(value: string) {
    const el = this.documentElement;
    if (el) Reflect.set(el, "dir", value);
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
    return v != null && XMLDocument.prototype.isPrototypeOf(v);
  }
}

Object.defineProperty(DetachedDocument.prototype, "importNode", {
  value: function importNode(node: unknown, deep?: unknown) {
    if (node === null || typeof node !== "object") {
      throw new TypeError("importNode: node must be a Node");
    }
    if ("nodeType" in node && node.nodeType === DOCUMENT_NODE) {
      throw new DOMException("importNode: cannot import a Document", "NotSupportedError");
    }
    if (isShadowRootNode(node)) {
      throw new DOMException("importNode: cannot import a ShadowRoot", "NotSupportedError");
    }
    if ("cloneNode" in node && typeof node.cloneNode === "function") {
      return node.cloneNode(Boolean(deep));
    }
    throw new TypeError("importNode: node must be a Node");
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

ksInternals.formBehindProxy = formBehindProxy;

// For page-script's HTMLElement constructor: a wrapper with no upgrade.
// `new CustomElementCtor()` already runs the user constructor, and a
// second run throws when V8 re-initializes private fields.
ksInternals.createElementNoUpgrade = (tag: string) => {
  try {
    const id = dom.createElement(String(tag).toLowerCase());
    return nodeFor(id);
  } catch {
    return null;
  }
};
