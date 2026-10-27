// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements DOM collections, scoped query results, and the CSSOM wrappers used by the shim.

import type * as Idl from "./idl/types.generated.js";
import {
  CSSStyleDeclarationCls,
  makeStyleDeclaration,
  type StyleDeclaration,
  type StyleDeclarationBackend,
} from "./style-declaration.js";
import {
  ksGlobal,
  dom,
  pageUrl,
  liveDocument,
  windowObj,
  elementFor,
  elementDocument,
  setCollectionsClasses,
  shadowRootModes,
  DOCUMENT_ID,
  getExternalSheetRules,
  opts,
  parseCounterStyleRule,
  createElementInternal,
  createDocumentFragmentInternal,
  type RuleStyleDeclarationStore,
  type NodeListSeqKey,
} from "./state.js";
import { recordOp } from "./record.js";
import {
  elemNs,
  elementOwnerIsHtml,
  fragmentIds,
  nodeListGetters,
  htmlCollectionGetters,
  sheetCache,
  hasLiveWrapper,
} from "./registries.js";
import { getInternalState } from "./internal-state.js";
import { ATTRIBUTE_NODE, ELEMENT_NODE, DOCUMENT_FRAGMENT_NODE, HTML_NS } from "./constants.js";
import {
  cssPropCamelToKebab,
  cssPropToCamel,
  styleDeclKey,
  parseCssTextInto,
  serializeStyleData,
  cssEscape,
} from "./util/strings.js";
import { bumpMutationSeq } from "./mutations/seq.js";
import { recordAttributeMutation } from "./mutations/observer.js";
import { Element, HTMLInputElement } from "./element/index.js";
import type { HTMLOptionElement, HTMLSelectElement } from "./element/forms/select.js";
import type { NodeBase, WrapperInfo } from "./node-base.js";
import type { ParsedElement } from "./parser.js";
import { dropUnwrappedSubtrees } from "./node-base.js";
import { makeStylePropertyMap } from "./css-typed-om.js";

function ksState() {
  return getInternalState();
}

type AttrOwnNodeMembers =
  | "nodeValue"
  | "textContent"
  | "nodeName"
  | "nodeType"
  | "baseURI"
  | "isSameNode"
  | "isEqualNode"
  | "cloneNode";
interface AttrCls extends Omit<Idl.Node, AttrOwnNodeMembers> {}
class AttrCls implements Idl.Attr {
  declare _value: string;
  declare _name: string;
  declare _namespaceURI: string | null;
  declare _prefix: string | null;
  declare _localName: string;
  declare _nodeValue: string;
  declare _textContent: string;
  declare _ownerElement: Element | null;
  get value() {
    return this._value;
  }
  set value(v) {
    const next = v == null ? "" : String(v);
    const oldValue = this._value;
    this._value = next;
    this._nodeValue = next;
    this._textContent = next;
    const owner = this._ownerElement;
    if (owner && typeof owner.setAttribute === "function") {
      recordOp({
        kind: "setAttribute",
        node: owner._id,
        name: this._name,
        value: next,
      });
      recordAttributeMutation(owner._id, this._name, this._namespaceURI || null, oldValue);
    }
  }
  get nodeValue() {
    return this._nodeValue;
  }
  set nodeValue(v) {
    this.value = v;
  }
  get textContent() {
    return this._textContent;
  }
  set textContent(v) {
    this.value = v;
  }
  get name() {
    return this._name;
  }
  get nodeName() {
    return this._name;
  }
  get namespaceURI() {
    return this._namespaceURI;
  }
  get prefix() {
    return this._prefix;
  }
  get localName() {
    return this._localName;
  }
  get specified() {
    return true;
  }
  get ownerElement() {
    return this._ownerElement;
  }
  get nodeType() {
    return 2;
  }
  isSameNode(other: Idl.Node | null) {
    if (!other) return false;
    return this === other;
  }
  isEqualNode(other: Idl.Node | null) {
    if (!other || other.nodeType !== ATTRIBUTE_NODE) return false;
    // Any ATTRIBUTE_NODE object compares by these slots, as an Attr does.
    const o = other as Partial<Pick<AttrCls, "_namespaceURI" | "_localName" | "_value">>;
    return (
      this._namespaceURI === o._namespaceURI &&
      this._localName === o._localName &&
      this._value === o._value
    );
  }
  get baseURI(): string {
    const owner = this._ownerElement;
    if (owner && typeof owner.baseURI === "string") return owner.baseURI;
    try {
      if (windowObj && windowObj.document) {
        const u = windowObj.document.baseURI;
        if (typeof u === "string") return u;
      }
    } catch {}
    // Attrs exist only once buildDocument has built the window, so this
    // is unreachable from page code; it answers what the document would.
    return pageUrl;
  }
  cloneNode(_deep?: boolean) {
    const a: AttrCls = Object.create(AttrCls.prototype);
    a._name = this._name;
    a._value = this._value;
    a._nodeValue = this._nodeValue;
    a._textContent = this._textContent;
    a._namespaceURI = this._namespaceURI;
    a._prefix = this._prefix;
    a._localName = this._localName;
    a._ownerElement = null;
    return a;
  }
  lookupNamespaceURI(prefix: string | null) {
    const owner = this._ownerElement;
    if (!owner) return null;
    return owner.lookupNamespaceURI(prefix);
  }
  lookupPrefix(namespace: string | null) {
    const owner = this._ownerElement;
    if (!owner) return null;
    return owner.lookupPrefix(namespace);
  }
  isDefaultNamespace(namespace: string | null) {
    const ns = namespace === "" ? null : namespace;
    return this.lookupNamespaceURI(null) === ns;
  }
}

// ----- NodeList -----------------------------------------------------------
// Live per-wrapper list; the proxy reflects current tree state. WPT checks
// Array.prototype method identity, and internal callers use aliases like findIndex.
// T is the item type: NodeBase for the shim's own lists, Element for selector matches.
class NodeListCls<T extends Idl.Node = Idl.Node> implements Idl.NodeList {
  readonly [index: number]: T;
  declare readonly length: number;
  declare [Symbol.iterator]: () => ArrayIterator<T>;
  declare keys: T[]["keys"];
  declare values: T[]["values"];
  declare entries: T[]["entries"];
  declare forEach: T[]["forEach"];
  declare findIndex: T[]["findIndex"];
  declare find: T[]["find"];
  declare indexOf: T[]["indexOf"];
  declare includes: T[]["includes"];
  declare map: T[]["map"];
  declare filter: T[]["filter"];
  declare slice: T[]["slice"];
  declare some: T[]["some"];
  declare every: T[]["every"];
  declare reduce: T[]["reduce"];
  declare concat: T[]["concat"];
  item(index: number): Idl.Node | null {
    const list = nodeListGetters.get(this);
    if (!list) return null;
    const arr = list();
    const idx = Number(index) >>> 0;
    return idx >= 0 && idx < arr.length ? arr[idx] : null;
  }
}
NodeListCls.prototype[Symbol.iterator] = Array.prototype[Symbol.iterator];
NodeListCls.prototype.keys = Array.prototype.keys;
NodeListCls.prototype.values = Array.prototype.values;
NodeListCls.prototype.entries = Array.prototype.entries;
NodeListCls.prototype.forEach = Array.prototype.forEach;
NodeListCls.prototype.findIndex = Array.prototype.findIndex;
NodeListCls.prototype.find = Array.prototype.find;
NodeListCls.prototype.indexOf = Array.prototype.indexOf;
NodeListCls.prototype.includes = Array.prototype.includes;
NodeListCls.prototype.map = Array.prototype.map;
NodeListCls.prototype.filter = Array.prototype.filter;
NodeListCls.prototype.slice = Array.prototype.slice;
NodeListCls.prototype.some = Array.prototype.some;
NodeListCls.prototype.every = Array.prototype.every;
NodeListCls.prototype.reduce = Array.prototype.reduce;
NodeListCls.prototype.concat = Array.prototype.concat;

// Child lists pass seqKey "childSeq" so attribute writes do not force a rebuild.
// cls picks the list's interface: NodeList, or a subclass such as
// RadioNodeList.
/**
 * Creates a live NodeList; contents refresh when the selected mutation sequence changes.
 */
function makeNodeList<T extends NodeBase = NodeBase>(
  getList: () => T[],
  seqKey?: NodeListSeqKey,
): NodeListCls<T>;
function makeNodeList<L extends NodeListCls>(
  getList: () => NodeBase[],
  seqKey: NodeListSeqKey,
  cls: { prototype: L },
): L;
function makeNodeList(
  getList: () => NodeBase[],
  seqKey: NodeListSeqKey = "mutationSeq",
  cls: { prototype: NodeListCls } = NodeListCls,
): NodeListCls {
  const target: NodeListCls = Object.create(cls.prototype);
  // Cache contents per mutation sequence so `.length` plus indexed reads
  // share one wasm call and wrapper walk; the next mutation invalidates it.
  let cachedList: NodeBase[] | null = null;
  let cachedSeq = -1;
  function memoGetList() {
    const curSeq = ksState()[seqKey] | 0;
    if (cachedList !== null && cachedSeq === curSeq) return cachedList;
    cachedList = getList();
    cachedSeq = curSeq;
    return cachedList;
  }
  const proxy = new Proxy(target, {
    get(t, prop, receiver) {
      if (prop === "length") return memoGetList().length;
      if (typeof prop === "string" && /^\d+$/.test(prop)) {
        const i = +prop;
        const list = memoGetList();
        return i < list.length ? list[i] : undefined;
      }
      return Reflect.get(t, prop, receiver);
    },
    // The indexes and length are read-only; false makes a strict-mode write
    // throw. Any other write is an ordinary set, so RadioNodeList's value
    // setter runs and an expando lands on the target.
    set(t, prop, value, receiver) {
      if (prop === "length" || (typeof prop === "string" && /^\d+$/.test(prop))) return false;
      return Reflect.set(t, prop, value, receiver);
    },
    has(t, prop) {
      if (prop === "length") return true;
      if (typeof prop === "string" && /^\d+$/.test(prop)) {
        return +prop < memoGetList().length;
      }
      return prop in t;
    },
    // The target's own keys are the page's expandos. A Proxy must list them,
    // since Object.defineProperty makes them non-configurable by default.
    ownKeys(t) {
      const list = memoGetList();
      const keys: (string | symbol)[] = [];
      for (let i = 0; i < list.length; i++) keys.push(String(i));
      keys.push("length");
      const seen = new Set(keys);
      for (const key of Reflect.ownKeys(t)) {
        if (!seen.has(key)) keys.push(key);
      }
      return keys;
    },
    getOwnPropertyDescriptor(t, prop) {
      if (prop === "length") {
        return {
          value: memoGetList().length,
          writable: false,
          enumerable: false,
          configurable: true,
        };
      }
      if (typeof prop === "string" && /^\d+$/.test(prop)) {
        const i = +prop;
        const list = memoGetList();
        if (i < list.length) {
          return {
            value: list[i],
            writable: false,
            enumerable: true,
            configurable: true,
          };
        }
      }
      return Reflect.getOwnPropertyDescriptor(t, prop);
    },
  });
  nodeListGetters.set(target, memoGetList);
  nodeListGetters.set(proxy, memoGetList);
  return proxy;
}

// DocumentFragment wrappers use a detached div as backing storage and track
// its ID so nodeFor recreates the fragment wrapper.
class DocumentFragmentImpl extends Element implements Idl.DocumentFragment {
  // A page-created fragment needs its own backing div. Without this
  // constructor, Element's `(nodeId, info)` setup reads node 0 (`<html>`) as
  // its first child instead of the fragment child.
  // The constructor WPT checks that an appended Text becomes `firstChild`.
  constructor(nodeId?: number, info?: WrapperInfo) {
    if (typeof nodeId === "number" && info) {
      super(nodeId, info);
    } else {
      const id = dom.createElement("div");
      fragmentIds.add(id);
      // A node created a line above always has a snapshot.
      const created = dom.nodeInfo(id);
      if (!created) throw new TypeError("dom-shim: new fragment node has no info");
      super(id, created);
    }
  }
  get nodeType() {
    return DOCUMENT_FRAGMENT_NODE;
  }
  get nodeName() {
    return "#document-fragment";
  }
  cloneNode(deep?: boolean) {
    const clone = createDocumentFragmentInternal();
    if (deep) {
      for (const child of Array.from(this.childNodes)) {
        if (child && typeof child.cloneNode === "function") {
          clone.appendChild(child.cloneNode(true));
        }
      }
    }
    return clone;
  }
  getElementById(elementId: string): Idl.Element | null {
    const key = String(elementId);
    if (key === "") return null;
    try {
      const matches = scopedQuerySelectorAll(this._id, `[id="${cssEscape(key)}"]`);
      for (const n of matches) {
        if (n && n.nodeType === ELEMENT_NODE) {
          // SAFETY: the wasm selector returns only element IDs.
          return n as Idl.Element;
        }
      }
    } catch {}
    return null;
  }
}

// tagName is not defined on DocumentFragment per spec — it's inherited
// from Element which reads from wasm. Force undefined. Defined here, not
// as a class getter, because Element types tagName as a string.
Object.defineProperty(DocumentFragmentImpl.prototype, "tagName", {
  get: function tagName() {
    return undefined;
  },
  enumerable: false,
  configurable: true,
});

// A shadow root backed by the wasm ShadowRoot node (attachShadow). It
// extends the fragment class so nodeType, nodeName and the queries fit.
// ShadowRoot has no constructor, so `new ShadowRoot()` throws; internal
// mints flip a one-shot token (mintShadowRoot).
let __shadowRootAllowConstruct = false;
// root.styleSheets is [SameObject].
const shadowStyleSheets = new WeakMap<ShadowRootImpl, EmptyStyleSheetList>();
class ShadowRootImpl extends DocumentFragmentImpl implements Idl.ShadowRoot {
  constructor(nodeId: number, info: WrapperInfo) {
    if (!__shadowRootAllowConstruct) {
      throw new TypeError("Illegal constructor");
    }
    __shadowRootAllowConstruct = false;
    super(nodeId, info);
  }
  get host(): Element | null {
    const hostId = dom.shadowHostId(this._id);
    return hostId >= 0 ? elementFor(hostId) : null;
  }
  get mode() {
    return shadowRootModes.get(this._id) || "open";
  }
  // wasm keeps the host as the parent for traversal; the DOM shows none.
  get parentNode() {
    return null;
  }
  get parentElement() {
    return null;
  }
  // https://dom.spec.whatwg.org/#concept-node-clone
  cloneNode(_deep?: boolean): never {
    throw new DOMException("ShadowRoot nodes are not clonable", "NotSupportedError");
  }
  // Only named slot assignment is implemented; the other options report
  // their defaults.
  get delegatesFocus() {
    return false;
  }
  get slotAssignment(): Idl.SlotAssignmentMode {
    return "named";
  }
  get clonable() {
    return false;
  }
  get serializable() {
    return false;
  }
  // Focus inside shadow trees is not modelled.
  get activeElement() {
    return null;
  }
  // Per-shadow-root sheets are not enumerated, so the list is always empty.
  get styleSheets(): EmptyStyleSheetList {
    let sheets = shadowStyleSheets.get(this);
    if (!sheets) {
      sheets = new EmptyStyleSheetList();
      shadowStyleSheets.set(this, sheets);
    }
    return sheets;
  }
}

// The minimal StyleSheetList shape a shadow root's styleSheets needs.
class EmptyStyleSheetList implements Idl.StyleSheetList {
  readonly length = 0;
  readonly [index: number]: Idl.CSSStyleSheet;
  item(_i: number): Idl.CSSStyleSheet | null {
    return null;
  }
  [Symbol.iterator](): Iterator<Idl.CSSStyleSheet> {
    return [][Symbol.iterator]();
  }
}

function mintShadowRoot(nodeId: number, info: WrapperInfo): ShadowRootImpl {
  __shadowRootAllowConstruct = true;
  return new ShadowRootImpl(nodeId, info);
}

// ----- scoped query helpers ---------------------------------------------

// HTMLCollection exposes IDs for all elements and names for HTML elements.
// Its live getter stays in a WeakMap so proxy reflection never exposes it.
function htmlCollectionFn(target: object, name: string): () => Element[] {
  const fn = htmlCollectionGetters.get(target);
  if (!fn) {
    throw new TypeError(
      "Illegal invocation: HTMLCollection." + name + " called on incompatible receiver",
    );
  }
  return fn;
}
// The proxy in makeHtmlCollection serves the indexed and named reads.
class HtmlCollectionCls implements Idl.HTMLCollection {
  readonly [index: number]: Element;
  item(index: number): Element | null {
    const list = htmlCollectionFn(this, "item")();
    // WebIDL unsigned long: NaN and other non-numbers become 0.
    const idx = Number(index) >>> 0;
    return idx >= 0 && idx < list.length ? list[idx] : null;
  }
  // The first element whose id is name, else the first exposing that name.
  // The empty string is never a supported name.
  namedItem(name: string): Element | null {
    const key = String(name);
    if (key === "") return null;
    const list = htmlCollectionFn(this, "namedItem")();
    for (const el of list) {
      if (el.getAttribute && el.getAttribute("id") === key) return el;
    }
    for (const el of list) {
      if (!htmlCollectionExposesName(el)) continue;
      if (el.getAttribute && el.getAttribute("name") === key) return el;
    }
    return null;
  }
  get length() {
    return htmlCollectionFn(this, "length")().length;
  }
  [Symbol.iterator](): ArrayIterator<Element> {
    return htmlCollectionFn(this, "@@iterator")()[Symbol.iterator]();
  }
  get [Symbol.toStringTag](): string {
    return "HTMLCollection";
  }
}
// The elements whose id, or name where the element exposes one, is key,
// in tree order.
function namedMatches(list: Element[], key: string): Element[] {
  const out: Element[] = [];
  const seen = new Set<Element>();
  for (const el of list) {
    if (!el || !el.getAttribute) continue;
    const isMatch =
      el.getAttribute("id") === key ||
      (htmlCollectionExposesName(el) && el.getAttribute("name") === key);
    if (isMatch && !seen.has(el)) {
      seen.add(el);
      out.push(el);
    }
  }
  return out;
}

// Repeated form-control names produce a live RadioNodeList whose value reads
// or sets the checked radio, even when other members are not radios.
class HTMLFormControlsCollectionCls
  extends HtmlCollectionCls
  implements Idl.HTMLFormControlsCollection
{
  get [Symbol.toStringTag](): string {
    return "HTMLFormControlsCollection";
  }
  // https://html.spec.whatwg.org/#dom-htmlformcontrolscollection-nameditem
  // The IDL widens HTMLCollection's return type, which a TypeScript override
  // can't do; the first signature repeats the base one so the class still
  // extends it.
  namedItem(name: string): Element | null;
  namedItem(name: string): Idl.RadioNodeList | Element | null;
  namedItem(name: string): Idl.RadioNodeList | Element | null {
    const key = String(name);
    if (key === "") return null;
    const getList = htmlCollectionFn(this, "namedItem");
    const matches = namedMatches(getList(), key);
    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0];
    // A RadioNodeList even when the matches aren't all radios.
    return makeNodeList(() => namedMatches(getList(), key), "mutationSeq", RadioNodeListCls);
  }
}
// The named property read uses this even if the page replaces the method.
const formControlsNamedItem = HTMLFormControlsCollectionCls.prototype.namedItem;

// select.options stores its owner under a hidden symbol; length and indexed
// writes resize, replace, or remove options through the capped setter.
const OPTIONS_OWNER_SYM = Symbol("optionsOwner");
class HTMLOptionsCollectionCls extends HtmlCollectionCls implements Idl.HTMLOptionsCollection {
  declare readonly [OPTIONS_OWNER_SYM]?: HTMLSelectElement;
  // The owner <select>'s list holds only its options.
  readonly [index: number]: HTMLOptionElement;
  get [Symbol.toStringTag](): string {
    return "HTMLOptionsCollection";
  }
  // The IDL redeclares length with a setter. The proxy's traps answer
  // reads and writes on a collection; these serve the prototype.
  get length() {
    return htmlCollectionFn(this, "length")().length;
  }
  set length(v: number) {
    const select = this[OPTIONS_OWNER_SYM];
    if (select) optionsCollectionSet(select, "length", v, htmlCollectionFn(this, "length")());
  }
  get selectedIndex(): number {
    const select = this[OPTIONS_OWNER_SYM];
    return select ? select.selectedIndex : -1;
  }
  set selectedIndex(v: number) {
    const select = this[OPTIONS_OWNER_SYM];
    if (select) select.selectedIndex = v;
  }
  // Keep the WebIDL signature; runtime compatibility is based on tagName, not a brand check.
  add(
    item: Idl.HTMLOptionElement | Idl.HTMLOptGroupElement,
    before?: Idl.HTMLElement | number | null,
  ): void {
    const select = this[OPTIONS_OWNER_SYM];
    if (!select) {
      throw new TypeError("HTMLOptionsCollection.add: missing owner select");
    }
    const tag = item && typeof item.tagName === "string" ? item.tagName.toLowerCase() : "";
    if (tag !== "option" && tag !== "optgroup") {
      throw new TypeError(
        "HTMLOptionsCollection.add: argument must be HTMLOptionElement or HTMLOptGroupElement",
      );
    }
    if (before === item) return;
    let refNode: Idl.Element | null = null;
    if (before == null) {
      refNode = null;
    } else if (typeof before === "number") {
      let idx = Number(before) | 0;
      const list = htmlCollectionGetters.get(this)?.();
      if (Array.isArray(list) && idx >= 0 && idx < list.length) {
        refNode = list[idx];
      }
    } else {
      refNode = before;
    }
    if (refNode) {
      let p = refNode.parentNode;
      let isDesc = false;
      while (p) {
        if (p === select) {
          isDesc = true;
          break;
        }
        p = p.parentNode;
      }
      if (!isDesc) {
        const DEx = ksGlobal.DOMException || Error;
        throw new DEx(
          "HTMLOptionsCollection.add: before is not a descendant of the select",
          "NotFoundError",
        );
      }
      // SAFETY: the ancestor walk validates normal nodes; keep the second read
      // so page-overridden parentNode getters retain their behavior.
      (refNode.parentNode as Idl.Node).insertBefore(item, refNode);
    } else {
      select.appendChild(item);
    }
  }
  remove(index: number): void {
    const select = this[OPTIONS_OWNER_SYM];
    if (!select) return;
    const i = Number(index) | 0;
    const list = htmlCollectionGetters.get(this)?.();
    if (Array.isArray(list) && i >= 0 && i < list.length) {
      const o = list[i];
      if (o && o.parentNode) o.parentNode.removeChild(o);
    }
  }
}

const OPTIONS_COLLECTION_MAX = 100_000;
function optionsCollectionSet(
  select: HTMLSelectElement,
  prop: string,
  value: unknown,
  list: Element[],
) {
  const doc = elementDocument(select);
  if (prop === "length") {
    const n = Math.min(OPTIONS_COLLECTION_MAX, Number(value) >>> 0);
    const cur = list.length;
    if (n > cur) {
      for (let i = cur; i < n; i++) {
        select.appendChild(doc.createElement("option"));
      }
    } else if (n < cur) {
      for (let i = cur - 1; i >= n; i--) {
        const o = list[i];
        if (o && o.parentNode) o.parentNode.removeChild(o);
      }
    }
    return true;
  }
  const idx = Number(prop) >>> 0;
  if (value === null || value === undefined) {
    const o = list[idx];
    if (o && o.parentNode) o.parentNode.removeChild(o);
    return true;
  }
  const tagName: unknown = value ? Reflect.get(Object(value), "tagName") : undefined;
  const tag = typeof tagName === "string" ? tagName.toLowerCase() : "";
  if (tag !== "option") {
    throw new TypeError("HTMLOptionsCollection: indexed value must be an HTMLOptionElement");
  }
  // SAFETY: the existing tag-name check accepts option-shaped values without branding them.
  const option = value as HTMLOptionElement;
  if (idx < list.length) {
    const o = list[idx];
    if (o && o.parentNode) o.parentNode.replaceChild(option, o);
  } else {
    const capped = Math.min(OPTIONS_COLLECTION_MAX, idx);
    for (let i = list.length; i < capped; i++) {
      select.appendChild(doc.createElement("option"));
    }
    if (idx <= OPTIONS_COLLECTION_MAX) select.appendChild(option);
  }
  return true;
}

// RadioNodeList is returned for repeated form-control names. Its value reads
// or sets the checked radio, even if other collection members are not radios.
function isRadio(node: Idl.Node): node is HTMLInputElement {
  return node instanceof HTMLInputElement && node.type === "radio";
}

class RadioNodeListCls extends NodeListCls implements Idl.RadioNodeList {
  get value() {
    try {
      for (const node of this) {
        if (isRadio(node) && node.checked) return node.value || "on";
      }
    } catch {}
    return "";
  }
  set value(v: string) {
    try {
      for (const node of this) {
        if (isRadio(node) && (node.value || "on") === String(v)) {
          node.checked = true;
          return;
        }
      }
    } catch {}
  }
  get [Symbol.toStringTag](): "RadioNodeList" {
    return "RadioNodeList";
  }
}

function htmlCollectionExposesName(el: Element | null | undefined) {
  if (!el) return false;
  return el.namespaceURI === HTML_NS;
}
// The proxy maps live indexed and named properties and reports the same
// surface to enumeration and reflection traps.
type HtmlCollectionProxyTarget = HtmlCollectionCls & {
  [OPTIONS_OWNER_SYM]?: HTMLSelectElement;
};
type HtmlCollectionConstructor =
  | typeof HTMLFormControlsCollectionCls
  | typeof HTMLOptionsCollectionCls;

/**
 * Creates a live HTMLCollection; contents refresh when the DOM mutation sequence changes.
 */
function makeHtmlCollection(
  getList: () => Element[],
  protoCls?: undefined,
  extras?: Record<string | symbol, unknown>,
): HtmlCollectionProxyTarget;
function makeHtmlCollection<T extends HtmlCollectionProxyTarget>(
  getList: () => Element[],
  protoCls: { prototype: T },
  extras?: Record<string | symbol, unknown>,
): T;
function makeHtmlCollection(
  getList: () => Element[],
  protoCls?: { prototype: HtmlCollectionProxyTarget } | HtmlCollectionConstructor,
  extras?: Record<string | symbol, unknown>,
): HtmlCollectionProxyTarget {
  // The selected prototype preserves subclass `instanceof`. Keep the live
  // getter in the WeakMap; a target property would leak into `ownKeys`.
  const target = Object.create(
    (protoCls || HtmlCollectionCls).prototype,
  ) as HtmlCollectionProxyTarget;
  htmlCollectionGetters.set(target, getList);
  if (extras) {
    for (const key of Reflect.ownKeys(extras)) {
      Object.defineProperty(target, key, {
        value: extras[key],
        writable: false,
        enumerable: false,
        configurable: true,
      });
    }
  }
  // Keep expandos separate so a property can shadow a live name added later.
  const shadow: Record<PropertyKey, unknown> = Object.create(null);
  // Reuse per mutation sequence so reads do not rerun childIds and the nodeFor
  // wrapper walk. Mutations invalidate the cached list.
  let cachedList: Element[] | null = null;
  let cachedSeq = -1;
  function memoGetList() {
    const curSeq = ksState().mutationSeq | 0;
    if (cachedList !== null && cachedSeq === curSeq) return cachedList;
    cachedList = getList();
    cachedSeq = curSeq;
    return cachedList;
  }

  let cachedNames: string[] | null = null;
  let cachedNamesSeq = -1;
  function memoExposedNames(list: Element[]) {
    const curSeq = ksState().mutationSeq | 0;
    if (cachedNames !== null && cachedNamesSeq === curSeq) return cachedNames;
    cachedNames = exposedNames(list);
    cachedNamesSeq = curSeq;
    return cachedNames;
  }

  function exposedNames(list: Element[]) {
    const names: string[] = [];
    const seen = new Set();
    for (const el of list) {
      if (!el || !el.getAttribute) continue;
      const id = el.getAttribute("id");
      if (id && !seen.has(id)) {
        seen.add(id);
        names.push(id);
      }
      if (htmlCollectionExposesName(el)) {
        const nm = el.getAttribute("name");
        if (nm && !seen.has(nm)) {
          seen.add(nm);
          names.push(nm);
        }
      }
    }
    return names;
  }

  // A supported name's value, the same for a read and for reflection:
  // form.elements answers a shared name with a RadioNodeList; otherwise the
  // first id match wins, then the first name match.
  function namedValue(t: object, name: string, list: Element[]) {
    if (protoCls?.prototype === HTMLFormControlsCollectionCls.prototype)
      return formControlsNamedItem.call(t, name);
    for (const el of list) {
      if (el.getAttribute && el.getAttribute("id") === name) return el;
    }
    for (const el of list) {
      if (!htmlCollectionExposesName(el)) continue;
      if (el.getAttribute && el.getAttribute("name") === name) return el;
    }
    return null;
  }
  // Supported names exclude indexes and own/prototype properties, as WebIDL
  // specifies for named-property visibility:
  // https://webidl.spec.whatwg.org/#legacy-platform-object-named-property-visibility
  function isVisibleName(t: object, prop: PropertyKey): prop is string {
    if (typeof prop !== "string") return false;
    if (/^\d+$/.test(prop) && Number(prop) < 4294967295) return false;
    if (Object.prototype.hasOwnProperty.call(shadow, prop) || prop in t) return false;
    return memoExposedNames(memoGetList()).includes(prop);
  }

  let proxy: HtmlCollectionProxyTarget;
  proxy = new Proxy(target, {
    get(t, prop, receiver) {
      const isOwn = receiver === proxy;
      if (isOwn && Object.prototype.hasOwnProperty.call(shadow, prop)) {
        return shadow[prop];
      }
      if (isOwn) {
        if (prop === "length") return memoGetList().length;
        if (typeof prop === "string" && /^\d+$/.test(prop)) {
          const i = Number(prop);
          if (i >= 0 && i < 4294967295) {
            const list = memoGetList();
            return i < list.length ? list[i] : undefined;
          }
        }
      }
      if (isOwn && typeof prop !== "symbol" && Object.prototype.hasOwnProperty.call(t, prop)) {
        return Reflect.get(t, prop, receiver);
      }
      // Named lookup: visible names act as own properties, and they also
      // answer reads through a derived object (`Object.create(coll).named`,
      // WPT HTMLCollection-as-prototype). Anything else falls through to the
      // prototype.
      if (isVisibleName(t, prop)) {
        const found = namedValue(t, prop, memoGetList());
        if (found) return found;
      }
      const v = Reflect.get(t, prop, receiver);
      return v;
    },
    set(t, prop, value, receiver) {
      if (receiver !== proxy) {
        return Reflect.set(t, prop, value, receiver);
      }
      const optionsOwner = t[OPTIONS_OWNER_SYM];
      if (optionsOwner && (prop === "length" || (typeof prop === "string" && /^\d+$/.test(prop)))) {
        // Only makeHtmlCollection's extras put a <select> under this symbol.
        return optionsCollectionSet(optionsOwner as HTMLSelectElement, prop, value, memoGetList());
      }
      // selectedIndex is the prototype's setter, not an expando.
      if (optionsOwner && prop === "selectedIndex") {
        return Reflect.set(t, prop, value, receiver);
      }
      // Numeric indexes are read-only. Returning false causes strict-mode
      // assignment to throw and sloppy-mode assignment to fail silently.
      // Other names may shadow unless they resolve to a named property,
      // whose WebIDL descriptor is non-configurable.
      if (typeof prop === "string" && /^\d+$/.test(prop)) {
        return false;
      }
      if (typeof prop === "string" && memoExposedNames(memoGetList()).includes(prop)) {
        return false;
      }
      shadow[prop] = value;
      return true;
    },
    has(t, prop) {
      if (Object.prototype.hasOwnProperty.call(shadow, prop)) return true;
      if (prop === "length") return true;
      if (typeof prop === "string") {
        if (/^\d+$/.test(prop)) return +prop < memoGetList().length;
        if (memoExposedNames(memoGetList()).includes(prop)) return true;
      }
      return prop in t;
    },
    deleteProperty(t, prop) {
      if (Object.prototype.hasOwnProperty.call(shadow, prop)) {
        delete shadow[prop];
        return true;
      }
      if (typeof prop === "string") {
        if (/^\d+$/.test(prop)) {
          const i = +prop;
          if (i < memoGetList().length) return false;
        }
      }
      if (isVisibleName(t, prop)) return false;
      return Reflect.deleteProperty(t, prop);
    },
    defineProperty(t, prop, desc) {
      if (typeof prop === "string") {
        if (/^\d+$/.test(prop) && Number(prop) < 4294967295) {
          return false;
        }
        if (memoExposedNames(memoGetList()).includes(prop)) return false;
      }
      return Reflect.defineProperty(t, prop, desc);
    },
    ownKeys(t) {
      // Expose indexes, visible names, and string expandos, but omit `length`,
      // prototype methods, and hidden symbols. Live-key descriptors stay
      // configurable so the proxy can report the current collection.
      const list = memoGetList();
      const keys: (string | symbol)[] = [];
      for (let i = 0; i < list.length; i++) keys.push(String(i));
      for (const n of memoExposedNames(list)) {
        if (isVisibleName(t, n)) keys.push(n);
      }
      const seen = new Set(keys);
      for (const k of [...Object.keys(shadow), ...Object.getOwnPropertyNames(t)]) {
        if (!seen.has(k)) {
          seen.add(k);
          keys.push(k);
        }
      }
      return keys;
    },
    getOwnPropertyDescriptor(t, prop) {
      if (Object.prototype.hasOwnProperty.call(shadow, prop)) {
        return {
          value: shadow[prop],
          writable: true,
          enumerable: true,
          configurable: true,
        };
      }
      if (prop === "length") {
        return {
          value: memoGetList().length,
          writable: false,
          enumerable: false,
          configurable: true,
        };
      }
      if (typeof prop === "string") {
        if (/^\d+$/.test(prop)) {
          const i = +prop;
          const list = memoGetList();
          if (i < list.length) {
            return {
              value: list[i],
              writable: false,
              enumerable: true,
              configurable: true,
            };
          }
        }
        if (isVisibleName(t, prop)) {
          const named = namedValue(t, prop, memoGetList());
          if (named) {
            return {
              value: named,
              writable: false,
              enumerable: false,
              configurable: true,
            };
          }
        }
      }
      return Reflect.getOwnPropertyDescriptor(t, prop);
    },
  });
  htmlCollectionGetters.set(proxy, getList);
  return proxy;
}

// ----- DOMTokenList -------------------------------------------------------
// Live tokenized view for classList and reflected attributes:
// https://dom.spec.whatwg.org/#interface-domtokenlist
// Empty removals preserve an absent backing attribute.
interface TokenListState {
  read(): string | null;
  write(value: string): void;
  // Undefined for lists without supported tokens (classList), whose
  // supports() throws.
  supported: ReadonlySet<string> | undefined;
}
const tokenListStates = new WeakMap<object, TokenListState>();

function tokenListState(list: object): TokenListState {
  const state = tokenListStates.get(list);
  if (!state) throw new TypeError("Illegal invocation");
  return state;
}

function tokensOf(list: object): string[] {
  const state = tokenListStates.get(list);
  return state ? parseTokens(state.read()) : [];
}

function writeTokens(state: TokenListState, tokens: string[]): void {
  state.write(tokens.join(" "));
}

const ASCII_WHITESPACE = /[\u0009\u000a\u000c\u000d\u0020]/;

// The proxy in makeDOMTokenList serves the indexed reads and length.
class DOMTokenListCls implements Idl.DOMTokenList {
  readonly [index: number]: string;
  declare [Symbol.iterator]: () => ArrayIterator<string>;
  item(index: number) {
    const tokens = tokensOf(this);
    const idx = Number(index) >>> 0;
    return idx >= 0 && idx < tokens.length ? tokens[idx] : null;
  }
  contains(token: string) {
    return tokensOf(this).includes(String(token));
  }
  get length() {
    return tokensOf(this).length;
  }
  get value() {
    return tokenListState(this).read() || "";
  }
  set value(v: string) {
    tokenListState(this).write(String(v ?? ""));
  }
  add(...tokens: string[]) {
    const state = tokenListState(this);
    const validated = tokens.map((t) => validateToken(t, "add"));
    const cur = parseTokens(state.read());
    const seen = new Set(cur);
    for (const t of validated) {
      if (!seen.has(t)) {
        seen.add(t);
        cur.push(t);
      }
    }
    writeTokens(state, cur);
  }
  remove(...tokens: string[]) {
    const state = tokenListState(this);
    const validated = new Set(tokens.map((t) => validateToken(t, "remove")));
    const before = state.read();
    const after = parseTokens(before).filter((t) => !validated.has(t));
    // An absent attribute stays absent when no tokens remain; otherwise
    // the write also normalizes the serialization.
    // https://dom.spec.whatwg.org/#concept-dtl-update
    if (state.read() === null && after.length === 0) return;
    writeTokens(state, after);
  }
  toggle(token: string, force?: boolean) {
    const state = tokenListState(this);
    const v = validateToken(token, "toggle");
    const cur = parseTokens(state.read());
    const has = cur.includes(v);
    const want = typeof force === "boolean" ? force : !has;
    if (want && !has) {
      cur.push(v);
      writeTokens(state, cur);
    } else if (!want && has) {
      writeTokens(
        state,
        cur.filter((t) => t !== v),
      );
    }
    return want;
  }
  replace(token: string, newToken: string) {
    const state = tokenListState(this);
    // Both tokens are checked for emptiness before either is checked for
    // whitespace, so replace(" ", "") throws SyntaxError.
    const o = String(token);
    const n = String(newToken);
    if (o.length === 0 || n.length === 0) {
      throw new DOMException("replace: tokens cannot be the empty string", "SyntaxError");
    }
    if (ASCII_WHITESPACE.test(o) || ASCII_WHITESPACE.test(n)) {
      throw new DOMException(
        "replace: tokens cannot contain ASCII whitespace",
        "InvalidCharacterError",
      );
    }
    const cur = parseTokens(state.read());
    const idx = cur.indexOf(o);
    if (idx < 0) return false;
    // Replace in place; a later copy of newToken is dropped.
    cur[idx] = n;
    writeTokens(state, [...new Set(cur)]);
    return true;
  }
  supports(token: string) {
    const { supported } = tokenListState(this);
    if (!supported) {
      throw new TypeError("supports() is not supported on this DOMTokenList");
    }
    return supported.has(String(token).toLowerCase());
  }
  toString() {
    return tokenListState(this).read() || "";
  }
}
// WebIDL iterable<DOMString>: WPT DOMTokenList-iteration checks that
// @@iterator is Array.prototype's. finalizeInterface does not wrap symbols.
DOMTokenListCls.prototype[Symbol.iterator] = Array.prototype[Symbol.iterator];
// ----- CSSOM: stylesheet wrappers and rule mirrors -----------------------
// Stylo paints from `<style>` text; this module owns the page-visible CSSOM.

// CSSRule + subclass interface objects. Real prototype-chain IDL:
// accessors live on the prototypes, state in a WeakMap side table.
// One chunk from splitStylesheetRules: prelude text, block body.
// Blockless statements carry only cssText (selector/decl empty).
interface ParsedRuleChunk {
  cssText?: string;
  selectorText?: string;
  declText?: string;
}

interface ParsedRuleList extends Array<ParsedRuleChunk> {
  trailingGarbage: string;
  unbalanced: boolean;
}

// A rule's declaration object (makeRuleStyleDeclaration).
type RuleStyleDecl = StyleDeclaration;

interface FeatureValuesMap {
  get(k: unknown): number[] | undefined;
  set(k: unknown, v: unknown): FeatureValuesMap;
  delete(k: unknown): boolean;
  clear(): void;
  has(k: unknown): boolean;
  readonly size: number;
  forEach(cb: (v: number[], k: string, m: FeatureValuesMap) => void, thisArg?: unknown): void;
  entries(): IterableIterator<[string, number[]]>;
  keys(): IterableIterator<string>;
  values(): IterableIterator<number[]>;
  [Symbol.iterator](): IterableIterator<[string, number[]]>;
}

type AnyCssRule = CSSRuleInterface & { keyText?: unknown };
type ItemList<T extends object> = T[] & { item(index: number): T | null };
type RuleList = ItemList<AnyCssRule>;

interface RuleState {
  kind: string;
  typeNum: number;
  parentRule: CSSRuleInterface | null;
  parentSheet: CSSStyleSheetCtor | null;
  onMutate: (() => void) | null;
  serialize(): string;
  serializeForCascade?(): string;
  selectorText?: string;
  conditionText?: string;
  name?: string;
  keyText?: string;
  href?: string;
  layerName?: string | null;
  supportsText?: string | null;
  prefix?: string;
  namespaceURI?: string;
  nameList?: readonly string[];
  style?: RuleStyleDecl;
  media?: MediaListCls;
  styleSheet?: CSSStyleSheetCtor | null;
  childRules?: RuleList;
  declBag?: Record<string, string>;
  features?: Record<string, FeatureValuesMap>;
  descriptors?: Map<string, string>;
}
const ruleState = new WeakMap<object, RuleState>();
const RULE_TOKEN = Symbol("ks-rule-internal");
type RuleStateWith<K extends keyof RuleState> = RuleState & Required<Pick<RuleState, K>>;
function rs<K extends keyof RuleState = never>(self: object): RuleStateWith<K> {
  const s = ruleState.get(self);
  if (!s) throw new TypeError("Illegal invocation");
  return s as RuleStateWith<K>;
}

interface SelectorCanonicalizer {
  canonicalizeSelector(selector: string): string | undefined;
  canonicalizeSelectorNs?(selector: string, prefixes: Record<string, string>): string | undefined;
}
function matchingSupportsParen(raw: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < raw.length; i++) {
    const c = raw[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractImportSupports(raw: string): { rest: string; supportsText: string | null } {
  let quote: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if ((c === "s" || c === "S") && /^supports\(/i.test(raw.slice(i, i + 9))) {
      const prev = i > 0 ? raw[i - 1] : " ";
      if (!/[\s)]/.test(prev)) continue;
      const open = i + 8;
      const close = matchingSupportsParen(raw, open);
      if (close >= 0) {
        return {
          rest: raw.slice(0, i) + raw.slice(close + 1),
          supportsText: raw.slice(open + 1, close).trim(),
        };
      }
      return { rest: raw, supportsText: null };
    }
  }
  return { rest: raw, supportsText: null };
}

function selectorCanonicalizer(d: unknown): SelectorCanonicalizer | null {
  if (d && typeof (d as SelectorCanonicalizer).canonicalizeSelector === "function") {
    return d as SelectorCanonicalizer;
  }
  return null;
}

function sheetNamespacePrefixes(sheet: unknown): Record<string, string> | null {
  try {
    const rules = (sheet as { cssRules?: { length: number; item(i: number): unknown } })?.cssRules;
    if (!rules) return null;
    let out: Record<string, string> | null = null;
    for (let i = 0; i < rules.length; i++) {
      const rule = rules.item(i) as { type?: number; prefix?: string; namespaceURI?: string };
      if (rule && rule.type === 10 && typeof rule.namespaceURI === "string") {
        out = out || {};
        out[typeof rule.prefix === "string" ? rule.prefix : ""] = rule.namespaceURI;
      }
    }
    return out;
  } catch {
    return null;
  }
}
function canonicalizeSelectorOrNull(sel: unknown, sheet?: unknown): string | null {
  const s = String(sel);
  try {
    const cap = selectorCanonicalizer(dom);
    if (cap) {
      const prefixes = sheet ? sheetNamespacePrefixes(sheet) : null;
      if (prefixes && typeof cap.canonicalizeSelectorNs === "function") {
        const v = cap.canonicalizeSelectorNs(s, prefixes);
        return typeof v === "string" ? v : null;
      }
      const v = cap.canonicalizeSelector(s);
      return typeof v === "string" ? v : null;
    }
  } catch {
    return null;
  }
  return s;
}

function canonicalizePageSelectorListOrNull(prelude: unknown): string | null {
  const s = String(prelude == null ? "" : prelude);
  const cap =
    opts && typeof opts.canonicalizePageSelectors === "function"
      ? opts.canonicalizePageSelectors
      : null;
  if (!cap) return null;
  try {
    const v = cap(s);
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

class CSSRuleInterface implements Idl.CSSRule {
  constructor(tok?: unknown) {
    if (tok !== RULE_TOKEN) throw new TypeError("Illegal constructor");
  }
  get type() {
    return rs(this).typeNum;
  }
  get cssText() {
    return rs(this).serialize();
  }
  // https://drafts.csswg.org/cssom/#dom-cssrule-csstext: setting does nothing.
  set cssText(_v: string) {}
  get parentRule(): CSSRuleInterface | null {
    return rs(this).parentRule || null;
  }
  get parentStyleSheet() {
    return rs(this).parentSheet || null;
  }
}
const RULE_CONSTANTS: Record<string, number> = {
  STYLE_RULE: 1,
  CHARSET_RULE: 2,
  IMPORT_RULE: 3,
  MEDIA_RULE: 4,
  FONT_FACE_RULE: 5,
  PAGE_RULE: 6,
  KEYFRAMES_RULE: 7,
  KEYFRAME_RULE: 8,
  MARGIN_RULE: 9,
  NAMESPACE_RULE: 10,
  COUNTER_STYLE_RULE: 11,
  SUPPORTS_RULE: 12,
  FONT_FEATURE_VALUES_RULE: 14,
};
for (const [k, v] of Object.entries(RULE_CONSTANTS)) {
  for (const target of [CSSRuleInterface, CSSRuleInterface.prototype]) {
    Object.defineProperty(target, k, {
      value: v,
      writable: false,
      enumerable: true,
      configurable: false,
    });
  }
}

// A comma-split list of media queries; there is no media-query algebra.
// The indexes are own properties kept in step with the list. Only the
// public mutators call onMutate: the construction-time parse must never
// remirror a sheet that is mid-reparse.
const MEDIA_LIST_TOKEN = Symbol("kitesurfMediaList");
class MediaListCls implements Idl.MediaList {
  readonly [index: number]: string;
  #media: string[] = [];
  readonly #onMutate: (() => void) | null;
  constructor(token?: symbol, initialText?: unknown, onMutate: (() => void) | null = null) {
    if (token !== MEDIA_LIST_TOKEN) throw new TypeError("Illegal constructor");
    this.#onMutate = onMutate;
    if (initialText) this.#setText(initialText);
  }
  #setText(text: unknown) {
    const old = this.#media.length;
    this.#media = String(text == null ? "" : text)
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);
    this.#sync(old);
  }
  #sync(oldLength: number) {
    for (let i = this.#media.length; i < oldLength; i++) Reflect.deleteProperty(this, i);
    Object.assign(this, this.#media);
  }
  #notify() {
    if (this.#onMutate) this.#onMutate();
  }
  get length() {
    return this.#media.length;
  }
  get mediaText() {
    return this.#media.join(", ");
  }
  set mediaText(v: string) {
    this.#setText(v);
    this.#notify();
  }
  item(index: number) {
    const m = this.#media[Number(index) | 0];
    return m != null ? m : null;
  }
  appendMedium(medium: string) {
    const m = String(medium).trim();
    if (m && !this.#media.includes(m)) {
      this.#media.push(m);
      this.#sync(this.#media.length - 1);
      this.#notify();
    }
  }
  deleteMedium(medium: string) {
    const i = this.#media.indexOf(String(medium).trim());
    if (i >= 0) {
      const old = this.#media.length;
      this.#media.splice(i, 1);
      this.#sync(old);
      this.#notify();
    }
  }
  toString() {
    return this.mediaText;
  }
}
// WebIDL gives an interface with an indexed getter and a length
// Array.prototype.values as its @@iterator, so `[...rule.media]` keeps
// working now that the list is no longer an array.
Object.defineProperty(MediaListCls.prototype, Symbol.iterator, {
  value: Array.prototype.values,
  writable: true,
  enumerable: false,
  configurable: true,
});

function makeRuleList(arr: AnyCssRule[]): RuleList {
  Object.defineProperty(arr, "item", {
    value: function item(index: unknown) {
      const i = typeof index === "number" ? index : 0;
      return arr[i] || null;
    },
    configurable: true,
    enumerable: false,
    writable: true,
  });
  // SAFETY: defineProperty above installs item on this same Array.
  return arr as RuleList;
}

class CSSGroupingRuleCls extends CSSRuleInterface implements Idl.CSSGroupingRule {
  get cssRules(): RuleList | undefined {
    return rs<"childRules">(this).childRules;
  }
  insertRule(text?: unknown, index?: unknown) {
    if (arguments.length === 0) {
      throw new TypeError(
        "Failed to execute 'insertRule': 1 argument required, but only 0 present.",
      );
    }
    const s = rs<"childRules">(this);
    const rules = s.childRules;
    const i = index === undefined ? 0 : Number(index) >>> 0;
    if (i > rules.length) {
      throw new DOMException("Index out of bounds", "IndexSizeError");
    }
    const parsed = parseSingleRuleOrThrow(text);
    const kind = classifyRuleKind(parsed);
    if (kind === "import" || kind === "namespace") {
      throw new DOMException("Rule not allowed inside a grouping rule", "HierarchyRequestError");
    }
    const rule = constructRule(parsed, s.parentSheet, this, s.onMutate);
    if (!rule) throw ruleSyntaxError(text);
    rules.splice(i, 0, rule);
    if (s.onMutate) s.onMutate();
    return i;
  }
  deleteRule(index?: unknown) {
    if (arguments.length === 0) {
      throw new TypeError(
        "Failed to execute 'deleteRule': 1 argument required, but only 0 present.",
      );
    }
    const s = rs<"childRules">(this);
    const rules = s.childRules;
    const i = Number(index) >>> 0;
    if (i >= rules.length) {
      throw new DOMException("Index out of bounds", "IndexSizeError");
    }
    rules.splice(i, 1);
    if (s.onMutate) s.onMutate();
  }
}

function ruleSyntaxError(text: unknown): DOMException {
  return new DOMException(
    "Failed to parse CSS rule: " + JSON.stringify(String(text == null ? "" : text)).slice(0, 80),
    "SyntaxError",
  );
}

class CSSConditionRuleCls extends CSSGroupingRuleCls {
  get conditionText(): string {
    return rs(this).conditionText || "";
  }
}
class CSSMediaRuleCls extends CSSConditionRuleCls {
  get media(): MediaListCls {
    return rs<"media">(this).media;
  }
  set media(v: unknown) {
    rs<"media">(this).media.mediaText = v == null ? "" : String(v);
  }
  get conditionText(): string {
    return rs<"media">(this).media.mediaText;
  }
}
class CSSSupportsRuleCls extends CSSConditionRuleCls {}
class CSSLayerBlockRuleCls extends CSSGroupingRuleCls {
  get name(): string {
    return rs(this).name || "";
  }
}
class CSSLayerStatementRuleCls extends CSSRuleInterface {
  get nameList(): readonly string[] {
    return rs<"nameList">(this).nameList;
  }
}
const MARGIN_RULE_NAMES = new Set([
  "top-left-corner",
  "top-left",
  "top-center",
  "top-right",
  "top-right-corner",
  "bottom-left-corner",
  "bottom-left",
  "bottom-center",
  "bottom-right",
  "bottom-right-corner",
  "left-top",
  "left-middle",
  "left-bottom",
  "right-top",
  "right-middle",
  "right-bottom",
]);

function atKeywordNameOf(text: unknown): string | null {
  const s = String(text || "").trim();
  if (s[0] !== "@") return null;
  let name = "";
  for (let i = 1; i < s.length;) {
    const ch = s[i];
    if (/[a-zA-Z0-9_-]/.test(ch)) {
      name += ch;
      i++;
      continue;
    }
    if (ch !== "\\" || i + 1 >= s.length || /[\n\r\f]/.test(s[i + 1])) return null;
    i++;
    const hex = s.slice(i).match(/^[0-9a-fA-F]{1,6}/)?.[0];
    if (hex) {
      const cp = Number.parseInt(hex, 16);
      name +=
        cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)
          ? "\ufffd"
          : String.fromCodePoint(cp);
      i += hex.length;
      if (/[\t\n\f\r ]/.test(s[i] || "")) {
        i += s[i] === "\r" && s[i + 1] === "\n" ? 2 : 1;
      }
    } else {
      name += s[i++];
    }
  }
  return name ? name.toLowerCase() : null;
}

function marginRuleNameOf(selectorText: unknown): string | null {
  const name = atKeywordNameOf(selectorText);
  if (!name) return null;
  return MARGIN_RULE_NAMES.has(name) ? name : null;
}

class CSSPageRuleCls extends CSSGroupingRuleCls implements Idl.CSSPageRule {
  get selectorText() {
    return rs(this).selectorText || "";
  }
  // CSSOM: an invalid assignment is ignored outright (no throw); the
  // empty string is always valid (matches every page).
  set selectorText(v: string) {
    const canon = canonicalizePageSelectorListOrNull(v);
    if (canon === null) return;
    const s = rs(this);
    s.selectorText = canon;
    if (s.onMutate) s.onMutate();
  }
  get style() {
    return rs<"style">(this).style;
  }
  // [PutForwards=cssText]: the page assigns a string, typed here as the
  // attribute's type; String() converts whatever arrives.
  set style(v: Idl.CSSPageDescriptors) {
    rs<"style">(this).style.cssText = String(v == null ? "" : v);
  }
  // @page can only ever contain margin at-rules (css-page-3 §4.3) —
  // not the generic grouping-rule grammar CSSGroupingRuleCls.insertRule
  // implements, so this overrides rather than extends it. Duplicates
  // are allowed and document order is kept (WPT cssom/margin-003.html).
  insertRule(text?: unknown, index?: unknown) {
    if (arguments.length === 0) {
      throw new TypeError(
        "Failed to execute 'insertRule': 1 argument required, but only 0 present.",
      );
    }
    const s = rs<"childRules">(this);
    const rules = s.childRules;
    const i = index === undefined ? 0 : Number(index) >>> 0;
    if (i > rules.length) {
      throw new DOMException("Index out of bounds", "IndexSizeError");
    }
    const split = splitStylesheetRules(text);
    if (split.unbalanced || split.length !== 1 || split.trailingGarbage) {
      throw ruleSyntaxError(text);
    }
    const name = marginRuleNameOf(split[0].selectorText);
    if (!name) {
      throw new DOMException(
        "Only margin at-rules may be inserted into a @page rule",
        "SyntaxError",
      );
    }
    const rule = constructMarginRule(split[0], name, s.parentSheet, this, s.onMutate);
    rules.splice(i, 0, rule);
    if (s.onMutate) s.onMutate();
    return i;
  }
}

// One @top-left / @bottom-center / … margin at-rule nested in a
// CSSPageRule's cssRules (CSSOM type 9). `name` is the margin box name,
// lowercase, without the `@`.
class CSSMarginRuleCls extends CSSRuleInterface implements Idl.CSSMarginRule {
  get name() {
    return rs(this).name || "";
  }
  get style() {
    return rs<"style">(this).style;
  }
  set style(v: Idl.CSSStyleDeclaration) {
    rs<"style">(this).style.cssText = String(v == null ? "" : v);
  }
}
function constructMarginRule(
  parsed: ParsedRuleChunk,
  name: string,
  parentSheet: CSSStyleSheetCtor | null,
  parentRule: CSSRuleInterface | null,
  onMutate: (() => void) | null,
): AnyCssRule {
  const rule = Object.create(CSSMarginRuleCls.prototype);
  const style = makeRuleStyleDeclaration(
    parsed.declText || "",
    "style",
    ruleStyleBaseUrl(parentSheet),
  );
  const st: RuleState = {
    kind: "margin",
    typeNum: 9,
    parentRule: parentRule || null,
    parentSheet: parentSheet || null,
    onMutate: onMutate || null,
    name,
    style,
    serialize() {
      const d = style.cssText;
      return "@" + name + (d ? " { " + d + " }" : " { }");
    },
    serializeForCascade() {
      const d = ruleStyleCascadeText(style);
      return "@" + name + (d ? " { " + d + " }" : " { }");
    },
  };
  attachRuleStyle(style, rule, () => {
    if (st.onMutate) st.onMutate();
  });
  ruleState.set(rule, st);
  return rule;
}

class CSSStyleRuleCls extends CSSGroupingRuleCls implements Idl.CSSStyleRule {
  get selectorText() {
    return rs<"selectorText">(this).selectorText;
  }
  set selectorText(v: string) {
    // CSSOM: parse the new selector; on failure leave the rule
    // untouched (no throw). Canonical text comes from stylo.
    const canon = canonicalizeSelectorOrNull(v, rs(this).parentSheet);
    if (canon === null) return;
    const s = rs(this);
    s.selectorText = canon;
    if (s.onMutate) s.onMutate();
  }
  get style() {
    return rs<"style">(this).style;
  }
  get styleMap() {
    let map = ruleStyleMaps.get(this);
    if (!map) {
      map = makeStylePropertyMap(rs<"style">(this).style);
      ruleStyleMaps.set(this, map);
    }
    return map;
  }
  // [PutForwards=cssText]: `rule.style = "a: b"` writes cssText.
  set style(v: Idl.CSSStyleProperties) {
    rs<"style">(this).style.cssText = String(v == null ? "" : v);
  }
}

const ruleStyleMaps = new WeakMap<object, ReturnType<typeof makeStylePropertyMap>>();

class CSSImportRuleCls extends CSSRuleInterface implements Idl.CSSImportRule {
  get href() {
    return rs<"href">(this).href;
  }
  get media() {
    return rs<"media">(this).media;
  }
  // [PutForwards=mediaText]
  set media(v: Idl.MediaList) {
    rs<"media">(this).media.mediaText = v == null ? "" : String(v);
  }
  get styleSheet() {
    return rs(this).styleSheet || null;
  }
  get layerName() {
    return rs<"layerName">(this).layerName;
  }
  get supportsText() {
    return rs<"supportsText">(this).supportsText;
  }
}
class CSSFontFaceRuleCls extends CSSRuleInterface {
  get style(): RuleStyleDecl {
    return rs<"style">(this).style;
  }
  set style(v: unknown) {
    rs<"style">(this).style.cssText = String(v == null ? "" : v);
  }
}
class CSSFontPaletteValuesRuleCls extends CSSRuleInterface {
  get name(): string {
    return rs(this).name || "";
  }
  get fontFamily(): string {
    return rs<"declBag">(this).declBag.fontFamily || "";
  }
  get basePalette(): string {
    return rs<"declBag">(this).declBag.basePalette || "";
  }
  get overrideColors(): string {
    return rs<"declBag">(this).declBag.overrideColors || "";
  }
}
class CSSFontFeatureValuesRuleCls extends CSSRuleInterface {
  get fontFamily(): string {
    return rs(this).name || "";
  }
  set fontFamily(v: unknown) {
    rs(this).name = String(v == null ? "" : v);
  }
  get annotation(): FeatureValuesMap {
    return rs<"features">(this).features.annotation;
  }
  get ornaments(): FeatureValuesMap {
    return rs<"features">(this).features.ornaments;
  }
  get stylistic(): FeatureValuesMap {
    return rs<"features">(this).features.stylistic;
  }
  get swash(): FeatureValuesMap {
    return rs<"features">(this).features.swash;
  }
  get characterVariant(): FeatureValuesMap {
    return rs<"features">(this).features["character-variant"];
  }
  get styleset(): FeatureValuesMap {
    return rs<"features">(this).features.styleset;
  }
}
class CSSNamespaceRuleCls extends CSSRuleInterface implements Idl.CSSNamespaceRule {
  get namespaceURI() {
    return rs(this).namespaceURI || "";
  }
  get prefix() {
    return rs(this).prefix || "";
  }
}
class CSSKeyframeRuleCls extends CSSRuleInterface implements Idl.CSSKeyframeRule {
  get keyText() {
    return rs(this).keyText || "";
  }
  set keyText(v: string) {
    const s = rs(this);
    s.keyText = String(v == null ? "" : v);
    if (s.onMutate) s.onMutate();
  }
  get style() {
    return rs<"style">(this).style;
  }
  set style(v: Idl.CSSStyleProperties) {
    rs<"style">(this).style.cssText = String(v == null ? "" : v);
  }
}
class CSSKeyframesRuleCls extends CSSRuleInterface implements Idl.CSSKeyframesRule {
  get name() {
    return rs(this).name || "";
  }
  set name(v: string) {
    const s = rs(this);
    s.name = String(v == null ? "" : v);
    if (s.onMutate) s.onMutate();
  }
  get cssRules(): RuleList {
    return rs<"childRules">(this).childRules;
  }
  get length() {
    return rs<"childRules">(this).childRules.length;
  }
  appendRule(text: string) {
    const s = rs<"childRules">(this);
    const parsed = parseSingleRuleOrThrow(text);
    s.childRules.push(constructKeyframe(parsed, s.parentSheet, this, s.onMutate));
    if (s.onMutate) s.onMutate();
  }
  deleteRule(select: string) {
    const s = rs<"childRules">(this);
    const i = findKeyframeIndex(s.childRules, select);
    if (i >= 0) {
      s.childRules.splice(i, 1);
      if (s.onMutate) s.onMutate();
    }
  }
  findRule(select: string) {
    const s = rs<"childRules">(this);
    const i = findKeyframeIndex(s.childRules, select);
    const rule = i >= 0 ? s.childRules[i] : null;
    return rule instanceof CSSKeyframeRuleCls ? rule : null;
  }
}
function findKeyframeIndex(rules: AnyCssRule[], select: unknown): number {
  const want = String(select == null ? "" : select).replace(/\s+/g, "");
  for (let i = rules.length - 1; i >= 0; i--) {
    if (String(rules[i].keyText).replace(/\s+/g, "") === want) return i;
  }
  return -1;
}
class CSSUnknownRuleCls extends CSSRuleInterface {}

interface CounterStyleRuleDto {
  name: string;
  descriptors: Array<{ name: string; value: string }>;
}

function counterStyleDto(value: unknown): CounterStyleRuleDto | null {
  if (!value || typeof value !== "object") return null;
  const dto = value as Partial<CounterStyleRuleDto>;
  if (typeof dto.name !== "string" || !Array.isArray(dto.descriptors)) return null;
  for (const descriptor of dto.descriptors) {
    if (
      !descriptor ||
      typeof descriptor.name !== "string" ||
      typeof descriptor.value !== "string"
    ) {
      return null;
    }
  }
  return dto as CounterStyleRuleDto;
}

function parseCounterStyle(css: string, field = "", value = ""): CounterStyleRuleDto | null {
  if (!parseCounterStyleRule) return null;
  try {
    return counterStyleDto(parseCounterStyleRule(css, field, value));
  } catch {
    return null;
  }
}
const COUNTER_STYLE_IDL_TO_DESC: Record<string, string> = {
  system: "system",
  symbols: "symbols",
  additiveSymbols: "additive-symbols",
  negative: "negative",
  prefix: "prefix",
  suffix: "suffix",
  range: "range",
  pad: "pad",
  speakAs: "speak-as",
  fallback: "fallback",
};

class CSSCounterStyleRuleCls extends CSSRuleInterface {}
function defineCounterStyleAttribute(
  idlName: string,
  get: (self: CSSCounterStyleRuleCls) => string,
  set: (self: CSSCounterStyleRuleCls, v: unknown) => void,
) {
  const getter = function (this: CSSCounterStyleRuleCls) {
    return get(this);
  };
  const setter = function (this: CSSCounterStyleRuleCls, v: unknown) {
    set(this, v);
  };
  Object.defineProperty(getter, "name", { value: "get " + idlName, configurable: true });
  Object.defineProperty(setter, "name", { value: "set " + idlName, configurable: true });
  Object.defineProperty(CSSCounterStyleRuleCls.prototype, idlName, {
    configurable: true,
    enumerable: true,
    get: getter,
    set: setter,
  });
}
defineCounterStyleAttribute(
  "name",
  (self) => rs(self).name || "",
  (self, v) => {
    const st = rs(self);
    const parsed = parseCounterStyle(st.serialize(), "name", String(v));
    if (!parsed) return;
    st.name = parsed.name;
    if (st.onMutate) st.onMutate();
  },
);
for (const idlName of Object.keys(COUNTER_STYLE_IDL_TO_DESC)) {
  const descName = COUNTER_STYLE_IDL_TO_DESC[idlName];
  defineCounterStyleAttribute(
    idlName,
    (self) => {
      const descriptors = rs(self).descriptors;
      if (!descriptors) throw new TypeError("Illegal invocation");
      return descriptors.get(descName) || "";
    },
    (self, v) => {
      const st = rs(self);
      const descriptors = st.descriptors;
      if (!descriptors) throw new TypeError("Illegal invocation");
      const parsed = parseCounterStyle(st.serialize(), descName, String(v));
      if (!parsed) return;
      const next = parsed.descriptors.find((descriptor) => descriptor.name === descName);
      if (!next) return;
      descriptors.clear();
      for (const descriptor of parsed.descriptors) {
        descriptors.set(descriptor.name, descriptor.value);
      }
      if (st.onMutate) st.onMutate();
    },
  );
}

function constructCounterStyleRule(
  parsed: ParsedRuleChunk,
  parentSheet: CSSStyleSheetCtor | null,
  parentRule: CSSRuleInterface | null,
  onMutate: (() => void) | null,
): CSSCounterStyleRuleCls | null {
  const parsedRule = parseCounterStyle(String(parsed.cssText || ""));
  if (!parsedRule) return null;

  const rule = Object.create(CSSCounterStyleRuleCls.prototype) as CSSCounterStyleRuleCls;
  const descriptors = new Map<string, string>();
  for (const descriptor of parsedRule.descriptors) {
    descriptors.set(descriptor.name, descriptor.value);
  }
  const st: RuleState = {
    kind: "counter-style",
    typeNum: 11,
    parentRule: parentRule || null,
    parentSheet: parentSheet || null,
    onMutate: onMutate || null,
    name: parsedRule.name,
    descriptors,
    serialize() {
      const parts: string[] = [];
      for (const [k, v] of descriptors) parts.push(k + ": " + v + ";");
      return "@counter-style " + st.name + (parts.length ? " { " + parts.join(" ") + " }" : " { }");
    },
  };
  ruleState.set(rule, st);
  return rule;
}
function splitStylesheetRules(src: unknown): ParsedRuleList {
  const out = Object.assign([] as ParsedRuleChunk[], {
    trailingGarbage: "",
    unbalanced: false,
  });
  const text = String(src).replace(/\/\*[\s\S]*?\*\//g, "");
  const n = text.length;
  let i = 0;
  let chunkStart = 0;
  let depth = 0;
  let parenDepth = 0;
  let braceOpenAt = -1;
  let inStr = "";
  while (i < n) {
    const ch = text[i];
    if (inStr) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === inStr) inStr = "";
      i++;
      continue;
    }
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      i++;
      continue;
    }
    if (ch === "(") {
      parenDepth++;
      i++;
      continue;
    }
    if (ch === ")" && parenDepth > 0) {
      parenDepth--;
      i++;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) braceOpenAt = i;
      depth++;
      i++;
      continue;
    }
    if (ch === "}") {
      depth--;
      if (depth === 0 && braceOpenAt >= 0) {
        const selectorText = text.slice(chunkStart, braceOpenAt).trim();
        const declText = text.slice(braceOpenAt + 1, i).trim();
        const cssText = selectorText
          ? selectorText + " { " + declText + " }"
          : text.slice(chunkStart, i + 1).trim();
        out.push({ cssText, selectorText, declText });
        chunkStart = i + 1;
        braceOpenAt = -1;
      }
      i++;
      continue;
    }
    if (depth === 0 && parenDepth === 0 && ch === ";") {
      const raw = text.slice(chunkStart, i + 1).trim();
      if (raw) out.push({ cssText: raw, selectorText: "", declText: "" });
      chunkStart = i + 1;
    }
    i++;
  }
  const tail = text.slice(chunkStart).trim();
  out.trailingGarbage = tail.length > 0 ? tail : "";
  out.unbalanced = depth !== 0 || parenDepth !== 0 || inStr !== "";
  return out;
}

function parseSingleRuleOrThrow(text: unknown): ParsedRuleChunk {
  const t = String(text == null ? "" : text);
  const split = splitStylesheetRules(t);
  if (split.unbalanced || split.length !== 1 || split.trailingGarbage) {
    throw ruleSyntaxError(t);
  }
  const parsed = split[0];
  const kind = classifyRuleKind(parsed);
  if (kind === "charset" || kind === "invalid" || kind === "margin") {
    throw ruleSyntaxError(t);
  }
  if (kind === "style" && canonicalizeSelectorOrNull(parsed.selectorText) === null) {
    throw new DOMException(
      "Failed to parse CSS rule: invalid selector '" + parsed.selectorText + "'",
      "SyntaxError",
    );
  }
  if (kind === "page" && canonicalizePageSelectorListOrNull(pagePreludeOf(parsed)) === null) {
    throw new DOMException(
      "Failed to parse CSS rule: invalid @page selector '" + parsed.selectorText + "'",
      "SyntaxError",
    );
  }
  return parsed;
}

function pagePreludeOf(parsed: ParsedRuleChunk): string {
  return String(parsed.selectorText || "")
    .replace(/^@page/i, "")
    .trim();
}

// Rule declarations use PageScript's wasm store when available, otherwise a
// plain camel-case bag. Hooks connect writes to parentRule and cascade text.
interface RuleStyleHooks {
  onChange: (() => void) | null;
  parentRule: CSSRuleInterface | null;
  cascadeText(): string;
}
const ruleStyleHooks = new WeakMap<object, RuleStyleHooks>();

function ruleStyleHooksOf(style: RuleStyleDecl): RuleStyleHooks {
  const hooks = ruleStyleHooks.get(style);
  if (!hooks) throw new TypeError("not a rule style declaration");
  return hooks;
}

// Ties a rule's declaration to the rule: its parentRule, and the callback
// a write through it runs.
function attachRuleStyle(style: RuleStyleDecl, rule: CSSRuleInterface, onChange: () => void): void {
  const hooks = ruleStyleHooksOf(style);
  hooks.parentRule = rule;
  hooks.onChange = onChange;
}

function ruleStyleCascadeText(style: RuleStyleDecl): string {
  return ruleStyleHooksOf(style).cascadeText();
}

function makeRuleStyleDeclaration(
  initialDeclText: string,
  context: "style" | "keyframe" | "font-face" | "page" = "style",
  baseUrl = opts?.pageUrl || "about:blank",
): RuleStyleDecl {
  const data: Record<string, string> = Object.create(null);
  // wasm-bindgen's FinalizationRegistry owns the store. The handler keeps it
  // alive while detached rules remain readable through `.style`; never free it
  // eagerly in deleteRule. Creation waits for the first read or write.
  let made: RuleStyleDeclarationStore | null = null;
  const createStore =
    opts && typeof opts.createRuleStyleDeclaration === "function"
      ? opts.createRuleStyleDeclaration
      : null;
  let pending = createStore !== null;
  function storeFor(): RuleStyleDeclarationStore | null {
    if (pending) {
      pending = false;
      if (createStore) {
        try {
          made = createStore(context, String(initialDeclText || ""), baseUrl);
        } catch {}
      }
      if (!made && initialDeclText) parseCssTextInto(initialDeclText, data);
    }
    return made;
  }
  if (!pending && initialDeclText) parseCssTextInto(initialDeclText, data);
  // Hooks live beside the data bag, not in it: bag keys serialize as CSS
  // declarations and count toward length, item and iteration.
  const hooks: RuleStyleHooks = {
    onChange: null,
    parentRule: null,
    // Untouched rules keep their author text without allocating a declaration store.
    cascadeText() {
      if (pending) return String(initialDeclText || "");
      return storeFor()?.cascadeText() ?? serializeStyleData(data);
    },
  };
  function notify() {
    if (hooks.onChange) hooks.onChange();
  }
  const backend: StyleDeclarationBackend = {
    cssText: () => storeFor()?.cssText() ?? serializeStyleData(data),
    setCssText(text) {
      const store = storeFor();
      if (store) {
        store.setCssText(String(text == null ? "" : text));
        notify();
        return;
      }
      for (const k of Object.keys(data)) delete data[k];
      parseCssTextInto(String(text == null ? "" : text), data);
      notify();
    },
    length: () => storeFor()?.length() ?? Object.keys(data).length,
    item(idx) {
      const store = storeFor();
      if (store) return store.item(idx);
      const k = Object.keys(data)[idx];
      return k != null ? cssPropCamelToKebab(k) : "";
    },
    getPropertyValue(name) {
      const store = storeFor();
      if (store) return store.getPropertyValue(String(name));
      const key = cssPropToCamel(String(name));
      return data[key] != null ? String(data[key]) : "";
    },
    getPropertyPriority: (name) => storeFor()?.getPropertyPriority(String(name)) ?? "",
    setProperty(name, value, priority = "") {
      const store = storeFor();
      if (store) {
        if (store.setProperty(String(name), value == null ? "" : String(value), String(priority))) {
          notify();
        }
        return;
      }
      const key = cssPropToCamel(String(name));
      const v = value == null ? "" : String(value);
      if (v === "") delete data[key];
      else data[key] = v;
      notify();
    },
    removeProperty(name) {
      const store = storeFor();
      if (store) {
        const had = store.hasProperty(String(name));
        const prev = store.removeProperty(String(name));
        if (had) notify();
        return prev;
      }
      const key = cssPropToCamel(String(name));
      const prev = data[key] != null ? String(data[key]) : "";
      delete data[key];
      notify();
      return prev;
    },
    parentRule: () => hooks.parentRule,
    *names() {
      const store = storeFor();
      if (store) {
        for (let i = 0; i < store.length(); i++) yield store.item(i);
        return;
      }
      for (const k of Object.keys(data)) yield cssPropCamelToKebab(k);
    },
  };
  // The CSS properties, camelCase or kebab-case.
  const handler: ProxyHandler<object> = {
    get(_t, prop) {
      const key = styleDeclKey(prop);
      if (typeof key !== "string") return undefined;
      const store = storeFor();
      if (store) return store.getPropertyValue(cssPropCamelToKebab(key));
      return data[key] !== undefined ? data[key] : "";
    },
    set(_t, prop, value) {
      const key = styleDeclKey(prop);
      if (typeof key !== "string") return false;
      const v = value == null ? "" : String(value);
      const store = storeFor();
      if (store) {
        if (store.setProperty(cssPropCamelToKebab(key), v, "")) notify();
        return true;
      }
      if (v === "") delete data[key];
      else data[key] = v;
      notify();
      return true;
    },
    has(_t, prop) {
      const key = styleDeclKey(prop);
      if (typeof key !== "string") return false;
      const store = storeFor();
      if (store) return store.hasProperty(cssPropCamelToKebab(key));
      return key in data;
    },
    deleteProperty(_t, prop) {
      const key = styleDeclKey(prop);
      if (typeof key !== "string") return Reflect.deleteProperty(_t, prop);
      const store = storeFor();
      if (store) {
        const name = cssPropCamelToKebab(key);
        const had = store.hasProperty(name);
        store.removeProperty(name);
        if (had) notify();
        return true;
      }
      const had = key in data;
      delete data[key];
      if (had) notify();
      return true;
    },
    // The bag's keys stay the declaration's own keys.
    ownKeys: () => (storeFor() ? [] : Object.keys(data)),
    getOwnPropertyDescriptor(_t, prop) {
      if (storeFor() || typeof prop !== "string" || !(prop in data)) return undefined;
      return { value: data[prop], writable: true, enumerable: true, configurable: true };
    },
  };
  const style = makeStyleDeclaration(backend, handler);
  ruleStyleHooks.set(style, hooks);
  return style;
}

const KNOWN_AT_RULES = new Set([
  "media",
  "supports",
  "layer",
  "import",
  "namespace",
  "font-face",
  "font-palette-values",
  "font-feature-values",
  "keyframes",
  "-webkit-keyframes",
  "page",
  "charset",
  "container",
  "scope",
  "property",
  "counter-style",
  "starting-style",
  "view-transition",
  "position-try",
  "document",
]);

function classifyRuleKind(parsed: ParsedRuleChunk): string {
  const sel = String(parsed.selectorText || "");
  const raw = String(parsed.cssText || "");
  if (marginRuleNameOf(sel)) return "margin";
  const at = (sel || raw).match(/^@([a-zA-Z-]+)/);
  if (!at) return sel ? "style" : "invalid";
  const name = at[1].toLowerCase();
  switch (name) {
    case "media":
      return "media";
    case "supports":
      return "supports";
    case "layer":
      return sel ? "layer-block" : "layer-statement";
    case "import":
      return "import";
    case "namespace":
      return "namespace";
    case "font-face":
      return "font-face";
    case "font-palette-values":
      return "font-palette-values";
    case "font-feature-values":
      return "font-feature-values";
    case "keyframes":
    case "-webkit-keyframes":
      return "keyframes";
    case "page":
      return "page";
    case "charset":
      return "charset";
    case "counter-style":
      return "counter-style";
    default:
      return KNOWN_AT_RULES.has(name) ? "unknown" : "invalid";
  }
}

function ruleTextForCascade(rule: AnyCssRule): string {
  const state = ruleState.get(rule);
  return state?.serializeForCascade ? state.serializeForCascade() : String(rule.cssText);
}

function serializeChildBlock(children: AnyCssRule[] | undefined, forCascade = false): string {
  if (!children || children.length === 0) return " {\n}";
  return (
    " {\n  " +
    children.map((c) => (forCascade ? ruleTextForCascade(c) : String(c.cssText))).join("\n  ") +
    "\n}"
  );
}

function parseChildRules(
  declText: unknown,
  parentSheet: CSSStyleSheetCtor | null,
  parentRule: CSSRuleInterface | null,
  onMutate: (() => void) | null,
): RuleList {
  const out = makeRuleList([]);
  for (const p of splitStylesheetRules(String(declText || ""))) {
    if (!isConstructibleRuleKind(classifyRuleKind(p))) continue;
    const rule = constructRule(p, parentSheet, parentRule, onMutate);
    if (rule) out.push(rule);
  }
  return out;
}

function isConstructibleRuleKind(kind: string): boolean {
  return kind !== "charset" && kind !== "invalid" && kind !== "margin";
}

function ruleStyleBaseUrl(parentSheet: CSSStyleSheetCtor | null): string {
  const href = parentSheet && (parentSheet as { href?: unknown }).href;
  if (typeof href === "string" && href) return href;
  const documentBase = ksGlobal.document && ksGlobal.document.baseURI;
  return typeof documentBase === "string" && documentBase
    ? documentBase
    : opts?.pageUrl || "about:blank";
}

function constructKeyframe(
  parsed: ParsedRuleChunk,
  parentSheet: CSSStyleSheetCtor | null,
  parentRule: CSSRuleInterface | null,
  onMutate: (() => void) | null,
): CSSKeyframeRuleCls {
  const rule: CSSKeyframeRuleCls = Object.create(CSSKeyframeRuleCls.prototype);
  const style = makeRuleStyleDeclaration(
    parsed.declText || "",
    "keyframe",
    ruleStyleBaseUrl(parentSheet),
  );
  const st: RuleState = {
    kind: "keyframe",
    typeNum: 8,
    parentRule: parentRule || null,
    parentSheet: parentSheet || null,
    onMutate: onMutate || null,
    keyText: String(parsed.selectorText || "").trim(),
    style,
    serialize() {
      const d = style.cssText;
      return st.keyText + (d ? " { " + d + " }" : " { }");
    },
    serializeForCascade() {
      const d = ruleStyleCascadeText(style);
      return st.keyText + (d ? " { " + d + " }" : " { }");
    },
  };
  attachRuleStyle(style, rule, () => {
    if (st.onMutate) st.onMutate();
  });
  ruleState.set(rule, st);
  return rule;
}

function makeFeatureValuesMap(onMutateRef: { fn: (() => void) | null }) {
  const m = new Map<string, number[]>();
  const api: FeatureValuesMap = {
    get(k: unknown) {
      return m.get(String(k));
    },
    set(k: unknown, v: unknown) {
      const arr = Array.isArray(v) ? v.map(Number) : [Number(v)];
      m.set(String(k), arr);
      if (onMutateRef.fn) onMutateRef.fn();
      return api;
    },
    delete(k: unknown) {
      const deleted = m.delete(String(k));
      if (onMutateRef.fn) onMutateRef.fn();
      return deleted;
    },
    clear() {
      m.clear();
      if (onMutateRef.fn) onMutateRef.fn();
    },
    has(k: unknown) {
      return m.has(String(k));
    },
    get size() {
      return m.size;
    },
    forEach(cb, thisArg?: unknown) {
      m.forEach((v, k) => cb.call(thisArg, v, k, api));
    },
    entries() {
      return m.entries();
    },
    keys() {
      return m.keys();
    },
    values() {
      return m.values();
    },
    [Symbol.iterator]() {
      return m.entries();
    },
  };
  return { api, map: m };
}

const FEATURE_TYPES = [
  "annotation",
  "ornaments",
  "stylistic",
  "swash",
  "character-variant",
  "styleset",
];

function constructRule(
  parsed: ParsedRuleChunk,
  parentSheet: CSSStyleSheetCtor | null,
  parentRule: CSSRuleInterface | null,
  onMutate: (() => void) | null,
): AnyCssRule | null {
  const kind = classifyRuleKind(parsed);
  const sel = String(parsed.selectorText || "");
  const raw = String(parsed.cssText || "");
  const base = {
    kind,
    parentRule: parentRule || null,
    parentSheet: parentSheet || null,
    onMutate: onMutate || null,
  };
  const mk = <T extends object>(cls: { prototype: T }): T => Object.create(cls.prototype);

  if (kind === "style") {
    const rule = mk(CSSStyleRuleCls);
    const style = makeRuleStyleDeclaration(
      parsed.declText || "",
      "style",
      ruleStyleBaseUrl(parentSheet),
    );
    const canon = canonicalizeSelectorOrNull(sel);
    const st: RuleState = {
      ...base,
      typeNum: 1,
      selectorText: canon !== null ? canon : sel,
      style,
      childRules: makeRuleList([]),
      serialize() {
        const d = style.cssText;
        return st.selectorText + (d ? " { " + d + " }" : " { }");
      },
      serializeForCascade() {
        const d = ruleStyleCascadeText(style);
        return st.selectorText + (d ? " { " + d + " }" : " { }");
      },
    };
    attachRuleStyle(style, rule, () => {
      if (st.onMutate) st.onMutate();
    });
    ruleState.set(rule, st);
    return rule;
  }

  if (kind === "media" || kind === "supports") {
    const rule = mk(kind === "media" ? CSSMediaRuleCls : CSSSupportsRuleCls);
    const cond = sel.replace(/^@(media|supports)/i, "").trim();
    const st: RuleState = {
      ...base,
      typeNum: kind === "media" ? 4 : 12,
      conditionText: cond,
      media: kind === "media" ? makeMediaList(cond, onMutate) : undefined,
      childRules: undefined,
      serialize() {
        const c = st.media ? st.media.mediaText : st.conditionText;
        return "@" + kind + (c ? " " + c : "") + serializeChildBlock(st.childRules);
      },
      serializeForCascade() {
        const c = st.media ? st.media.mediaText : st.conditionText;
        return "@" + kind + (c ? " " + c : "") + serializeChildBlock(st.childRules, true);
      },
    };
    ruleState.set(rule, st);
    st.childRules = parseChildRules(parsed.declText, parentSheet, rule, onMutate);
    return rule;
  }

  if (kind === "layer-block") {
    const rule = mk(CSSLayerBlockRuleCls);
    const st: RuleState = {
      ...base,
      typeNum: 0,
      name: sel.replace(/^@layer/i, "").trim(),
      childRules: undefined,
      serialize() {
        return "@layer" + (st.name ? " " + st.name : "") + serializeChildBlock(st.childRules);
      },
      serializeForCascade() {
        return "@layer" + (st.name ? " " + st.name : "") + serializeChildBlock(st.childRules, true);
      },
    };
    ruleState.set(rule, st);
    st.childRules = parseChildRules(parsed.declText, parentSheet, rule, onMutate);
    return rule;
  }

  if (kind === "layer-statement") {
    const rule = mk(CSSLayerStatementRuleCls);
    const names = raw
      .replace(/^@layer/i, "")
      .replace(/;\s*$/, "")
      .trim();
    const list = names
      ? names
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean)
      : [];
    const st: RuleState = {
      ...base,
      typeNum: 0,
      nameList: Object.freeze(list.slice()),
      serialize() {
        return "@layer " + list.join(", ") + ";";
      },
    };
    ruleState.set(rule, st);
    return rule;
  }

  if (kind === "import") {
    const sup = extractImportSupports(raw);
    const m = sup.rest.match(
      /^@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"']*))\s*\)|"([^"]*)"|'([^']*)')\s*(layer(?:\(([^)]*)\))?)?\s*(?:supports\(([\s\S]*?)\))?\s*([^;]*);?\s*$/i,
    );
    if (m) {
      const rule = mk(CSSImportRuleCls);
      const href =
        m[1] ?? m[2] ?? (m[3] !== undefined ? m[3].trim() : undefined) ?? m[4] ?? m[5] ?? "";
      const layerName = m[6] ? (m[7] !== undefined ? m[7].trim() : "") : null;
      const supportsText = sup.supportsText ?? (m[8] !== undefined ? m[8].trim() : null);
      const media = makeMediaList((m[9] || "").trim(), onMutate);
      const importedSheet = new CSSStyleSheetCtor();
      const st: RuleState = {
        ...base,
        typeNum: 3,
        href,
        layerName,
        supportsText,
        media,
        styleSheet: importedSheet,
        serialize() {
          let out = '@import url("' + href + '")';
          if (st.layerName !== null)
            out += st.layerName === "" ? " layer" : " layer(" + st.layerName + ")";
          if (st.supportsText !== null) out += " supports(" + st.supportsText + ")";
          const mt = media.mediaText;
          if (mt) out += " " + mt;
          return out + ";";
        },
      };
      ruleState.set(rule, st);
      const imported = styleSheetFields(importedSheet);
      imported.ownerRule = rule;
      imported.href = href;
      imported.parentStyleSheet = parentSheet || null;
      return rule;
    }
  }

  if (kind === "namespace") {
    const m = raw.match(
      /^@namespace\s+(?:([a-zA-Z_][\w-]*)\s+)?(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"']*))\s*\)|"([^"]*)"|'([^']*)')\s*;?\s*$/i,
    );
    if (m) {
      const rule = mk(CSSNamespaceRuleCls);
      const uri =
        m[2] ?? m[3] ?? (m[4] !== undefined ? m[4].trim() : undefined) ?? m[5] ?? m[6] ?? "";
      const st: RuleState = {
        ...base,
        typeNum: 10,
        prefix: m[1] || "",
        namespaceURI: uri,
        serialize() {
          return "@namespace " + (st.prefix ? st.prefix + " " : "") + 'url("' + uri + '");';
        },
      };
      ruleState.set(rule, st);
      return rule;
    }
  }

  if (kind === "font-face") {
    const rule = mk(CSSFontFaceRuleCls);
    const style = makeRuleStyleDeclaration(
      parsed.declText || "",
      "font-face",
      ruleStyleBaseUrl(parentSheet),
    );
    const st: RuleState = {
      ...base,
      typeNum: 5,
      style,
      serialize() {
        const d = style.cssText;
        return "@font-face" + (d ? " { " + d + " }" : " { }");
      },
      serializeForCascade() {
        const d = ruleStyleCascadeText(style);
        return "@font-face" + (d ? " { " + d + " }" : " { }");
      },
    };
    attachRuleStyle(style, rule, () => {
      if (st.onMutate) st.onMutate();
    });
    ruleState.set(rule, st);
    return rule;
  }

  if (kind === "font-palette-values") {
    const rule = mk(CSSFontPaletteValuesRuleCls);
    const declBag: Record<string, string> = Object.create(null);
    parseCssTextInto(parsed.declText || "", declBag);
    const st: RuleState = {
      ...base,
      typeNum: 0,
      name: sel.replace(/^@font-palette-values/i, "").trim(),
      declBag,
      serialize() {
        const parts: string[] = [];
        for (const k of Object.keys(declBag)) {
          parts.push(cssPropCamelToKebab(k) + ": " + declBag[k] + ";");
        }
        return (
          "@font-palette-values " +
          st.name +
          (parts.length ? " { " + parts.join(" ") + " }" : " { }")
        );
      },
    };
    ruleState.set(rule, st);
    return rule;
  }

  if (kind === "font-feature-values") {
    const rule = mk(CSSFontFeatureValuesRuleCls);
    const onMutateRef: { fn: (() => void) | null } = { fn: null };
    const features: Record<string, FeatureValuesMap> = {};
    for (const t of FEATURE_TYPES) features[t] = makeFeatureValuesMap(onMutateRef).api;
    for (const p of splitStylesheetRules(String(parsed.declText || ""))) {
      const fm = String(p.selectorText || "").match(/^@([a-zA-Z-]+)$/);
      if (!fm || !FEATURE_TYPES.includes(fm[1].toLowerCase())) continue;
      const target = features[fm[1].toLowerCase()];
      for (const decl of String(p.declText || "").split(";")) {
        const colon = decl.indexOf(":");
        if (colon <= 0) continue;
        const name = decl.slice(0, colon).trim();
        const nums = decl
          .slice(colon + 1)
          .trim()
          .split(/\s+/)
          .map(Number)
          .filter((n: number) => !Number.isNaN(n));
        if (name && nums.length) target.set(name, nums);
      }
    }
    onMutateRef.fn = onMutate || null;
    const st: RuleState = {
      ...base,
      typeNum: 14,
      name: sel.replace(/^@font-feature-values/i, "").trim(),
      features,
      serialize() {
        const blocks: string[] = [];
        for (const t of FEATURE_TYPES) {
          const map = features[t];
          if (!map.size) continue;
          const entries: string[] = [];
          map.forEach((v: number[], k: string) => entries.push(k + ": " + v.join(" ") + ";"));
          blocks.push("@" + t + " { " + entries.join(" ") + " }");
        }
        return (
          "@font-feature-values " +
          st.name +
          (blocks.length ? " { " + blocks.join(" ") + " }" : " { }")
        );
      },
    };
    ruleState.set(rule, st);
    return rule;
  }

  if (kind === "keyframes") {
    const rule = mk(CSSKeyframesRuleCls);
    const st: RuleStateWith<"childRules"> = {
      ...base,
      typeNum: 7,
      name: sel.replace(/^@(-webkit-)?keyframes/i, "").trim(),
      childRules: makeRuleList([]),
      serialize() {
        return "@keyframes " + st.name + serializeChildBlock(st.childRules);
      },
      serializeForCascade() {
        return "@keyframes " + st.name + serializeChildBlock(st.childRules, true);
      },
    };
    ruleState.set(rule, st);
    for (const p of splitStylesheetRules(String(parsed.declText || ""))) {
      if (!p.selectorText) continue;
      st.childRules.push(constructKeyframe(p, parentSheet, rule, onMutate));
    }
    return rule;
  }

  if (kind === "page") {
    const canonSel = canonicalizePageSelectorListOrNull(pagePreludeOf(parsed));
    if (canonSel === null) return null;
    const rule = mk(CSSPageRuleCls);
    const declParts: string[] = [];
    const childRules = makeRuleList([]);
    const pageBody = splitStylesheetRules(parsed.declText || "");
    for (const part of pageBody) {
      const marginName = marginRuleNameOf(part.selectorText);
      if (marginName) {
        childRules.push(constructMarginRule(part, marginName, parentSheet, rule, onMutate));
      } else if (!part.selectorText && !/^@/.test(String(part.cssText || "").trim())) {
        declParts.push(String(part.cssText));
      }
    }
    if (pageBody.trailingGarbage && !/^@/.test(pageBody.trailingGarbage)) {
      declParts.push(pageBody.trailingGarbage);
    }
    const style = makeRuleStyleDeclaration(
      declParts.join(" "),
      "page",
      ruleStyleBaseUrl(parentSheet),
    );
    const pageText = (declText: string, forCascade: boolean): string => {
      const parts: string[] = [];
      if (declText) parts.push(declText);
      for (const c of childRules)
        parts.push(forCascade ? ruleTextForCascade(c) : String(c.cssText));
      const body = parts.join(" ");
      return (
        "@page" +
        (st.selectorText ? " " + st.selectorText : "") +
        (body ? " { " + body + " }" : " { }")
      );
    };
    const st: RuleState = {
      ...base,
      typeNum: 6,
      selectorText: canonSel,
      style,
      childRules,
      serialize() {
        return pageText(style.cssText, false);
      },
      serializeForCascade() {
        return pageText(ruleStyleCascadeText(style), true);
      },
    };
    attachRuleStyle(style, rule, () => {
      if (st.onMutate) st.onMutate();
    });
    ruleState.set(rule, st);
    return rule;
  }

  if (kind === "counter-style") {
    return constructCounterStyleRule(parsed, parentSheet, parentRule, onMutate);
  }

  const rule = mk(CSSUnknownRuleCls);
  const st: RuleState = {
    ...base,
    typeNum: 0,
    serialize() {
      if (sel) {
        const d = String(parsed.declText || "")
          .replace(/\s+/g, " ")
          .trim();
        return sel + (d ? " { " + d + " }" : " { }");
      }
      return raw.replace(/\s+/g, " ").trim();
    },
  };
  ruleState.set(rule, st);
  return rule;
}

function makeMediaList(initialText?: unknown, onMutate?: (() => void) | null): MediaListCls {
  return new MediaListCls(MEDIA_LIST_TOKEN, initialText, onMutate ?? null);
}
function makeEmptyMediaList() {
  return makeMediaList("");
}

function securityError(message: string): Error {
  try {
    return new ksGlobal.DOMException(message, "SecurityError");
  } catch {
    return Object.assign(new Error(message), { name: "SecurityError" });
  }
}

function makeStyleSheetStub(ownerNode: Element | ParsedElement | null): CSSStyleSheetCtor {
  const id = ownerNode && typeof ownerNode._id === "number" ? ownerNode._id : -1;
  if (ownerNode && id >= 0) {
    const cached = sheetCache.get(ownerNode);
    if (cached) return cached;
  }
  const isStyleEl = !!(ownerNode && ownerNode.tagName === "STYLE");
  const isLinkEl = !!(ownerNode && ownerNode.tagName === "LINK");
  const rules: AnyCssRule[] = [];
  Object.defineProperty(rules, "item", {
    value: function item(index: unknown) {
      const i = typeof index === "number" ? index : 0;
      return rules[i] || null;
    },
    configurable: true,
    enumerable: false,
    writable: true,
  });
  // SAFETY: the non-enumerable item method above completes this Array's RuleList view.
  const cssRules = rules as RuleList;

  let lastParsedText: string | null = null;
  let mirrorTextId = -1;
  function readNodeText() {
    if (!isStyleEl || id < 0) return "";
    try {
      return String(dom.textContent(id) || "");
    } catch {
      return "";
    }
  }
  // Stylo reads <style> text, so CSSOM edits must be mirrored into the wasm child.
  function remirror() {
    if (!(isStyleEl && id >= 0)) return;
    try {
      const joined = rules.map(ruleTextForCascade).join("\n");
      writeMirrorText(joined);
      lastParsedText = joined;
      bumpMutationSeq();
    } catch {}
  }
  function writeMirrorText(text: string) {
    // Reuse the unwrapped mirror node to avoid leaving detached nodes in Blitz's slab.
    const children = dom.childIds(id);
    const reusable =
      mirrorTextId >= 0 &&
      children.length === 1 &&
      children[0] === mirrorTextId &&
      !hasLiveWrapper(mirrorTextId);
    if (reusable) {
      if (text) {
        dom.setNodeText(mirrorTextId, text);
      } else {
        dom.removeNode(mirrorTextId);
        dropUnwrappedSubtrees([mirrorTextId]);
        mirrorTextId = -1;
      }
      return;
    }
    for (const cid of children) dom.removeNode(cid);
    dropUnwrappedSubtrees(children);
    mirrorTextId = -1;
    if (text) {
      mirrorTextId = dom.createTextNode(text);
      dom.appendChildNode(id, mirrorTextId);
    }
  }
  function reparseFromText(text: string) {
    rules.length = 0;
    for (const p of splitStylesheetRules(text)) {
      if (!isConstructibleRuleKind(classifyRuleKind(p))) continue;
      const rule = constructRule(p, sheet, null, remirror);
      if (rule) rules.push(rule);
    }
    lastParsedText = text;
  }
  let linkRulesLoaded = false;
  function syncFromLink(strict: boolean) {
    if (linkRulesLoaded || id < 0 || !getExternalSheetRules) return;
    let res;
    try {
      res = getExternalSheetRules(id);
    } catch {
      return;
    }
    if (!res) return;
    if (res.state === "denied") {
      if (strict) {
        throw securityError(
          "Failed to access rules of 'CSSStyleSheet': the stylesheet is " +
            "cross-origin and was not fetched with CORS",
        );
      }
      return;
    }
    if (res.state !== "clean") return;
    reparseFromText(String(res.text || ""));
    linkRulesLoaded = true;
  }
  function syncFromDom(strict = false) {
    if (isLinkEl) return syncFromLink(strict);
    if (!isStyleEl) return;
    const cur = readNodeText();
    if (cur !== lastParsedText) reparseFromText(cur);
  }
  // href is the <link>'s resolved URL, or the raw attribute when it doesn't
  // resolve; an inline <style> has none.
  const href = (() => {
    if (!isLinkEl || typeof ownerNode.getAttribute !== "function") return null;
    const raw = ownerNode.getAttribute("href");
    if (!raw) return null;
    try {
      const g = ksGlobal;
      const base = (g.document && g.document.baseURI) || (g.location ? g.location.href : "");
      return new URL(raw, base || undefined).href;
    } catch {
      return raw;
    }
  })();
  // Mutators mirror all rules into `<style>` text; `<link>` remains network-backed.
  // Sync first to see direct style-text edits and preserve SecurityError for
  // opaque linked sheets.
  const backend: CSSStyleSheetBackend = {
    cssRules() {
      syncFromDom();
      return cssRules;
    },
    insertRule(text, index) {
      // Check bounds before parsing, then insert exactly one rule and refresh the DOM mirror.
      // Synchronizing first also preserves SecurityError for opaque linked sheets.
      // https://drafts.csswg.org/cssom/#insert-a-css-rule
      syncFromDom(true);
      // index defaults to 0, not the length.
      const i = index === undefined ? 0 : Number(index) >>> 0;
      if (i > rules.length) {
        throw new DOMException("Index out of bounds", "IndexSizeError");
      }
      const parsed = parseSingleRuleOrThrow(text);
      const rule = constructRule(parsed, sheet, null, remirror);
      if (!rule) throw ruleSyntaxError(text);
      rules.splice(i, 0, rule);
      remirror();
      return i;
    },
    deleteRule(index) {
      syncFromDom(true);
      const i = Number(index) >>> 0;
      if (i >= rules.length) {
        throw new DOMException("Index out of bounds", "IndexSizeError");
      }
      rules.splice(i, 1);
      remirror();
    },
    replaceSync(text) {
      syncFromDom(true);
      const t = String(text == null ? "" : text);
      reparseFromText(t);
      if (isStyleEl && id >= 0) {
        try {
          writeMirrorText(t);
          lastParsedText = t;
          bumpMutationSeq();
        } catch {}
      }
    },
    // A document sheet's replace() resolves even when the replacement
    // fails.
    replace(text) {
      try {
        backend.replaceSync(text);
      } catch {}
      return Promise.resolve(sheet);
    },
  };
  // The backing state is in sheetRecords; this stub uses the public prototype.
  const sheet = Object.create(CSSStyleSheetCtor.prototype) as CSSStyleSheetCtor;
  sheetRecords.set(sheet, {
    fields: {
      ownerNode: ownerNode || null,
      href,
      title:
        ownerNode && typeof ownerNode.getAttribute === "function"
          ? ownerNode.getAttribute("title") || null
          : null,
      media: makeEmptyMediaList(),
      disabled: false,
      ownerRule: null,
      parentStyleSheet: null,
    },
    backend,
  });
  if (ownerNode && id >= 0) sheetCache.set(ownerNode, sheet);
  return sheet;
}

// StyleSheet's attributes for one sheet. The code that builds a sheet
// fills them in (styleSheetFields); the page only reads them, except
// disabled.
interface StyleSheetFields {
  ownerNode: Element | ParsedElement | null;
  href: string | null;
  title: string | null;
  media: MediaListCls;
  disabled: boolean;
  ownerRule: CSSRuleInterface | null;
  parentStyleSheet: CSSStyleSheetCtor | null;
}
// Where a CSSStyleSheet's rule operations go: a document sheet mirrors
// its rules into the owning <style>, a constructed sheet into the hidden
// <style>s of the documents that adopt it.
interface CSSStyleSheetBackend {
  cssRules(): RuleList;
  insertRule(text: unknown, index: unknown): number;
  deleteRule(index: unknown): void;
  replaceSync(text: unknown): void;
  replace(text: unknown): Promise<Idl.CSSStyleSheet>;
  attachMirror?(styleEl: Element): void;
  detachMirror?(styleEl: Element): void;
}
interface SheetRecord {
  fields: StyleSheetFields;
  backend: CSSStyleSheetBackend;
}
const sheetRecords = new WeakMap<object, SheetRecord>();

function sheetRecord(sheet: object): SheetRecord {
  const record = sheetRecords.get(sheet);
  if (!record) throw new TypeError("Illegal invocation");
  return record;
}

function styleSheetFields(sheet: object): StyleSheetFields {
  return sheetRecord(sheet).fields;
}

// The adoptedStyleSheets binding mirrors a constructed sheet's rules into a
// hidden <style> per adopting document.
function attachSheetMirror(sheet: object, styleEl: Element): void {
  sheetRecords.get(sheet)?.backend.attachMirror?.(styleEl);
}
function detachSheetMirror(sheet: object, styleEl: Element): void {
  sheetRecords.get(sheet)?.backend.detachMirror?.(styleEl);
}

// StyleSheet has no constructor; CSSStyleSheet passes this.
const STYLE_SHEET_TOKEN = Symbol("kitesurfStyleSheet");

class StyleSheetCls implements Idl.StyleSheet {
  constructor(token?: symbol) {
    if (token !== STYLE_SHEET_TOKEN) throw new TypeError("Illegal constructor");
  }
  get type() {
    return "text/css";
  }
  get href() {
    return styleSheetFields(this).href;
  }
  get ownerNode(): StyleSheetFields["ownerNode"] {
    return styleSheetFields(this).ownerNode;
  }
  get parentStyleSheet() {
    return styleSheetFields(this).parentStyleSheet;
  }
  get title() {
    return styleSheetFields(this).title;
  }
  get media() {
    return styleSheetFields(this).media;
  }
  // [PutForwards=mediaText]
  set media(v: Idl.MediaList) {
    styleSheetFields(this).media.mediaText = String(v == null ? "" : v);
  }
  get disabled() {
    return styleSheetFields(this).disabled;
  }
  set disabled(v: boolean) {
    styleSheetFields(this).disabled = !!v;
  }
}

// Constructed sheets have no owner; adoption mirrors them into hidden
// `<style>` elements. `replace()` drops `@import`, and baseURL/media are ignored.
class CSSStyleSheetCtor extends StyleSheetCls implements Idl.CSSStyleSheet {
  constructor(options?: Idl.CSSStyleSheetInit) {
    super(STYLE_SHEET_TOKEN);
    const rules = makeRuleList([]);
    const mirrors = new Set<Element>();
    const rerender = () => {
      const text = rules.map((r) => r.cssText).join("\n");
      for (const styleEl of mirrors) {
        try {
          styleEl.textContent = text;
        } catch {}
      }
    };
    const backend: CSSStyleSheetBackend = {
      cssRules: () => rules,
      insertRule: (text, index) => {
        const i = index === undefined ? 0 : Number(index) >>> 0;
        if (i > rules.length) {
          throw new DOMException("Index out of bounds", "IndexSizeError");
        }
        const parsed = parseSingleRuleOrThrow(text);
        // Constructed sheets reject @import outright per CSSOM.
        if (classifyRuleKind(parsed) === "import") {
          throw new DOMException(
            "@import rules are not allowed in constructed stylesheets",
            "SyntaxError",
          );
        }
        const rule = constructRule(parsed, this, null, rerender);
        if (!rule) throw ruleSyntaxError(text);
        rules.splice(i, 0, rule);
        rerender();
        return i;
      },
      deleteRule: (index) => {
        const i = Number(index) >>> 0;
        if (i >= rules.length) {
          throw new DOMException("Index out of bounds", "IndexSizeError");
        }
        rules.splice(i, 1);
        rerender();
      },
      replaceSync: (text) => {
        rules.length = 0;
        for (const p of splitStylesheetRules(String(text == null ? "" : text))) {
          const k = classifyRuleKind(p);
          // @import is disallowed in constructed sheets; drop it (and
          // non-rules) during replace instead of throwing mid-way.
          if (k === "import" || !isConstructibleRuleKind(k)) continue;
          const rule = constructRule(p, this, null, rerender);
          if (rule) rules.push(rule);
        }
        rerender();
      },
      replace: (text) => {
        try {
          backend.replaceSync(text);
        } catch (e) {
          return Promise.reject(e);
        }
        return Promise.resolve(this);
      },
      attachMirror(styleEl) {
        mirrors.add(styleEl);
        // Push the current rules now so the cascade sees them on the next paint.
        try {
          styleEl.textContent = rules.map((r) => r.cssText).join("\n");
        } catch {}
      },
      detachMirror(styleEl) {
        mirrors.delete(styleEl);
      },
    };
    sheetRecords.set(this, {
      fields: {
        ownerNode: null,
        href: null,
        title: null,
        media: makeEmptyMediaList(),
        disabled: !!(options && options.disabled),
        ownerRule: null,
        parentStyleSheet: null,
      },
      backend,
    });
  }
  get ownerRule() {
    return styleSheetFields(this).ownerRule;
  }
  // [SameObject]: the list keeps its identity across reads.
  get cssRules(): RuleList {
    return sheetRecord(this).backend.cssRules();
  }
  get rules(): RuleList {
    return this.cssRules;
  }
  insertRule(rule: string, index?: number) {
    return sheetRecord(this).backend.insertRule(rule, index);
  }
  deleteRule(index: number) {
    sheetRecord(this).backend.deleteRule(index);
  }
  replace(text: string) {
    return sheetRecord(this).backend.replace(text);
  }
  replaceSync(text: string) {
    sheetRecord(this).backend.replaceSync(text);
  }
  // Legacy aliases: addRule returns -1, and removeRule's index defaults
  // to 0 instead of being required.
  addRule(selector?: string, style?: string, index?: number) {
    const sel = selector === undefined ? "undefined" : String(selector);
    const body = style === undefined || style === null ? "" : String(style);
    const i =
      index === undefined ? sheetRecord(this).backend.cssRules().length : Number(index) >>> 0;
    this.insertRule(sel + " { " + body + " }", i);
    return -1;
  }
  removeRule(index?: number) {
    this.deleteRule(index === undefined ? 0 : index);
  }
}

const CSSOM_GLOBALS = {
  CSSRule: CSSRuleInterface,
  CSSGroupingRule: CSSGroupingRuleCls,
  CSSConditionRule: CSSConditionRuleCls,
  CSSMediaRule: CSSMediaRuleCls,
  CSSSupportsRule: CSSSupportsRuleCls,
  CSSStyleRule: CSSStyleRuleCls,
  CSSImportRule: CSSImportRuleCls,
  CSSFontFaceRule: CSSFontFaceRuleCls,
  CSSFontPaletteValuesRule: CSSFontPaletteValuesRuleCls,
  CSSFontFeatureValuesRule: CSSFontFeatureValuesRuleCls,
  CSSLayerBlockRule: CSSLayerBlockRuleCls,
  CSSLayerStatementRule: CSSLayerStatementRuleCls,
  CSSNamespaceRule: CSSNamespaceRuleCls,
  CSSPageRule: CSSPageRuleCls,
  CSSMarginRule: CSSMarginRuleCls,
  CSSKeyframesRule: CSSKeyframesRuleCls,
  CSSKeyframeRule: CSSKeyframeRuleCls,
  CSSCounterStyleRule: CSSCounterStyleRuleCls,
  CSSStyleDeclaration: CSSStyleDeclarationCls,
  MediaList: MediaListCls,
  StyleSheet: StyleSheetCls,
  CSSStyleSheet: CSSStyleSheetCtor,
} as const;
for (const [n, C] of Object.entries(CSSOM_GLOBALS) as Array<[string, { prototype: object }]>) {
  Object.defineProperty(C, "name", { value: n, configurable: true });
  Object.defineProperty(C.prototype, Symbol.toStringTag, {
    value: n,
    writable: false,
    enumerable: false,
    configurable: true,
  });
}

// adoptedStyleSheets is an ObservableArray. Its proxy reconciles membership
// changes by creating/removing hidden `<style>` mirrors in the live document;
// those real nodes appear in styleSheets and participate in the paint cascade.
function makeAdoptedStyleSheets() {
  const arr: Idl.CSSStyleSheet[] = [];
  const mirrors = new WeakMap<object, Element>();
  function ensureMirror(sheet: Idl.CSSStyleSheet) {
    if (!sheet || typeof sheet !== "object") return;
    if (mirrors.has(sheet)) return;
    try {
      const styleEl = createElementInternal("style");
      styleEl.setAttribute("data-ks-adopted", "");
      const doc = liveDocument();
      const head = doc.head || doc.documentElement;
      if (head) head.appendChild(styleEl);
      mirrors.set(sheet, styleEl);
      attachSheetMirror(sheet, styleEl);
    } catch {}
  }
  function dropMirror(sheet: Idl.CSSStyleSheet) {
    const styleEl = mirrors.get(sheet);
    if (!styleEl) return;
    mirrors.delete(sheet);
    try {
      detachSheetMirror(sheet, styleEl);
      if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
    } catch {}
  }
  function reconcile(prevSet: Set<Idl.CSSStyleSheet>, nextSet: Set<Idl.CSSStyleSheet>) {
    for (const s of prevSet) if (!nextSet.has(s)) dropMirror(s);
    for (const s of nextSet) if (!prevSet.has(s)) ensureMirror(s);
  }
  function snapshotSet(a: readonly Idl.CSSStyleSheet[]) {
    const s = new Set<Idl.CSSStyleSheet>();
    for (const x of a) if (x != null) s.add(x);
    return s;
  }
  const proxy = new Proxy(arr, {
    get(t, prop, recv) {
      const mut = [
        "push",
        "pop",
        "shift",
        "unshift",
        "splice",
        "reverse",
        "sort",
        "fill",
        "copyWithin",
      ];
      if (typeof prop === "string" && mut.indexOf(prop) >= 0) {
        return function (...args: unknown[]) {
          const prev = snapshotSet(t);
          // SAFETY: the allowlist above restricts this lookup to Array mutators.
          const mutator = Reflect.get(Array.prototype, prop) as Function;
          const out: unknown = mutator.apply(t, args);
          reconcile(prev, snapshotSet(t));
          return out;
        };
      }
      return Reflect.get(t, prop, recv);
    },
    set(t, prop, value, recv) {
      const prev = snapshotSet(t);
      const ok = Reflect.set(t, prop, value, recv);
      if (ok) reconcile(prev, snapshotSet(t));
      return ok;
    },
    deleteProperty(t, prop) {
      const prev = snapshotSet(t);
      const ok = Reflect.deleteProperty(t, prop);
      if (ok) reconcile(prev, snapshotSet(t));
      return ok;
    },
  });
  return proxy;
}
export const adoptedStyleSheets = makeAdoptedStyleSheets();

function makeStyleSheetList(): ItemList<CSSStyleSheetCtor> {
  const list: CSSStyleSheetCtor[] = [];
  try {
    const ids = Array.from(dom.querySelectorAll("style, link"));
    for (const nid of ids) {
      const node = elementFor(nid);
      if (!node) continue;
      if (node.tagName === "LINK") {
        const rel = (node.getAttribute("rel") || "").toLowerCase();
        if (!rel.split(/\s+/).includes("stylesheet")) continue;
      }
      list.push(makeStyleSheetStub(node));
    }
  } catch {}
  Object.defineProperty(list, "item", {
    value: function item(index: unknown) {
      const i = typeof index === "number" ? index : 0;
      return list[i] || null;
    },
    configurable: true,
    enumerable: false,
    writable: true,
  });
  // SAFETY: item is installed on this same Array. Verified by cssom-rule-interfaces.e2e.test.ts.
  return list as ItemList<CSSStyleSheetCtor>;
}

function validateToken(token: unknown, fnName: string): string {
  const s = String(token);
  if (s.length === 0) {
    throw new DOMException(fnName + ": token cannot be the empty string", "SyntaxError");
  }
  if (ASCII_WHITESPACE.test(s)) {
    throw new DOMException(
      fnName + ": token contains ASCII whitespace ('" + s + "')",
      "InvalidCharacterError",
    );
  }
  return s;
}
// The spec's ordered set parser: split on ASCII whitespace, drop empty
// tokens and later duplicates.
function parseTokens(serialized: string | null): string[] {
  if (typeof serialized !== "string" || serialized.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of serialized.split(/[\u0009\u000a\u000c\u000d\u0020]+/)) {
    if (t.length === 0) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}
function makeDOMTokenList(
  read: () => string | null,
  write: (value: string) => void,
  supported?: ReadonlySet<string>,
): DOMTokenListCls {
  const target: DOMTokenListCls = Object.create(DOMTokenListCls.prototype);
  const getter = () => parseTokens(read());
  const proxy = new Proxy(target, {
    get(t, prop, receiver) {
      if (prop === "length") return getter().length;
      if (typeof prop === "string" && /^\d+$/.test(prop)) {
        const i = +prop;
        const tokens = getter();
        return i < tokens.length ? tokens[i] : undefined;
      }
      // WebIDL iterable<DOMString>: WPT DOMTokenList-iteration checks that
      // these are Array.prototype's own functions. finalizeInterface would
      // wrap them on the prototype, so the proxy serves them.
      if (prop === "values") return Array.prototype.values;
      if (prop === "keys") return Array.prototype.keys;
      if (prop === "entries") return Array.prototype.entries;
      if (prop === "forEach") return Array.prototype.forEach;
      return Reflect.get(t, prop, receiver);
    },
    set(t, prop, value) {
      // Indexed writes are rejected.
      if (typeof prop === "string" && /^\d+$/.test(prop)) return false;
      return Reflect.set(t, prop, value);
    },
    has(t, prop) {
      if (prop === "length") return true;
      if (typeof prop === "string" && /^\d+$/.test(prop)) {
        return +prop < getter().length;
      }
      if (prop === "values" || prop === "keys" || prop === "entries" || prop === "forEach")
        return true;
      return prop in t;
    },
    ownKeys() {
      const tokens = getter();
      const keys: (string | symbol)[] = [];
      for (let i = 0; i < tokens.length; i++) keys.push(String(i));
      keys.push("length");
      return keys;
    },
    getOwnPropertyDescriptor(t, prop) {
      if (prop === "length") {
        return {
          value: getter().length,
          writable: false,
          enumerable: false,
          configurable: true,
        };
      }
      if (typeof prop === "string" && /^\d+$/.test(prop)) {
        const i = +prop;
        const tokens = getter();
        if (i < tokens.length) {
          return {
            value: tokens[i],
            writable: false,
            enumerable: true,
            configurable: true,
          };
        }
      }
      return Reflect.getOwnPropertyDescriptor(t, prop);
    },
  });
  // Both are registered: a prototype method runs on the proxy, and the
  // set trap runs the value setter on the target.
  const state: TokenListState = { read, write, supported };
  tokenListStates.set(target, state);
  tokenListStates.set(proxy, state);
  return proxy;
}

// ----- NamedNodeMap -------------------------------------------------------
// Prototype methods keep own keys limited to indexes and attribute names.

// The map's backing state. list and byName are the owner's attribute
// snapshot, mutated in place so a held map sees setNamedItem and
// removeNamedItem. refresh re-syncs them when the document has mutated
// since the last read, which keeps the map live.
interface NamedNodeMapState {
  list: AttrCls[];
  byName: Record<string, AttrCls>;
  owner: Element | null;
  refresh: (() => void) | null;
}
const namedNodeMapStates = new WeakMap<object, NamedNodeMapState>();

// Syncs the map and returns its state, or undefined for a map that
// makeNamedNodeMap didn't create (NamedNodeMap.prototype itself).
function syncedNamedNodeMap(map: object): NamedNodeMapState | undefined {
  const state = namedNodeMapStates.get(map);
  state?.refresh?.();
  return state;
}

function ownerOrThrow(map: object, method: string): { state: NamedNodeMapState; owner: Element } {
  const state = namedNodeMapStates.get(map);
  if (!state?.owner) {
    throw new DOMException(
      method + ": NamedNodeMap is detached from an Element",
      "InvalidStateError",
    );
  }
  return { state, owner: state.owner };
}

function forgetAttr(state: NamedNodeMapState, attr: AttrCls): void {
  const idx = state.list.indexOf(attr);
  if (idx >= 0) state.list.splice(idx, 1);
  if (state.byName[attr.name] === attr) delete state.byName[attr.name];
}

// The supported property names skip names with uppercase letters only
// for an HTML element in an HTML document.
// https://dom.spec.whatwg.org/#ref-for-dfn-supported-property-names
function hidesUppercaseNames(list: AttrCls[]): boolean {
  const owner = list[0] && list[0]._ownerElement;
  const ownerNsEntry = owner && elemNs.get(owner._id);
  const isHtmlElement = !ownerNsEntry || ownerNsEntry.ns === "http://www.w3.org/1999/xhtml";
  const isHtmlDoc = !owner || elementOwnerIsHtml.get(owner._id) !== false;
  return isHtmlElement && isHtmlDoc;
}

// The proxy in makeNamedNodeMap serves the indexed and named reads.
class NamedNodeMapCls implements Idl.NamedNodeMap {
  readonly [index: number]: AttrCls | null;
  item(index: number) {
    const list = syncedNamedNodeMap(this)?.list;
    if (!list) return null;
    const idx = Number(index) >>> 0;
    return idx >= 0 && idx < list.length ? list[idx] : null;
  }
  getNamedItem(name: string) {
    const byName = syncedNamedNodeMap(this)?.byName;
    if (!byName || typeof name !== "string") return null;
    return byName[name] || null;
  }
  getNamedItemNS(ns: string | null, localName: string) {
    const list = syncedNamedNodeMap(this)?.list;
    if (!list || typeof localName !== "string") return null;
    const targetNs = ns === null || ns === undefined || ns === "" ? null : String(ns);
    for (const a of list) {
      const aNs = a.namespaceURI || null;
      if (aNs === targetNs && a.localName === localName) return a;
    }
    return null;
  }
  // The owner element does the work; the snapshot is then patched so a
  // held map sees the change without a re-read (WPT attributes.html).
  setNamedItem(attr: Idl.Attr) {
    const { state, owner } = ownerOrThrow(this, "setNamedItem");
    // SAFETY: page-visible Attr objects are created by this DOM shim as AttrCls.
    const localAttr = attr as AttrCls;
    const previous: AttrCls | null = owner.setAttributeNode(localAttr);
    if (previous && previous !== localAttr) forgetAttr(state, previous);
    if (state.list.indexOf(localAttr) === -1) state.list.push(localAttr);
    state.byName[localAttr.name] = localAttr;
    return previous || null;
  }
  setNamedItemNS(attr: Idl.Attr) {
    return this.setNamedItem(attr);
  }
  removeNamedItem(name: string) {
    const { state, owner } = ownerOrThrow(this, "removeNamedItem");
    const attr: AttrCls | null = state.byName[String(name)] || owner.getAttributeNode(String(name));
    if (!attr) {
      throw new DOMException(`removeNamedItem: no attribute named '${name}'`, "NotFoundError");
    }
    owner.removeAttributeNode(attr);
    forgetAttr(state, attr);
    return attr;
  }
  removeNamedItemNS(ns: string | null, localName: string) {
    const { state, owner } = ownerOrThrow(this, "removeNamedItemNS");
    const attr = this.getNamedItemNS(ns, localName);
    if (!attr) {
      throw new DOMException(
        `removeNamedItemNS: no attribute (${ns}, ${localName})`,
        "NotFoundError",
      );
    }
    owner.removeAttributeNode(attr);
    forgetAttr(state, attr);
    return attr;
  }
  get length() {
    return syncedNamedNodeMap(this)?.list.length ?? 0;
  }
  [Symbol.iterator](): ArrayIterator<AttrCls> {
    return (syncedNamedNodeMap(this)?.list ?? [])[Symbol.iterator]();
  }
}

function makeNamedNodeMap(
  list: AttrCls[],
  byName: Record<string, AttrCls>,
  owner: Element | null = null,
  refresh: (() => void) | null = null,
): NamedNodeMapCls {
  const target: NamedNodeMapCls = Object.create(NamedNodeMapCls.prototype);
  // Without an explicit owner, take the first attribute's owner element.
  if (!owner && list.length > 0 && list[0]._ownerElement) {
    owner = list[0]._ownerElement;
  }
  const state: NamedNodeMapState = { list, byName, owner, refresh };
  const sync = () => {
    refresh?.();
  };
  const proxy = new Proxy(target, {
    get(t, prop, receiver) {
      sync();
      if (typeof prop === "string" && /^\d+$/.test(prop)) {
        const i = +prop;
        return i < list.length ? list[i] : undefined;
      }
      // An attribute named like a prototype member (`item`, `length`,
      // `toString`) doesn't shadow it (WPT attributes-namednodemap.html).
      if (typeof prop === "string" && byName[prop] !== undefined && !(prop in t)) {
        return byName[prop];
      }
      return Reflect.get(t, prop, receiver);
    },
    set() {
      return false;
    },
    has(t, prop) {
      sync();
      if (typeof prop === "string" && /^\d+$/.test(prop)) {
        return +prop < list.length;
      }
      if (typeof prop === "string" && prop in byName) return true;
      return prop in t;
    },
    ownKeys() {
      sync();
      const keys: (string | symbol)[] = [];
      for (let i = 0; i < list.length; i++) keys.push(String(i));
      const hideUppercase = hidesUppercaseNames(list);
      for (const k of Object.keys(byName)) {
        if (hideUppercase && /[A-Z]/.test(k)) continue;
        keys.push(k);
      }
      return keys;
    },
    getOwnPropertyDescriptor(t, prop) {
      sync();
      if (typeof prop === "string" && /^\d+$/.test(prop)) {
        const i = +prop;
        if (i < list.length) {
          return {
            value: list[i],
            writable: false,
            enumerable: true,
            configurable: true,
          };
        }
      }
      // Agree with ownKeys on which names are own.
      if (
        typeof prop === "string" &&
        byName[prop] !== undefined &&
        !(hidesUppercaseNames(list) && /[A-Z]/.test(prop))
      ) {
        return {
          value: byName[prop],
          writable: false,
          enumerable: false,
          configurable: true,
        };
      }
      return Reflect.getOwnPropertyDescriptor(t, prop);
    },
  });
  // Prototype methods run with the proxy as `this`; internal code may
  // hold the target.
  namedNodeMapStates.set(target, state);
  namedNodeMapStates.set(proxy, state);
  return proxy;
}

function filterByQualifiedName(candidates: Element[], qname: string): Element[] {
  const asciiLower = qname.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const out: Element[] = [];
  for (const el of candidates) {
    const ns = el.namespaceURI || HTML_NS;
    const elNsEntry = elemNs.get(el._id);
    const elQname = elNsEntry ? elNsEntry.qname : el.localName || "";
    if (ns === HTML_NS) {
      if (elQname === asciiLower) out.push(el);
    } else {
      if (elQname === qname) out.push(el);
    }
  }
  return out;
}

function scopedQuerySelector(rootId: number, selector: unknown): Element | null {
  const all = scopedQuerySelectorAll(rootId, selector);
  return all.length > 0 ? all[0] : null;
}

const pseudoElementRegex =
  /(?<!:)::(?:first-line|first-letter|before|after|placeholder|selection|backdrop|marker|file-selector-button|cue|cue-region|target-text|spelling-error|grammar-error|highlight|part|slotted|view-transition|view-transition-group|view-transition-image-pair|view-transition-old|view-transition-new)(?![a-zA-Z0-9_-])|(?<!:):(?:first-line|first-letter|before|after)(?![a-zA-Z0-9_-])(?!\s*\()/;
export function selectorHasPseudoElement(selector: string): boolean {
  return pseudoElementRegex.test(selector);
}

function scopedQuerySelectorAll(rootId: number, selectorArg: unknown): NodeListCls<Element> {
  let selector: string;
  if (typeof selectorArg === "string") {
    selector = selectorArg;
  } else {
    try {
      selector = String(selectorArg);
    } catch {
      throw new DOMException(
        "Failed to execute 'querySelectorAll': selector argument is not a valid string",
        "SyntaxError",
      );
    }
  }
  if (selectorHasPseudoElement(selector)) {
    try {
      dom.querySelectorAll(selector);
    } catch (err) {
      // The wasm selector parser may throw any value, not just an Error.
      const e = err as { message?: unknown } | null | undefined;
      throw new DOMException(
        "Failed to execute 'querySelectorAll': '" +
          selector +
          "' is not a valid selector. " +
          (e && e.message ? e.message : String(e)),
        "SyntaxError",
      );
    }
    return makeStaticNodeList([]);
  }
  let ids: number[];
  try {
    ids = Array.from<number>(
      rootId === DOCUMENT_ID
        ? dom.querySelectorAll(selector)
        : dom.querySelectorAllInSubtree(rootId, selector),
    );
  } catch (err) {
    throw new DOMException(
      "Failed to execute 'querySelectorAll': '" +
        selector +
        "' is not a valid selector. " +
        (err && (err as Error).message ? (err as Error).message : String(err)),
      "SyntaxError",
    );
  }
  const matches: Element[] = [];
  for (const id of ids) {
    const el = elementFor(id);
    if (el) matches.push(el);
  }
  return makeStaticNodeList(matches);
}

const nodeListLenSym = Symbol.for("kitesurf.nodeListLength");
Object.defineProperty(NodeListCls.prototype, "length", {
  configurable: true,
  enumerable: false,
  get() {
    const v = this[nodeListLenSym];
    return typeof v === "number" ? v : 0;
  },
});

/** Creates a NodeList snapshot whose contents do not track later DOM changes. */
function makeStaticNodeList<T extends NodeBase>(items: ArrayLike<T>): NodeListCls<T> {
  // SAFETY: every numeric index and the length slot are installed before return.
  type WritableNodeList = {
    -readonly [K in keyof NodeListCls<T>]: NodeListCls<T>[K];
  } & { [nodeListLenSym]: number };
  const writable = Object.create(NodeListCls.prototype) as WritableNodeList;
  const snapshot = Array.from(items);
  const n = snapshot.length;
  for (let i = 0; i < n; i++) writable[i] = snapshot[i];
  writable[nodeListLenSym] = n;
  // item() reads the list through this getter, so give the static list one.
  nodeListGetters.set(writable, () => snapshot);
  return writable;
}

export {
  AttrCls,
  NodeListCls,
  DocumentFragmentImpl,
  ShadowRootImpl,
  mintShadowRoot,
  HtmlCollectionCls,
  HTMLFormControlsCollectionCls,
  HTMLOptionsCollectionCls,
  OPTIONS_OWNER_SYM,
  RadioNodeListCls,
  DOMTokenListCls,
  CSSRuleInterface,
  CSSStyleSheetCtor,
  styleSheetFields,
  CSSOM_GLOBALS,
  NamedNodeMapCls,
  makeNodeList,
  makeHtmlCollection,
  makeDOMTokenList,
  makeNamedNodeMap,
  makeStyleSheetStub,
  makeStyleSheetList,
  scopedQuerySelector,
  scopedQuerySelectorAll,
  makeStaticNodeList,
  filterByQualifiedName,
};

setCollectionsClasses(
  AttrCls,
  HTMLFormControlsCollectionCls,
  filterByQualifiedName,
  makeStyleSheetStub,
  HTMLOptionsCollectionCls,
  OPTIONS_OWNER_SYM,
);
