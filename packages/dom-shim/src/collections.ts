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
  liveDocument,
  windowObj,
  nodeFor,
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
import type { HTMLSelectElement } from "./element/forms/select.js";
import type { NodeBase } from "./node-base.js";
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
  isSameNode(other) {
    if (!other) return false;
    return this === other;
  }
  isEqualNode(other) {
    if (!other || other.nodeType !== ATTRIBUTE_NODE) return false;
    return (
      this._namespaceURI === other._namespaceURI &&
      this._localName === other._localName &&
      this._value === other._value
    );
  }
  get baseURI(): string | null {
    const owner = this._ownerElement;
    if (owner && typeof owner.baseURI === "string") return owner.baseURI;
    return windowDocumentBaseURI();
  }
  cloneNode(_deep) {
    const a = Object.create(AttrCls.prototype);
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
  lookupNamespaceURI(prefix) {
    const owner = this._ownerElement;
    if (!owner) return null;
    return owner.lookupNamespaceURI(prefix);
  }
  lookupPrefix(namespace) {
    const owner = this._ownerElement;
    if (!owner) return null;
    return owner.lookupPrefix(namespace);
  }
  isDefaultNamespace(namespace) {
    const ns = namespace === "" ? null : namespace;
    return this.lookupNamespaceURI(null) === ns;
  }
}

function windowDocumentBaseURI(): string | null {
  try {
    if (typeof windowObj !== "undefined" && windowObj.document) {
      const u = windowObj.document.baseURI;
      if (typeof u === "string") return u;
    }
  } catch {}
  return null;
}

// ----- NodeList -----------------------------------------------------------
// Live per-wrapper list; the proxy reflects current tree state. WPT checks
// Array.prototype method identity, and internal callers use aliases like findIndex.
class NodeListCls implements Idl.NodeList {
  readonly [index: number]: Idl.Node;
  declare readonly length: number;
  declare [Symbol.iterator]: () => ArrayIterator<Idl.Node>;
  declare keys: typeof Array.prototype.keys;
  declare values: typeof Array.prototype.values;
  declare entries: typeof Array.prototype.entries;
  declare forEach: typeof Array.prototype.forEach;
  declare findIndex: typeof Array.prototype.findIndex;
  declare find: typeof Array.prototype.find;
  declare indexOf: typeof Array.prototype.indexOf;
  declare includes: typeof Array.prototype.includes;
  declare map: typeof Array.prototype.map;
  declare filter: typeof Array.prototype.filter;
  declare slice: typeof Array.prototype.slice;
  declare some: typeof Array.prototype.some;
  declare every: typeof Array.prototype.every;
  declare reduce: typeof Array.prototype.reduce;
  declare concat: typeof Array.prototype.concat;
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
function makeNodeList(getList: () => NodeBase[], seqKey?: NodeListSeqKey): NodeListCls;
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
  constructor(nodeId, info) {
    if (typeof nodeId === "number" && info) {
      super(nodeId, info);
    } else {
      const id = dom.createElement("div");
      fragmentIds.add(id);
      super(id, dom.nodeInfo(id));
    }
  }
  get nodeType() {
    return DOCUMENT_FRAGMENT_NODE;
  }
  get nodeName() {
    return "#document-fragment";
  }
  get tagName(): undefined {
    return undefined;
  }
  cloneNode(deep) {
    const clone = createDocumentFragmentInternal();
    if (deep) {
      for (const child of Array.from<Idl.Node>(this.childNodes)) {
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
      return firstElementMatch(matches);
    } catch {}
    return null;
  }
}

function firstElementMatch(matches: Iterable<Idl.Node>): Idl.Element | null {
  for (const node of matches) {
    if (!node || node.nodeType !== ELEMENT_NODE) continue;
    // SAFETY: the wasm selector returns only element IDs.
    return node as Idl.Element;
  }
  return null;
}

// A shadow root backed by the wasm ShadowRoot node (attachShadow). It
// extends the fragment class so nodeType, nodeName and the queries fit.
// ShadowRoot has no constructor, so `new ShadowRoot()` throws; internal
// mints flip a one-shot token (mintShadowRoot).
let __shadowRootAllowConstruct = false;
// root.styleSheets is [SameObject].
const shadowStyleSheets = new WeakMap<ShadowRootImpl, EmptyStyleSheetList>();
class ShadowRootImpl extends DocumentFragmentImpl implements Idl.ShadowRoot {
  constructor(nodeId, info) {
    if (!__shadowRootAllowConstruct) {
      throw new TypeError("Illegal constructor");
    }
    __shadowRootAllowConstruct = false;
    super(nodeId, info);
  }
  get host() {
    const hostId = dom.shadowHostId(this._id);
    return hostId >= 0 ? nodeFor(hostId) : null;
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

function mintShadowRoot(nodeId: number, info: unknown): ShadowRootImpl {
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
  namedItem(name: string): Idl.RadioNodeList | Idl.Element | null;
  namedItem(name: string): Idl.RadioNodeList | Idl.Element | null {
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
    assertOptionCollectionItem(item);
    if (before === item) return;
    const refNode = optionsReference(this, before);
    if (refNode) {
      assertOptionsReferenceDescendant(select, refNode);
      insertOptionBefore(refNode, item);
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

function assertOptionCollectionItem(item: Idl.HTMLOptionElement | Idl.HTMLOptGroupElement): void {
  const tag = item && typeof item.tagName === "string" ? item.tagName.toLowerCase() : "";
  if (tag !== "option" && tag !== "optgroup") {
    throw new TypeError(
      "HTMLOptionsCollection.add: argument must be HTMLOptionElement or HTMLOptGroupElement",
    );
  }
}

function optionsReference(
  collection: object,
  before: Idl.HTMLElement | number | null | undefined,
): Idl.Element | null {
  if (before == null) return null;
  if (typeof before !== "number") return before;
  return optionReferenceAtIndex(collection, before);
}

function optionReferenceAtIndex(collection: object, before: number): Idl.Element | null {
  const index = Number(before) | 0;
  const list = htmlCollectionGetters.get(collection)?.();
  if (!Array.isArray(list)) return null;
  if (index < 0 || index >= list.length) return null;
  return list[index];
}

function assertOptionsReferenceDescendant(select: HTMLSelectElement, refNode: Idl.Element): void {
  let parent = refNode.parentNode;
  while (parent) {
    if (parent === select) return;
    parent = parent.parentNode;
  }
  const DOMExceptionImpl = ksGlobal.DOMException || Error;
  throw new DOMExceptionImpl(
    "HTMLOptionsCollection.add: before is not a descendant of the select",
    "NotFoundError",
  );
}

function insertOptionBefore(
  refNode: Idl.Element,
  item: Idl.HTMLOptionElement | Idl.HTMLOptGroupElement,
): void {
  // SAFETY: the ancestor walk validates normal nodes; keep the second read
  // so page-overridden parentNode getters retain their behavior.
  (refNode.parentNode as Idl.Node).insertBefore(item, refNode);
}

function removeOptionAtIndex(list: Element[] | undefined, index: number): void {
  if (!Array.isArray(list) || index < 0 || index >= list.length) return;
  removeOption(list[index]);
}

function removeOption(option: Element | undefined): void {
  if (option && option.parentNode) option.parentNode.removeChild(option);
}

const OPTIONS_COLLECTION_MAX = 100_000;
function optionsCollectionSet(
  select: HTMLSelectElement,
  prop: string,
  value: unknown,
  list: Element[],
) {
  const doc = select.ownerDocument || ksGlobal.document;
  if (prop === "length") return setOptionsCollectionLength(select, doc, value, list);
  return setOptionCollectionIndex(select, doc, prop, value, list);
}

function setOptionsCollectionLength(
  select: HTMLSelectElement,
  doc: typeof ksGlobal.document,
  value: unknown,
  list: Element[],
): boolean {
  const length = Math.min(OPTIONS_COLLECTION_MAX, Number(value) >>> 0);
  const currentLength = list.length;
  if (length > currentLength) appendOptionsToLength(select, doc, currentLength, length);
  else if (length < currentLength) removeOptionsFromLength(select, list, length, currentLength);
  return true;
}

function appendOptionsToLength(
  select: HTMLSelectElement,
  doc: typeof ksGlobal.document,
  currentLength: number,
  length: number,
): void {
  for (let index = currentLength; index < length; index++) {
    select.appendChild(doc.createElement("option"));
  }
}

function removeOptionsFromLength(
  select: HTMLSelectElement,
  list: Element[],
  length: number,
  currentLength: number,
): void {
  for (let index = currentLength - 1; index >= length; index--) {
    const option = list[index];
    if (option && option.parentNode) option.parentNode.removeChild(option);
  }
}

function setOptionCollectionIndex(
  select: HTMLSelectElement,
  doc: typeof ksGlobal.document,
  property: string,
  value: unknown,
  list: Element[],
): boolean {
  const idx = Number(property) >>> 0;
  if (value === null || value === undefined) {
    removeOptionAtIndex(list, idx);
    return true;
  }
  const option = optionFromCollectionValue(value);
  if (idx < list.length) replaceOptionAtIndex(list, idx, option);
  else appendOptionAtIndex(select, doc, list, idx, option);
  return true;
}

function optionFromCollectionValue(value: unknown): Idl.HTMLOptionElement {
  const tagName: unknown = value ? Reflect.get(Object(value), "tagName") : undefined;
  const tag = typeof tagName === "string" ? tagName.toLowerCase() : "";
  if (tag !== "option") {
    throw new TypeError("HTMLOptionsCollection: indexed value must be an HTMLOptionElement");
  }
  // SAFETY: the existing tag-name check accepts option-shaped values without branding them.
  return value as Idl.HTMLOptionElement;
}

function replaceOptionAtIndex(list: Element[], index: number, option: Idl.HTMLOptionElement): void {
  const current = list[index];
  if (current && current.parentNode) current.parentNode.replaceChild(option, current);
}

function appendOptionAtIndex(
  select: HTMLSelectElement,
  doc: typeof ksGlobal.document,
  list: Element[],
  index: number,
  option: Idl.HTMLOptionElement,
): void {
  const capped = Math.min(OPTIONS_COLLECTION_MAX, index);
  for (let i = list.length; i < capped; i++) {
    select.appendChild(doc.createElement("option"));
  }
  if (index <= OPTIONS_COLLECTION_MAX) select.appendChild(option);
}

// RadioNodeList is returned for repeated form-control names. Its value reads
// or sets the checked radio, even if other collection members are not radios.
function isRadio(node: Idl.Node): node is HTMLInputElement {
  return node instanceof HTMLInputElement && node.type === "radio";
}

class RadioNodeListCls extends NodeListCls implements Idl.RadioNodeList {
  get value() {
    return radioNodeListValue(this);
  }
  set value(v: string) {
    setRadioNodeListValue(this, v);
  }
  get [Symbol.toStringTag](): "RadioNodeList" {
    return "RadioNodeList";
  }
}

function radioNodeListValue(nodes: Iterable<Idl.Node>): string {
  try {
    for (const node of nodes) {
      const value = checkedRadioValue(node);
      if (value !== null) return value;
    }
  } catch {}
  return "";
}

function checkedRadioValue(node: Idl.Node): string | null {
  if (!isRadio(node) || !node.checked) return null;
  return node.value || "on";
}

function setRadioNodeListValue(nodes: Iterable<Idl.Node>, value: string): void {
  try {
    for (const node of nodes) {
      if (setMatchingRadio(node, value)) return;
    }
  } catch {}
}

function setMatchingRadio(node: Idl.Node, value: string): boolean {
  if (!isRadio(node) || (node.value || "on") !== String(value)) return false;
  node.checked = true;
  return true;
}

function htmlCollectionExposesName(el) {
  if (!el) return false;
  return el.namespaceURI === HTML_NS;
}
// The proxy maps live indexed and named properties and reports the same
// surface to enumeration and reflection traps.
type HtmlCollectionProxyTarget = HtmlCollectionCls & {
  [OPTIONS_OWNER_SYM]?: HTMLSelectElement;
};
const NO_HTML_COLLECTION_PROPERTY = Symbol("noHtmlCollectionProperty");
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
  function memoExposedNames(list) {
    const curSeq = ksState().mutationSeq | 0;
    if (cachedNames !== null && cachedNamesSeq === curSeq) return cachedNames;
    cachedNames = exposedNames(list);
    cachedNamesSeq = curSeq;
    return cachedNames;
  }

  function exposedNames(list) {
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
    if (protoCls === HTMLFormControlsCollectionCls) return formControlsNamedItem.call(t, name);
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
    if (isCollectionIndexName(prop)) return false;
    if (Object.prototype.hasOwnProperty.call(shadow, prop)) return false;
    if (prop in t) return false;
    return memoExposedNames(memoGetList()).includes(prop);
  }

  function isCollectionIndexName(prop: string): boolean {
    return /^\d+$/.test(prop) && Number(prop) < 4294967295;
  }

  function ownHtmlCollectionValue(t: object, prop: PropertyKey): unknown {
    if (Object.prototype.hasOwnProperty.call(shadow, prop)) return shadow[prop];
    if (prop === "length") return memoGetList().length;
    const indexValue = liveHtmlCollectionIndex(prop);
    if (indexValue !== NO_HTML_COLLECTION_PROPERTY) return indexValue;
    return ownTargetHtmlCollectionValue(t, prop);
  }

  function ownTargetHtmlCollectionValue(t: object, prop: PropertyKey): unknown {
    if (typeof prop === "symbol") return NO_HTML_COLLECTION_PROPERTY;
    if (!Object.prototype.hasOwnProperty.call(t, prop)) return NO_HTML_COLLECTION_PROPERTY;
    return Reflect.get(t, prop, proxy);
  }

  function liveHtmlCollectionIndex(prop: PropertyKey): unknown {
    if (typeof prop !== "string" || !/^\d+$/.test(prop)) return NO_HTML_COLLECTION_PROPERTY;
    return htmlCollectionIndexValue(Number(prop));
  }

  function htmlCollectionIndexValue(index: number): unknown {
    if (index >= 4294967295) return NO_HTML_COLLECTION_PROPERTY;
    const list = memoGetList();
    return index < list.length ? list[index] : undefined;
  }

  function getHtmlCollectionProperty(t: object, prop: PropertyKey, receiver: unknown): unknown {
    if (receiver === proxy) {
      const ownValue = ownHtmlCollectionValue(t, prop);
      if (ownValue !== NO_HTML_COLLECTION_PROPERTY) return ownValue;
    }
    if (isVisibleName(t, prop)) {
      const named = namedValue(t, prop, memoGetList());
      if (named) return named;
    }
    return Reflect.get(t, prop, receiver);
  }

  function setHtmlCollectionProperty(
    t: HtmlCollectionProxyTarget,
    prop: PropertyKey,
    value: unknown,
    receiver: unknown,
  ): boolean {
    if (receiver !== proxy) return Reflect.set(t, prop, value, receiver);
    const owner = t[OPTIONS_OWNER_SYM];
    if (!owner) return setHtmlCollectionExpando(prop, value);
    return setOwnedHtmlCollectionProperty(t, owner, prop, value, receiver);
  }

  function setOwnedHtmlCollectionProperty(
    t: HtmlCollectionProxyTarget,
    owner: HTMLSelectElement,
    prop: PropertyKey,
    value: unknown,
    receiver: unknown,
  ): boolean {
    if (isOptionsCollectionIndex(prop)) {
      return optionsCollectionSet(owner, String(prop), value, memoGetList());
    }
    if (prop === "selectedIndex") return Reflect.set(t, prop, value, receiver);
    return setHtmlCollectionExpando(prop, value);
  }

  function setHtmlCollectionExpando(prop: PropertyKey, value: unknown): boolean {
    if (typeof prop === "string" && /^\d+$/.test(prop)) return false;
    if (isVisibleStringName(prop)) return false;
    shadow[prop] = value;
    return true;
  }

  function isVisibleStringName(prop: PropertyKey): prop is string {
    return typeof prop === "string" && memoExposedNames(memoGetList()).includes(prop);
  }

  function isOptionsCollectionIndex(prop: PropertyKey): boolean {
    return prop === "length" || (typeof prop === "string" && /^\d+$/.test(prop));
  }

  function hasHtmlCollectionProperty(t: object, prop: PropertyKey): boolean {
    if (Object.prototype.hasOwnProperty.call(shadow, prop)) return true;
    if (prop === "length") return true;
    if (isNumericCollectionProperty(prop)) return +prop < memoGetList().length;
    return hasLiveIndexOrName(prop) || prop in t;
  }

  function isNumericCollectionProperty(prop: PropertyKey): prop is string {
    return typeof prop === "string" && /^\d+$/.test(prop);
  }

  function hasLiveIndexOrName(prop: PropertyKey): boolean {
    if (typeof prop !== "string") return false;
    if (/^\d+$/.test(prop)) return +prop < memoGetList().length;
    return memoExposedNames(memoGetList()).includes(prop);
  }

  function deleteHtmlCollectionProperty(t: object, prop: PropertyKey): boolean {
    if (deleteShadowProperty(prop)) return true;
    if (isLiveHtmlCollectionIndex(prop)) return false;
    if (isVisibleName(t, prop)) return false;
    return Reflect.deleteProperty(t, prop);
  }

  function deleteShadowProperty(prop: PropertyKey): boolean {
    if (!Object.prototype.hasOwnProperty.call(shadow, prop)) return false;
    delete shadow[prop];
    return true;
  }

  function isLiveHtmlCollectionIndex(prop: PropertyKey): boolean {
    return typeof prop === "string" && /^\d+$/.test(prop) && +prop < memoGetList().length;
  }

  function htmlCollectionOwnKeys(t: object, list: Element[]): (string | symbol)[] {
    const keys: (string | symbol)[] = [];
    for (let i = 0; i < list.length; i++) keys.push(String(i));
    for (const name of memoExposedNames(list)) {
      if (isVisibleName(t, name)) keys.push(name);
    }
    appendHtmlCollectionExpandos(t, keys);
    return keys;
  }

  function appendHtmlCollectionExpandos(t: object, keys: (string | symbol)[]): void {
    const seen = new Set(keys);
    for (const key of [...Object.keys(shadow), ...Object.getOwnPropertyNames(t)]) {
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
  }

  let proxy: HtmlCollectionProxyTarget;
  proxy = new Proxy(target, {
    get(t, prop, receiver) {
      return getHtmlCollectionProperty(t, prop, receiver);
    },
    set(t, prop, value, receiver) {
      return setHtmlCollectionProperty(t, prop, value, receiver);
    },
    has(t, prop) {
      return hasHtmlCollectionProperty(t, prop);
    },
    deleteProperty(t, prop) {
      return deleteHtmlCollectionProperty(t, prop);
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
      return htmlCollectionOwnKeys(t, memoGetList());
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
    updateToggledToken(state, cur, v, has, want);
    return want;
  }
  replace(token: string, newToken: string) {
    const state = tokenListState(this);
    // Both tokens are checked for emptiness before either is checked for
    // whitespace, so replace(" ", "") throws SyntaxError.
    const { oldToken, newToken: replacement } = validateReplacementTokens(token, newToken);
    const cur = parseTokens(state.read());
    const idx = cur.indexOf(oldToken);
    if (idx < 0) return false;
    // Replace in place; a later copy of newToken is dropped.
    cur[idx] = replacement;
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

function updateToggledToken(
  state: TokenListState,
  tokens: string[],
  token: string,
  hasToken: boolean,
  shouldHaveToken: boolean,
): void {
  if (shouldHaveToken && !hasToken) {
    tokens.push(token);
    writeTokens(state, tokens);
  } else if (!shouldHaveToken && hasToken) {
    writeTokens(
      state,
      tokens.filter((item) => item !== token),
    );
  }
}

function validateReplacementTokens(
  token: string,
  newToken: string,
): { oldToken: string; newToken: string } {
  const oldToken = String(token);
  const replacement = String(newToken);
  if (oldToken.length === 0 || replacement.length === 0) {
    throw new DOMException("replace: tokens cannot be the empty string", "SyntaxError");
  }
  if (ASCII_WHITESPACE.test(oldToken) || ASCII_WHITESPACE.test(replacement)) {
    throw new DOMException(
      "replace: tokens cannot contain ASCII whitespace",
      "InvalidCharacterError",
    );
  }
  return { oldToken, newToken: replacement };
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

interface ImportSupportsScanState {
  quote: string | null;
  skipNext: boolean;
}

function extractImportSupports(raw: string): { rest: string; supportsText: string | null } {
  const index = importSupportsStart(raw);
  if (index < 0) return { rest: raw, supportsText: null };
  const open = index + 8;
  const close = matchingSupportsParen(raw, open);
  if (close < 0) return { rest: raw, supportsText: null };
  return {
    rest: raw.slice(0, index) + raw.slice(close + 1),
    supportsText: raw.slice(open + 1, close).trim(),
  };
}

function importSupportsStart(raw: string): number {
  const state: ImportSupportsScanState = { quote: null, skipNext: false };
  for (let i = 0; i < raw.length; i++) {
    const supportsIndex = scanImportSupportsCharacter(raw, i, state);
    if (supportsIndex >= 0) return supportsIndex;
  }
  return -1;
}

function scanImportSupportsCharacter(
  raw: string,
  index: number,
  state: ImportSupportsScanState,
): number {
  const character = raw[index];
  if (state.quote) {
    skipQuotedImportCharacter(character, state);
    return -1;
  }
  if (character === '"' || character === "'") {
    state.quote = character;
    return -1;
  }
  return isImportSupportsStart(raw, index) ? index : -1;
}

function skipQuotedImportCharacter(character: string, state: ImportSupportsScanState): void {
  if (state.skipNext) {
    state.skipNext = false;
    return;
  }
  if (character === "\\") {
    state.skipNext = true;
    return;
  }
  if (character === state.quote) state.quote = null;
}

function isImportSupportsStart(raw: string, index: number): boolean {
  if (!/^supports\(/i.test(raw.slice(index, index + 9))) return false;
  const previous = index > 0 ? raw[index - 1] : " ";
  return /[\s)]/.test(previous);
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

function canonicalizedSelector(value: string | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function canonicalizePageSelectorListOrNull(prelude: unknown): string | null {
  const s = String(prelude == null ? "" : prelude);
  const cap = pageSelectorCanonicalizer();
  if (!cap) return null;
  return canonicalizePageSelector(cap, s);
}

function pageSelectorCanonicalizer(): ((selector: string) => string | undefined) | null {
  return opts && typeof opts.canonicalizePageSelectors === "function"
    ? opts.canonicalizePageSelectors
    : null;
}

function canonicalizePageSelector(
  canonicalize: (selector: string) => string | undefined,
  selector: string,
): string | null {
  try {
    return canonicalizedSelector(canonicalize(selector));
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
  return decodeAtKeywordName(s);
}

function decodeAtKeywordName(text: string): string | null {
  let name = "";
  for (let i = 1; i < text.length;) {
    const decoded = decodeAtKeywordCharacter(text, i);
    if (!decoded) return null;
    name += decoded.value;
    i = decoded.nextIndex;
  }
  return name ? name.toLowerCase() : null;
}

interface DecodedAtKeywordCharacter {
  value: string;
  nextIndex: number;
}

function decodeAtKeywordCharacter(text: string, index: number): DecodedAtKeywordCharacter | null {
  const character = text[index];
  if (/[a-zA-Z0-9_-]/.test(character)) {
    return { value: character, nextIndex: index + 1 };
  }
  if (!isValidAtKeywordEscape(text, index)) return null;
  return decodeAtKeywordEscape(text, index);
}

function isValidAtKeywordEscape(text: string, index: number): boolean {
  return text[index] === "\\" && index + 1 < text.length && !/[\n\r\f]/.test(text[index + 1]);
}

function decodeAtKeywordEscape(text: string, index: number): DecodedAtKeywordCharacter {
  const escapeIndex = index + 1;
  const hex = text.slice(escapeIndex).match(/^[0-9a-fA-F]{1,6}/)?.[0];
  if (!hex) return { value: text[escapeIndex], nextIndex: escapeIndex + 1 };
  const codePoint = Number.parseInt(hex, 16);
  const value = isInvalidCssEscapeCodePoint(codePoint) ? "\ufffd" : String.fromCodePoint(codePoint);
  const afterHexIndex = escapeIndex + hex.length;
  return { value, nextIndex: skipCssEscapeWhitespace(text, afterHexIndex) };
}

function isInvalidCssEscapeCodePoint(codePoint: number): boolean {
  return codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff);
}

function skipCssEscapeWhitespace(text: string, index: number): number {
  if (!/[\t\n\f\r ]/.test(text[index] || "")) return index;
  return text[index] === "\r" && text[index + 1] === "\n" ? index + 2 : index + 1;
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
defineCounterStyleAttribute("name", (self) => rs(self).name || "", setCounterStyleName);
for (const idlName of Object.keys(COUNTER_STYLE_IDL_TO_DESC)) {
  const descName = COUNTER_STYLE_IDL_TO_DESC[idlName];
  defineCounterStyleAttribute(
    idlName,
    (self) => {
      const descriptors = rs(self).descriptors;
      if (!descriptors) throw new TypeError("Illegal invocation");
      return descriptors.get(descName) || "";
    },
    (self, value) => setCounterStyleDescriptor(self, descName, value),
  );
}

function setCounterStyleName(self: CSSCounterStyleRuleCls, value: unknown): void {
  const state = rs(self);
  const parsed = parseCounterStyle(state.serialize(), "name", String(value));
  if (!parsed) return;
  state.name = parsed.name;
  if (state.onMutate) state.onMutate();
}

function setCounterStyleDescriptor(
  self: CSSCounterStyleRuleCls,
  descriptorName: string,
  value: unknown,
): void {
  const state = rs(self);
  const descriptors = state.descriptors;
  if (!descriptors) throw new TypeError("Illegal invocation");
  const parsedDescriptors = parsedCounterStyleDescriptors(state, descriptorName, value);
  if (!parsedDescriptors) return;
  replaceCounterStyleDescriptors(descriptors, parsedDescriptors);
  if (state.onMutate) state.onMutate();
}

function parsedCounterStyleDescriptors(
  state: RuleState,
  descriptorName: string,
  value: unknown,
): CounterStyleRuleDto["descriptors"] | null {
  const parsed = parseCounterStyle(state.serialize(), descriptorName, String(value));
  if (!parsed) return null;
  const descriptor = parsed.descriptors.find((item) => item.name === descriptorName);
  return descriptor ? parsed.descriptors : null;
}

function replaceCounterStyleDescriptors(
  target: Map<string, string>,
  descriptors: CounterStyleRuleDto["descriptors"],
): void {
  target.clear();
  for (const descriptor of descriptors) {
    target.set(descriptor.name, descriptor.value);
  }
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
  const descriptors = counterStyleDescriptorMap(parsedRule.descriptors);
  const st = counterStyleRuleState(parsedRule, parentSheet, parentRule, onMutate, descriptors);
  ruleState.set(rule, st);
  return rule;
}

function counterStyleDescriptorMap(
  descriptors: CounterStyleRuleDto["descriptors"],
): Map<string, string> {
  const result = new Map<string, string>();
  for (const descriptor of descriptors) result.set(descriptor.name, descriptor.value);
  return result;
}

function counterStyleRuleState(
  parsedRule: CounterStyleRuleDto,
  parentSheet: CSSStyleSheetCtor | null,
  parentRule: CSSRuleInterface | null,
  onMutate: (() => void) | null,
  descriptors: Map<string, string>,
): RuleState {
  const state: RuleState = {
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
      return (
        "@counter-style " + state.name + (parts.length ? " { " + parts.join(" ") + " }" : " { }")
      );
    },
  };
  return state;
}
interface StylesheetRuleScanState {
  text: string;
  out: ParsedRuleList;
  index: number;
  chunkStart: number;
  depth: number;
  parenDepth: number;
  braceOpenAt: number;
  inStr: string;
}

function splitStylesheetRules(src: unknown): ParsedRuleList {
  const text = String(src).replace(/\/\*[\s\S]*?\*\//g, "");
  const state: StylesheetRuleScanState = {
    text,
    out: Object.assign([] as ParsedRuleChunk[], { trailingGarbage: "", unbalanced: false }),
    index: 0,
    chunkStart: 0,
    depth: 0,
    parenDepth: 0,
    braceOpenAt: -1,
    inStr: "",
  };
  while (state.index < text.length) {
    state.index = scanStylesheetCharacter(state);
  }
  finishStylesheetRuleScan(state);
  return state.out;
}

function scanStylesheetCharacter(state: StylesheetRuleScanState): number {
  const character = state.text[state.index];
  if (state.inStr) return scanQuotedStylesheetCharacter(state, character);
  if (character === "\\") return state.index + 2;
  if (character === '"' || character === "'") {
    state.inStr = character;
    return state.index + 1;
  }
  return scanStylesheetSyntaxCharacter(state, character);
}

function scanQuotedStylesheetCharacter(state: StylesheetRuleScanState, character: string): number {
  if (character === "\\") return state.index + 2;
  if (character === state.inStr) state.inStr = "";
  return state.index + 1;
}

function scanStylesheetSyntaxCharacter(state: StylesheetRuleScanState, character: string): number {
  if (character === "(" || character === ")") {
    updateStylesheetParenDepth(state, character);
    return state.index + 1;
  }
  if (character === "{") return openStylesheetBrace(state);
  if (character === "}") return closeStylesheetBrace(state);
  return appendStylesheetStatement(state, character);
}

function updateStylesheetParenDepth(state: StylesheetRuleScanState, character: string): void {
  if (character === "(") state.parenDepth++;
  else if (state.parenDepth > 0) state.parenDepth--;
}

function openStylesheetBrace(state: StylesheetRuleScanState): number {
  if (state.depth === 0) state.braceOpenAt = state.index;
  state.depth++;
  return state.index + 1;
}

function closeStylesheetBrace(state: StylesheetRuleScanState): number {
  state.depth--;
  if (state.depth === 0 && state.braceOpenAt >= 0) appendStylesheetBlockRule(state);
  return state.index + 1;
}

function appendStylesheetBlockRule(state: StylesheetRuleScanState): void {
  const selectorText = state.text.slice(state.chunkStart, state.braceOpenAt).trim();
  const declText = state.text.slice(state.braceOpenAt + 1, state.index).trim();
  const cssText = selectorText
    ? selectorText + " { " + declText + " }"
    : state.text.slice(state.chunkStart, state.index + 1).trim();
  state.out.push({ cssText, selectorText, declText });
  state.chunkStart = state.index + 1;
  state.braceOpenAt = -1;
}

function appendStylesheetStatement(state: StylesheetRuleScanState, character: string): number {
  if (state.depth === 0 && state.parenDepth === 0 && character === ";") {
    const raw = state.text.slice(state.chunkStart, state.index + 1).trim();
    if (raw) state.out.push({ cssText: raw, selectorText: "", declText: "" });
    state.chunkStart = state.index + 1;
  }
  return state.index + 1;
}

function finishStylesheetRuleScan(state: StylesheetRuleScanState): void {
  const tail = state.text.slice(state.chunkStart).trim();
  state.out.trailingGarbage = tail.length > 0 ? tail : "";
  state.out.unbalanced = state.depth !== 0 || state.parenDepth !== 0 || state.inStr !== "";
}

function parseSingleRuleOrThrow(text: unknown): ParsedRuleChunk {
  const t = String(text == null ? "" : text);
  const split = splitStylesheetRules(t);
  assertSingleRule(split, t);
  const parsed = split[0];
  const kind = classifyRuleKind(parsed);
  assertSupportedRuleKind(kind, t);
  assertValidRuleSelector(parsed, kind);
  return parsed;
}

function assertSingleRule(split: ParsedRuleList, text: string): void {
  if (split.unbalanced || split.length !== 1 || split.trailingGarbage) {
    throw ruleSyntaxError(text);
  }
}

function assertSupportedRuleKind(kind: string, text: string): void {
  if (kind === "charset" || kind === "invalid" || kind === "margin") {
    throw ruleSyntaxError(text);
  }
}

function assertValidRuleSelector(parsed: ParsedRuleChunk, kind: string): void {
  if (kind === "style" && canonicalizeSelectorOrNull(parsed.selectorText) === null) {
    throw new DOMException(
      "Failed to parse CSS rule: invalid selector '" + parsed.selectorText + "'",
      "SyntaxError",
    );
  }
  assertValidPageSelector(parsed, kind);
}

function assertValidPageSelector(parsed: ParsedRuleChunk, kind: string): void {
  if (kind !== "page" || canonicalizePageSelectorListOrNull(pagePreludeOf(parsed)) !== null) return;
  throw new DOMException(
    "Failed to parse CSS rule: invalid @page selector '" + parsed.selectorText + "'",
    "SyntaxError",
  );
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
  initialDeclText,
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

function ruleParentFields(
  parentSheet: CSSStyleSheetCtor | null,
  parentRule: CSSRuleInterface | null,
  onMutate: (() => void) | null,
): Pick<RuleState, "parentRule" | "parentSheet" | "onMutate"> {
  return {
    parentRule: parentRule || null,
    parentSheet: parentSheet || null,
    onMutate: onMutate || null,
  };
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
    ...ruleParentFields(parentSheet, parentRule, onMutate),
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

type RuleConstructionBase = Pick<RuleState, "kind" | "parentRule" | "parentSheet" | "onMutate">;
interface RuleConstructionContext {
  parsed: ParsedRuleChunk;
  parentSheet: CSSStyleSheetCtor | null;
  parentRule: CSSRuleInterface | null;
  onMutate: (() => void) | null;
  kind: string;
  selectorText: string;
  rawText: string;
  base: RuleConstructionBase;
}
type RuleBuilder = (context: RuleConstructionContext) => AnyCssRule | null | undefined;

const RULE_BUILDERS = new Map<string, RuleBuilder>([
  ["style", buildStyleRule],
  ["media", buildGroupingRule],
  ["supports", buildGroupingRule],
  ["layer-block", buildLayerBlockRule],
  ["layer-statement", buildLayerStatementRule],
  ["import", buildImportRule],
  ["namespace", buildNamespaceRule],
  ["font-face", buildFontFaceRule],
  ["font-palette-values", buildFontPaletteValuesRule],
  ["font-feature-values", buildFontFeatureValuesRule],
  ["keyframes", buildKeyframesRule],
  ["page", buildPageRule],
  ["counter-style", buildCounterStyleRuleFromContext],
]);

function constructRule(
  parsed: ParsedRuleChunk,
  parentSheet: CSSStyleSheetCtor | null,
  parentRule: CSSRuleInterface | null,
  onMutate: (() => void) | null,
): AnyCssRule | null {
  const kind = classifyRuleKind(parsed);
  const context: RuleConstructionContext = {
    parsed,
    parentSheet,
    parentRule,
    onMutate,
    kind,
    selectorText: String(parsed.selectorText || ""),
    rawText: String(parsed.cssText || ""),
    base: { kind, ...ruleParentFields(parentSheet, parentRule, onMutate) },
  };
  const result = RULE_BUILDERS.get(kind)?.(context);
  return result === undefined ? buildUnknownRule(context) : result;
}

function createCssRule<T extends object>(constructor: { prototype: T }): T {
  return Object.create(constructor.prototype);
}

function notifyRuleMutation(state: RuleState): void {
  if (state.onMutate) state.onMutate();
}

function buildStyleRule(context: RuleConstructionContext): CSSStyleRuleCls {
  const rule = createCssRule(CSSStyleRuleCls);
  const style = makeRuleStyleDeclaration(
    context.parsed.declText || "",
    "style",
    ruleStyleBaseUrl(context.parentSheet),
  );
  const canonical = canonicalizeSelectorOrNull(context.selectorText);
  const state: RuleState = {
    ...context.base,
    typeNum: 1,
    selectorText: canonical !== null ? canonical : context.selectorText,
    style,
    childRules: makeRuleList([]),
    serialize() {
      const declarations = style.cssText;
      return state.selectorText + (declarations ? " { " + declarations + " }" : " { }");
    },
    serializeForCascade() {
      const declarations = ruleStyleCascadeText(style);
      return state.selectorText + (declarations ? " { " + declarations + " }" : " { }");
    },
  };
  attachRuleStyle(style, rule, () => notifyRuleMutation(state));
  ruleState.set(rule, state);
  return rule;
}

function buildGroupingRule(context: RuleConstructionContext): CSSMediaRuleCls | CSSSupportsRuleCls {
  const constructor = context.kind === "media" ? CSSMediaRuleCls : CSSSupportsRuleCls;
  const rule = createCssRule(constructor);
  const condition = context.selectorText.replace(/^@(media|supports)/i, "").trim();
  const state: RuleState = {
    ...context.base,
    typeNum: context.kind === "media" ? 4 : 12,
    conditionText: condition,
    media: context.kind === "media" ? makeMediaList(condition, context.onMutate) : undefined,
    childRules: undefined,
    serialize() {
      const text = state.media ? state.media.mediaText : state.conditionText;
      return "@" + context.kind + (text ? " " + text : "") + serializeChildBlock(state.childRules);
    },
    serializeForCascade() {
      const text = state.media ? state.media.mediaText : state.conditionText;
      return (
        "@" + context.kind + (text ? " " + text : "") + serializeChildBlock(state.childRules, true)
      );
    },
  };
  ruleState.set(rule, state);
  state.childRules = parseChildRules(
    context.parsed.declText,
    context.parentSheet,
    rule,
    context.onMutate,
  );
  return rule;
}

function buildLayerBlockRule(context: RuleConstructionContext): CSSLayerBlockRuleCls {
  const rule = createCssRule(CSSLayerBlockRuleCls);
  const state: RuleState = {
    ...context.base,
    typeNum: 0,
    name: context.selectorText.replace(/^@layer/i, "").trim(),
    childRules: undefined,
    serialize() {
      return (
        "@layer" + (state.name ? " " + state.name : "") + serializeChildBlock(state.childRules)
      );
    },
    serializeForCascade() {
      return (
        "@layer" +
        (state.name ? " " + state.name : "") +
        serializeChildBlock(state.childRules, true)
      );
    },
  };
  ruleState.set(rule, state);
  state.childRules = parseChildRules(
    context.parsed.declText,
    context.parentSheet,
    rule,
    context.onMutate,
  );
  return rule;
}

function buildLayerStatementRule(context: RuleConstructionContext): CSSLayerStatementRuleCls {
  const rule = createCssRule(CSSLayerStatementRuleCls);
  const names = context.rawText
    .replace(/^@layer/i, "")
    .replace(/;\s*$/, "")
    .trim();
  const list = names
    ? names
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
    : [];
  const state: RuleState = {
    ...context.base,
    typeNum: 0,
    nameList: Object.freeze(list.slice()),
    serialize() {
      return "@layer " + list.join(", ") + ";";
    },
  };
  ruleState.set(rule, state);
  return rule;
}

function buildImportRule(context: RuleConstructionContext): AnyCssRule | undefined {
  const supports = extractImportSupports(context.rawText);
  const match = supports.rest.match(
    /^@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"']*))\s*\)|"([^"]*)"|'([^']*)')\s*(layer(?:\(([^)]*)\))?)?\s*(?:supports\(([\s\S]*?)\))?\s*([^;]*);?\s*$/i,
  );
  if (!match) return undefined;
  return constructImportRule(context, supports, match);
}

function constructImportRule(
  context: RuleConstructionContext,
  supports: { rest: string; supportsText: string | null },
  match: RegExpMatchArray,
): CSSImportRuleCls {
  const rule = createCssRule(CSSImportRuleCls);
  const href = importHref(match);
  const layerName = importLayerName(match);
  const supportsText = importSupportsText(supports, match);
  const media = makeMediaList((match[9] || "").trim(), context.onMutate);
  const importedSheet = new CSSStyleSheetCtor();
  const state: RuleState = {
    ...context.base,
    typeNum: 3,
    href,
    layerName,
    supportsText,
    media,
    styleSheet: importedSheet,
    serialize() {
      return serializeImportRule(state, href, media);
    },
  };
  ruleState.set(rule, state);
  const imported = styleSheetFields(importedSheet);
  imported.ownerRule = rule;
  imported.href = href;
  imported.parentStyleSheet = context.parentSheet || null;
  return rule;
}

function importHref(match: RegExpMatchArray): string {
  const quoted = firstDefinedCapture(match[1], match[2]);
  if (quoted !== undefined) return quoted;
  if (match[3] !== undefined) return match[3].trim();
  return firstDefinedCapture(match[4], match[5]) ?? "";
}

function firstDefinedCapture(
  first: string | undefined,
  second: string | undefined,
): string | undefined {
  return first !== undefined ? first : second;
}

function importLayerName(match: RegExpMatchArray): string | null {
  if (!match[6]) return null;
  return match[7] !== undefined ? match[7].trim() : "";
}

function importSupportsText(
  supports: { supportsText: string | null },
  match: RegExpMatchArray,
): string | null {
  if (supports.supportsText !== null) return supports.supportsText;
  return match[8] !== undefined ? match[8].trim() : null;
}

function serializeImportRule(state: RuleState, href: string, media: MediaListCls): string {
  let text = '@import url("' + href + '")';
  if (state.layerName !== null) {
    text += state.layerName === "" ? " layer" : " layer(" + state.layerName + ")";
  }
  if (state.supportsText !== null) text += " supports(" + state.supportsText + ")";
  const mediaText = media.mediaText;
  if (mediaText) text += " " + mediaText;
  return text + ";";
}

function buildNamespaceRule(context: RuleConstructionContext): AnyCssRule | undefined {
  const match = context.rawText.match(
    /^@namespace\s+(?:([a-zA-Z_][\w-]*)\s+)?(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"']*))\s*\)|"([^"]*)"|'([^']*)')\s*;?\s*$/i,
  );
  if (!match) return undefined;
  return constructNamespaceRule(context, match);
}

function constructNamespaceRule(
  context: RuleConstructionContext,
  match: RegExpMatchArray,
): CSSNamespaceRuleCls {
  const rule = createCssRule(CSSNamespaceRuleCls);
  const uri = namespaceUri(match);
  const state: RuleState = {
    ...context.base,
    typeNum: 10,
    prefix: match[1] || "",
    namespaceURI: uri,
    serialize() {
      return "@namespace " + (state.prefix ? state.prefix + " " : "") + 'url("' + uri + '");';
    },
  };
  ruleState.set(rule, state);
  return rule;
}

function namespaceUri(match: RegExpMatchArray): string {
  const quoted = firstDefinedCapture(match[2], match[3]);
  if (quoted !== undefined) return quoted;
  if (match[4] !== undefined) return match[4].trim();
  return firstDefinedCapture(match[5], match[6]) ?? "";
}

function buildFontFaceRule(context: RuleConstructionContext): CSSFontFaceRuleCls {
  const rule = createCssRule(CSSFontFaceRuleCls);
  const style = makeRuleStyleDeclaration(
    context.parsed.declText || "",
    "font-face",
    ruleStyleBaseUrl(context.parentSheet),
  );
  const state: RuleState = {
    ...context.base,
    typeNum: 5,
    style,
    serialize() {
      const declarations = style.cssText;
      return "@font-face" + (declarations ? " { " + declarations + " }" : " { }");
    },
    serializeForCascade() {
      const declarations = ruleStyleCascadeText(style);
      return "@font-face" + (declarations ? " { " + declarations + " }" : " { }");
    },
  };
  attachRuleStyle(style, rule, () => notifyRuleMutation(state));
  ruleState.set(rule, state);
  return rule;
}

function buildFontPaletteValuesRule(context: RuleConstructionContext): CSSFontPaletteValuesRuleCls {
  const rule = createCssRule(CSSFontPaletteValuesRuleCls);
  const declarations: Record<string, string> = Object.create(null);
  parseCssTextInto(context.parsed.declText || "", declarations);
  const state: RuleState = {
    ...context.base,
    typeNum: 0,
    name: context.selectorText.replace(/^@font-palette-values/i, "").trim(),
    declBag: declarations,
    serialize() {
      return serializeFontPaletteValues(state, declarations);
    },
  };
  ruleState.set(rule, state);
  return rule;
}

function serializeFontPaletteValues(
  state: RuleState,
  declarations: Record<string, string>,
): string {
  const parts: string[] = [];
  for (const key of Object.keys(declarations)) {
    parts.push(cssPropCamelToKebab(key) + ": " + declarations[key] + ";");
  }
  return (
    "@font-palette-values " + state.name + (parts.length ? " { " + parts.join(" ") + " }" : " { }")
  );
}

function buildFontFeatureValuesRule(context: RuleConstructionContext): CSSFontFeatureValuesRuleCls {
  const rule = createCssRule(CSSFontFeatureValuesRuleCls);
  const onMutateRef: { fn: (() => void) | null } = { fn: null };
  const features = createFeatureValueMaps(onMutateRef);
  addFeatureValuesFromText(String(context.parsed.declText || ""), features);
  onMutateRef.fn = context.onMutate || null;
  const state: RuleState = {
    ...context.base,
    typeNum: 14,
    name: context.selectorText.replace(/^@font-feature-values/i, "").trim(),
    features,
    serialize() {
      return serializeFontFeatureValues(state, features);
    },
  };
  ruleState.set(rule, state);
  return rule;
}

function createFeatureValueMaps(onMutateRef: {
  fn: (() => void) | null;
}): Record<string, FeatureValuesMap> {
  const features: Record<string, FeatureValuesMap> = {};
  for (const type of FEATURE_TYPES) features[type] = makeFeatureValuesMap(onMutateRef).api;
  return features;
}

function addFeatureValuesFromText(text: string, features: Record<string, FeatureValuesMap>): void {
  for (const rule of splitStylesheetRules(text)) addFeatureValuesFromRule(rule, features);
}

function addFeatureValuesFromRule(
  rule: ParsedRuleChunk,
  features: Record<string, FeatureValuesMap>,
): void {
  const type = featureTypeFromPrelude(String(rule.selectorText || ""));
  if (!type) return;
  const target = features[type];
  for (const declaration of String(rule.declText || "").split(";")) {
    addFeatureValue(target, declaration);
  }
}

function featureTypeFromPrelude(prelude: string): string | null {
  const match = prelude.match(/^@([a-zA-Z-]+)$/);
  if (!match) return null;
  const type = match[1].toLowerCase();
  return FEATURE_TYPES.includes(type) ? type : null;
}

function addFeatureValue(target: FeatureValuesMap, declaration: string): void {
  const colon = declaration.indexOf(":");
  if (colon <= 0) return;
  const name = declaration.slice(0, colon).trim();
  const values = declaration
    .slice(colon + 1)
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter((value) => !Number.isNaN(value));
  if (name && values.length) target.set(name, values);
}

function serializeFontFeatureValues(
  state: RuleState,
  features: Record<string, FeatureValuesMap>,
): string {
  const blocks: string[] = [];
  for (const type of FEATURE_TYPES) appendFeatureBlock(blocks, type, features[type]);
  return (
    "@font-feature-values " +
    state.name +
    (blocks.length ? " { " + blocks.join(" ") + " }" : " { }")
  );
}

function appendFeatureBlock(blocks: string[], type: string, map: FeatureValuesMap): void {
  if (!map.size) return;
  const entries: string[] = [];
  map.forEach((values, name) => entries.push(name + ": " + values.join(" ") + ";"));
  blocks.push("@" + type + " { " + entries.join(" ") + " }");
}

function buildKeyframesRule(context: RuleConstructionContext): CSSKeyframesRuleCls {
  const rule = createCssRule(CSSKeyframesRuleCls);
  const state: RuleStateWith<"childRules"> = {
    ...context.base,
    typeNum: 7,
    name: context.selectorText.replace(/^@(-webkit-)?keyframes/i, "").trim(),
    childRules: makeRuleList([]),
    serialize() {
      return "@keyframes " + state.name + serializeChildBlock(state.childRules);
    },
    serializeForCascade() {
      return "@keyframes " + state.name + serializeChildBlock(state.childRules, true);
    },
  };
  ruleState.set(rule, state);
  appendKeyframeRules(state.childRules, context, rule);
  return rule;
}

function appendKeyframeRules(
  rules: RuleList,
  context: RuleConstructionContext,
  parentRule: CSSKeyframesRuleCls,
): void {
  for (const parsed of splitStylesheetRules(String(context.parsed.declText || ""))) {
    if (!parsed.selectorText) continue;
    rules.push(constructKeyframe(parsed, context.parentSheet, parentRule, context.onMutate));
  }
}

function buildPageRule(context: RuleConstructionContext): CSSPageRuleCls | null {
  const canonicalSelector = canonicalizePageSelectorListOrNull(pagePreludeOf(context.parsed));
  if (canonicalSelector === null) return null;
  return createPageRule(context, canonicalSelector);
}

function createPageRule(
  context: RuleConstructionContext,
  canonicalSelector: string,
): CSSPageRuleCls {
  const rule = createCssRule(CSSPageRuleCls);
  const declarations: string[] = [];
  const childRules = makeRuleList([]);
  const pageBody = splitStylesheetRules(context.parsed.declText || "");
  for (const part of pageBody) {
    appendPageRulePart(part, declarations, childRules, rule, context);
  }
  appendPageRuleTrailingGarbage(pageBody, declarations);
  const style = makeRuleStyleDeclaration(
    declarations.join(" "),
    "page",
    ruleStyleBaseUrl(context.parentSheet),
  );
  const state: RuleState = {
    ...context.base,
    typeNum: 6,
    selectorText: canonicalSelector,
    style,
    childRules,
    serialize() {
      return serializePageRule(state, style.cssText, childRules, false);
    },
    serializeForCascade() {
      return serializePageRule(state, ruleStyleCascadeText(style), childRules, true);
    },
  };
  attachRuleStyle(style, rule, () => notifyRuleMutation(state));
  ruleState.set(rule, state);
  return rule;
}

function appendPageRulePart(
  part: ParsedRuleChunk,
  declarations: string[],
  childRules: RuleList,
  rule: CSSPageRuleCls,
  context: RuleConstructionContext,
): void {
  const marginName = marginRuleNameOf(part.selectorText);
  if (marginName) {
    childRules.push(
      constructMarginRule(part, marginName, context.parentSheet, rule, context.onMutate),
    );
  } else if (!part.selectorText && !/^@/.test(String(part.cssText || "").trim())) {
    declarations.push(String(part.cssText));
  }
}

function appendPageRuleTrailingGarbage(pageBody: ParsedRuleList, declarations: string[]): void {
  if (pageBody.trailingGarbage && !/^@/.test(pageBody.trailingGarbage)) {
    declarations.push(pageBody.trailingGarbage);
  }
}

function serializePageRule(
  state: RuleState,
  declarationText: string,
  childRules: RuleList,
  forCascade: boolean,
): string {
  const parts: string[] = [];
  if (declarationText) parts.push(declarationText);
  for (const rule of childRules) parts.push(pageChildRuleText(rule, forCascade));
  const body = parts.join(" ");
  return (
    "@page" +
    (state.selectorText ? " " + state.selectorText : "") +
    (body ? " { " + body + " }" : " { }")
  );
}

function pageChildRuleText(rule: AnyCssRule, forCascade: boolean): string {
  return forCascade ? ruleTextForCascade(rule) : String(rule.cssText);
}

function buildCounterStyleRuleFromContext(
  context: RuleConstructionContext,
): CSSCounterStyleRuleCls | null {
  return constructCounterStyleRule(
    context.parsed,
    context.parentSheet,
    context.parentRule,
    context.onMutate,
  );
}

function buildUnknownRule(context: RuleConstructionContext): CSSUnknownRuleCls {
  const rule = createCssRule(CSSUnknownRuleCls);
  const state: RuleState = {
    ...context.base,
    typeNum: 0,
    serialize() {
      return serializeUnknownRule(context);
    },
  };
  ruleState.set(rule, state);
  return rule;
}

function serializeUnknownRule(context: RuleConstructionContext): string {
  if (context.selectorText) {
    const declarations = String(context.parsed.declText || "")
      .replace(/\s+/g, " ")
      .trim();
    return context.selectorText + (declarations ? " { " + declarations + " }" : " { }");
  }
  return context.rawText.replace(/\s+/g, " ").trim();
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
    const e = new Error(message);
    e.name = "SecurityError";
    return e;
  }
}

interface DocumentStyleSheetRuntime {
  ownerNode: Element | ParsedElement | null;
  id: number;
  isStyleEl: boolean;
  isLinkEl: boolean;
  rules: RuleList;
  lastParsedText: string | null;
  mirrorTextId: number;
  linkRulesLoaded: boolean;
  href: string | null;
  sheet: CSSStyleSheetCtor;
}

function styleSheetNodeId(ownerNode: Element | ParsedElement | null): number {
  return ownerNode && typeof ownerNode._id === "number" ? ownerNode._id : -1;
}

function cachedStyleSheetForNode(
  ownerNode: Element | ParsedElement | null,
  id: number,
): CSSStyleSheetCtor | null {
  if (ownerNode && id >= 0) {
    const cached = sheetCache.get(ownerNode);
    if (cached) return cached;
  }
  return null;
}

function rememberStyleSheetForNode(
  ownerNode: Element | ParsedElement | null,
  id: number,
  sheet: CSSStyleSheetCtor,
): void {
  if (ownerNode && id >= 0) sheetCache.set(ownerNode, sheet);
}

function isStyleSheetElement(ownerNode: Element | ParsedElement | null): boolean {
  return Boolean(ownerNode && ownerNode.tagName === "STYLE");
}

function isLinkStyleSheetElement(ownerNode: Element | ParsedElement | null): boolean {
  return Boolean(ownerNode && ownerNode.tagName === "LINK");
}

function makeStyleSheetRuleList(): RuleList {
  const rules: AnyCssRule[] = [];
  Object.defineProperty(rules, "item", {
    value: function item(index: unknown) {
      const ruleIndex = typeof index === "number" ? index : 0;
      return rules[ruleIndex] || null;
    },
    configurable: true,
    enumerable: false,
    writable: true,
  });
  // SAFETY: this non-enumerable item method completes the same Array's RuleList view.
  return rules as RuleList;
}

function stylesheetBaseUrl(): string {
  const global = ksGlobal;
  const documentBase = global.document && global.document.baseURI;
  if (documentBase) return documentBase;
  return global.location ? global.location.href : "";
}

function isLinkNodeWithGetAttribute(
  ownerNode: Element | ParsedElement | null,
  isLinkEl: boolean,
): ownerNode is Element | ParsedElement {
  return isLinkEl && ownerNode !== null && typeof ownerNode.getAttribute === "function";
}

function resolveStyleSheetHref(rawHref: string): string {
  try {
    const base = stylesheetBaseUrl();
    return new URL(rawHref, base || undefined).href;
  } catch {
    return rawHref;
  }
}

function styleSheetHref(
  ownerNode: Element | ParsedElement | null,
  isLinkEl: boolean,
): string | null {
  if (!isLinkNodeWithGetAttribute(ownerNode, isLinkEl)) return null;
  const raw = ownerNode.getAttribute("href");
  if (!raw) return null;
  return resolveStyleSheetHref(raw);
}

function styleSheetTitle(ownerNode: Element | ParsedElement | null): string | null {
  return ownerNode && typeof ownerNode.getAttribute === "function"
    ? ownerNode.getAttribute("title") || null
    : null;
}

function createDocumentStyleSheetRuntime(
  ownerNode: Element | ParsedElement | null,
  id: number,
  isStyleEl: boolean,
  isLinkEl: boolean,
  rules: RuleList,
  href: string | null,
  sheet: CSSStyleSheetCtor,
): DocumentStyleSheetRuntime {
  return {
    ownerNode,
    id,
    isStyleEl,
    isLinkEl,
    rules,
    lastParsedText: null,
    mirrorTextId: -1,
    linkRulesLoaded: false,
    href,
    sheet,
  };
}

function canReadStyleNodeText(state: DocumentStyleSheetRuntime): boolean {
  return state.isStyleEl && state.id >= 0 && Boolean(dom.textContent);
}

function readStyleNodeText(state: DocumentStyleSheetRuntime): string {
  if (!canReadStyleNodeText(state)) return "";
  try {
    return String(dom.textContent(state.id) || "");
  } catch {
    return "";
  }
}

function canMirrorStyleSheetToDom(state: DocumentStyleSheetRuntime): boolean {
  return state.isStyleEl && state.id >= 0;
}

function remirrorStyleSheet(state: DocumentStyleSheetRuntime): void {
  if (!canMirrorStyleSheetToDom(state)) return;
  try {
    const text = state.rules.map(ruleTextForCascade).join("\n");
    writeStyleSheetMirror(state, text);
    state.lastParsedText = text;
    bumpMutationSeq();
  } catch {}
}

type StyleSheetChildIds = NonNullable<ReturnType<NonNullable<typeof dom.childIds>>>;

function mirrorHasOnlyTextChild(
  children: StyleSheetChildIds | null,
  mirrorTextId: number,
): boolean {
  return children !== null && children.length === 1 && children[0] === mirrorTextId;
}

function canReuseStyleSheetMirror(
  state: DocumentStyleSheetRuntime,
  children: StyleSheetChildIds | null,
): boolean {
  if (state.mirrorTextId < 0) return false;
  if (!mirrorHasOnlyTextChild(children, state.mirrorTextId)) return false;
  if (hasLiveWrapper(state.mirrorTextId)) return false;
  return typeof dom.setNodeText === "function";
}

function updateReusableStyleSheetMirror(state: DocumentStyleSheetRuntime, text: string): void {
  if (text) {
    dom.setNodeText(state.mirrorTextId, text);
  } else {
    dom.removeNode(state.mirrorTextId);
    dropUnwrappedSubtrees([state.mirrorTextId]);
    state.mirrorTextId = -1;
  }
}

function removeStyleSheetMirrorChildren(children: StyleSheetChildIds | null): void {
  if (!children) return;
  for (const childId of children) dom.removeNode(childId);
  dropUnwrappedSubtrees(children);
}

function appendStyleSheetMirrorText(state: DocumentStyleSheetRuntime, text: string): void {
  if (!text) return;
  state.mirrorTextId = dom.createTextNode(text);
  dom.appendChildNode(state.id, state.mirrorTextId);
}

function writeStyleSheetMirror(state: DocumentStyleSheetRuntime, text: string): void {
  // Reuse the unwrapped mirror node to avoid leaving detached nodes in Blitz's slab.
  const children = dom.childIds ? dom.childIds(state.id) : null;
  if (canReuseStyleSheetMirror(state, children)) {
    updateReusableStyleSheetMirror(state, text);
    return;
  }
  removeStyleSheetMirrorChildren(children);
  state.mirrorTextId = -1;
  appendStyleSheetMirrorText(state, text);
}

function reparseStyleSheetFromText(state: DocumentStyleSheetRuntime, text: string): void {
  state.rules.length = 0;
  for (const parsed of splitStylesheetRules(text)) {
    if (!isConstructibleRuleKind(classifyRuleKind(parsed))) continue;
    const rule = constructRule(parsed, state.sheet, null, () => remirrorStyleSheet(state));
    if (rule) state.rules.push(rule);
  }
  state.lastParsedText = text;
}

function syncLinkStyleSheet(state: DocumentStyleSheetRuntime, strict: boolean): void {
  if (state.linkRulesLoaded || state.id < 0 || !getExternalSheetRules) return;
  let response: ReturnType<NonNullable<typeof getExternalSheetRules>> | null = null;
  try {
    response = getExternalSheetRules(state.id);
  } catch {
    return;
  }
  if (!response) return;
  if (response.state === "denied") {
    if (strict) {
      throw securityError(
        "Failed to access rules of 'CSSStyleSheet': the stylesheet is " +
          "cross-origin and was not fetched with CORS",
      );
    }
    return;
  }
  if (response.state !== "clean") return;
  reparseStyleSheetFromText(state, String(response.text || ""));
  state.linkRulesLoaded = true;
}

function syncDocumentStyleSheet(state: DocumentStyleSheetRuntime, strict = false): void {
  if (state.isLinkEl) return syncLinkStyleSheet(state, strict);
  if (!state.isStyleEl) return;
  const text = readStyleNodeText(state);
  if (text !== state.lastParsedText) reparseStyleSheetFromText(state, text);
}

function documentStyleSheetFields(
  ownerNode: Element | ParsedElement | null,
  href: string | null,
): StyleSheetFields {
  return {
    ownerNode: ownerNode || null,
    href,
    title: styleSheetTitle(ownerNode),
    media: makeEmptyMediaList(),
    disabled: false,
    ownerRule: null,
    parentStyleSheet: null,
  };
}

function createDocumentStyleSheetBackend(state: DocumentStyleSheetRuntime): CSSStyleSheetBackend {
  const remirror = () => remirrorStyleSheet(state);
  const backend: CSSStyleSheetBackend = {
    cssRules() {
      syncDocumentStyleSheet(state);
      return state.rules;
    },
    insertRule(text, index) {
      // Check bounds before parsing, then insert exactly one rule and refresh the DOM mirror.
      // Synchronizing first also preserves SecurityError for opaque linked sheets.
      // https://drafts.csswg.org/cssom/#insert-a-css-rule
      syncDocumentStyleSheet(state, true);
      const ruleIndex = index === undefined ? 0 : Number(index) >>> 0;
      if (ruleIndex > state.rules.length) {
        throw new DOMException("Index out of bounds", "IndexSizeError");
      }
      const parsed = parseSingleRuleOrThrow(text);
      const rule = constructRule(parsed, state.sheet, null, remirror);
      if (!rule) throw ruleSyntaxError(text);
      state.rules.splice(ruleIndex, 0, rule);
      remirror();
      return ruleIndex;
    },
    deleteRule(index) {
      syncDocumentStyleSheet(state, true);
      const ruleIndex = Number(index) >>> 0;
      if (ruleIndex >= state.rules.length) {
        throw new DOMException("Index out of bounds", "IndexSizeError");
      }
      state.rules.splice(ruleIndex, 1);
      remirror();
    },
    replaceSync(text) {
      syncDocumentStyleSheet(state, true);
      const replacement = String(text == null ? "" : text);
      reparseStyleSheetFromText(state, replacement);
      if (state.isStyleEl && state.id >= 0) {
        try {
          writeStyleSheetMirror(state, replacement);
          state.lastParsedText = replacement;
          bumpMutationSeq();
        } catch {}
      }
    },
    // A document sheet's replace() resolves even when the replacement fails.
    replace(text) {
      try {
        backend.replaceSync(text);
      } catch {}
      return Promise.resolve(state.sheet);
    },
  };
  return backend;
}

function makeStyleSheetStub(ownerNode: Element | ParsedElement | null): CSSStyleSheetCtor {
  const id = styleSheetNodeId(ownerNode);
  const cached = cachedStyleSheetForNode(ownerNode, id);
  if (cached) return cached;
  const isStyleEl = isStyleSheetElement(ownerNode);
  const isLinkEl = isLinkStyleSheetElement(ownerNode);
  const rules = makeStyleSheetRuleList();
  const href = styleSheetHref(ownerNode, isLinkEl);
  // The backing state is in sheetRecords; this stub uses the public prototype.
  const sheet = Object.create(CSSStyleSheetCtor.prototype) as CSSStyleSheetCtor;
  const runtime = createDocumentStyleSheetRuntime(
    ownerNode,
    id,
    isStyleEl,
    isLinkEl,
    rules,
    href,
    sheet,
  );
  // Mutators mirror all rules into `<style>` text; `<link>` remains network-backed.
  // Sync first to see direct style-text edits and preserve SecurityError for opaque linked sheets.
  const backend = createDocumentStyleSheetBackend(runtime);
  sheetRecords.set(sheet, { fields: documentStyleSheetFields(ownerNode, href), backend });
  rememberStyleSheetForNode(ownerNode, id, sheet);
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
        replaceConstructedRules(rules, this, rerender, text);
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

function replaceConstructedRules(
  rules: RuleList,
  sheet: CSSStyleSheetCtor,
  rerender: () => void,
  text: unknown,
): void {
  rules.length = 0;
  const parsedRules = splitStylesheetRules(String(text == null ? "" : text));
  for (const parsed of parsedRules) appendConstructibleRule(rules, sheet, rerender, parsed);
  rerender();
}

function appendConstructibleRule(
  rules: RuleList,
  sheet: CSSStyleSheetCtor,
  rerender: () => void,
  parsed: ParsedRuleChunk,
): void {
  const kind = classifyRuleKind(parsed);
  // @import and non-rules are dropped instead of throwing mid-replacement.
  if (kind === "import" || !isConstructibleRuleKind(kind)) return;
  const rule = constructRule(parsed, sheet, null, rerender);
  if (rule) rules.push(rule);
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
    if (!shouldCreateSheetMirror(sheet, mirrors)) return;
    try {
      const styleEl = createAdoptedSheetMirror();
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

function shouldCreateSheetMirror(
  sheet: Idl.CSSStyleSheet,
  mirrors: WeakMap<object, Element>,
): boolean {
  return !!sheet && typeof sheet === "object" && !mirrors.has(sheet);
}

function createAdoptedSheetMirror(): Element {
  const styleEl = createElementInternal("style");
  styleEl.setAttribute("data-ks-adopted", "");
  const doc = liveDocument();
  const head = doc.head || doc.documentElement;
  if (head) head.appendChild(styleEl);
  return styleEl;
}

export const adoptedStyleSheets = makeAdoptedStyleSheets();

function isStylesheetLink(node: Element): boolean {
  const rel = (node.getAttribute("rel") || "").toLowerCase();
  return rel.split(/\s+/).includes("stylesheet");
}

function appendStyleSheetNode(list: CSSStyleSheetCtor[], nodeId: number): void {
  const node = nodeFor(nodeId);
  if (!node) return;
  if (node.tagName === "LINK" && !isStylesheetLink(node)) return;
  list.push(makeStyleSheetStub(node));
}

function makeStyleSheetList(): ItemList<CSSStyleSheetCtor> {
  const list: CSSStyleSheetCtor[] = [];
  try {
    const ids = Array.from<number>(dom.querySelectorAll("style, link"));
    for (const nodeId of ids) appendStyleSheetNode(list, nodeId);
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
  for (const token of serialized.split(/[\u0009\u000a\u000c\u000d\u0020]+/)) {
    appendUniqueToken(token, out, seen);
  }
  return out;
}

function appendUniqueToken(token: string, out: string[], seen: Set<string>): void {
  if (token.length === 0 || seen.has(token)) return;
  seen.add(token);
  out.push(token);
}

function tokenListIndex(prop: PropertyKey): number | null {
  if (typeof prop !== "string" || !/^\d+$/.test(prop)) return null;
  return +prop;
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
      if (tokenListIndex(prop) !== null) return false;
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

function isHtmlElementNamespace(entry: { ns: string | null } | null | undefined): boolean {
  return !entry || entry.ns === HTML_NS;
}

function isHtmlDocumentOwner(owner: Element | null | undefined): boolean {
  return !owner || elementOwnerIsHtml.get(owner._id) !== false;
}

// The supported property names skip names with uppercase letters only
// for an HTML element in an HTML document.
// https://dom.spec.whatwg.org/#ref-for-dfn-supported-property-names
function hidesUppercaseNames(list: AttrCls[]): boolean {
  const owner = list[0]?._ownerElement;
  const ownerNsEntry = owner && elemNs.get(owner._id);
  return isHtmlElementNamespace(ownerNsEntry) && isHtmlDocumentOwner(owner);
}

function normalizedAttributeNamespace(ns: string | null): string | null {
  if (ns === null || ns === undefined || ns === "") return null;
  return String(ns);
}

function findNamedItemInNamespace(
  list: AttrCls[],
  targetNamespace: string | null,
  localName: string,
): AttrCls | null {
  for (const attr of list) {
    const namespace = attr.namespaceURI || null;
    if (namespace === targetNamespace && attr.localName === localName) return attr;
  }
  return null;
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
    return findNamedItemInNamespace(list, normalizedAttributeNamespace(ns), localName);
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
  owner = inferredNamedNodeMapOwner(owner, list);
  const state: NamedNodeMapState = { list, byName, owner, refresh };
  const sync = () => {
    refresh?.();
  };
  const proxy = new Proxy(target, {
    get(t, prop, receiver) {
      return getNamedNodeMapProperty(t, prop, receiver, list, byName, sync);
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

function inferredNamedNodeMapOwner(owner: Element | null, list: AttrCls[]): Element | null {
  if (owner || list.length === 0) return owner;
  return list[0]._ownerElement;
}

function hasNamedNodeMapName(prop: PropertyKey, byName: Record<string, AttrCls>): prop is string {
  return typeof prop === "string" && byName[prop] !== undefined;
}

function getNamedNodeMapProperty(
  target: NamedNodeMapCls,
  prop: PropertyKey,
  receiver: unknown,
  list: AttrCls[],
  byName: Record<string, AttrCls>,
  sync: () => void,
): unknown {
  sync();
  const index = tokenListIndex(prop);
  if (index !== null) return index < list.length ? list[index] : undefined;
  // Prototype-named attributes do not shadow methods on property reads.
  if (hasNamedNodeMapName(prop, byName) && !(prop in target)) return byName[prop];
  return Reflect.get(target, prop, receiver);
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

function scopedQuerySelector(rootId: number, selector: string): Idl.Element | null {
  const all = scopedQuerySelectorAll(rootId, selector);
  // SAFETY: the wasm selector returns only element IDs.
  return all.length > 0 ? (all[0] as Idl.Element) : null;
}

const pseudoElementRegex =
  /(?<!:)::(?:first-line|first-letter|before|after|placeholder|selection|backdrop|marker|file-selector-button|cue|cue-region|target-text|spelling-error|grammar-error|highlight|part|slotted|view-transition|view-transition-group|view-transition-image-pair|view-transition-old|view-transition-new)(?![a-zA-Z0-9_-])|(?<!:):(?:first-line|first-letter|before|after)(?![a-zA-Z0-9_-])(?!\s*\()/;
export function selectorHasPseudoElement(selector: string): boolean {
  return pseudoElementRegex.test(selector);
}

function normalizeSelector(selector: string): string {
  if (typeof selector !== "string") {
    try {
      return String(selector);
    } catch {
      throw new DOMException(
        "Failed to execute 'querySelectorAll': selector argument is not a valid string",
        "SyntaxError",
      );
    }
  }
  return selector;
}

function selectorFailureDetail(error: unknown): string {
  if (!error) return String(error);
  const firstMessage = Reflect.get(Object(error), "message", error);
  if (!firstMessage) return String(error);
  return "" + Reflect.get(Object(error), "message", error);
}

function invalidSelectorError(selector: string, error: unknown): DOMException {
  return new DOMException(
    "Failed to execute 'querySelectorAll': '" +
      selector +
      "' is not a valid selector. " +
      selectorFailureDetail(error),
    "SyntaxError",
  );
}

function validatePseudoElementSelector(selector: string): [] {
  try {
    dom.querySelectorAll(selector);
  } catch (error) {
    throw invalidSelectorError(selector, error);
  }
  return [];
}

function queryScopedSelectorIds(rootId: number, selector: string): number[] {
  try {
    return Array.from<number>(
      rootId === DOCUMENT_ID
        ? dom.querySelectorAll(selector)
        : dom.querySelectorAllInSubtree(rootId, selector),
    );
  } catch (error) {
    throw invalidSelectorError(selector, error);
  }
}

function scopedQuerySelectorAll(rootId: number, selector: string): NodeListCls | [] {
  const normalizedSelector = normalizeSelector(selector);
  if (selectorHasPseudoElement(normalizedSelector)) {
    return validatePseudoElementSelector(normalizedSelector);
  }
  const ids = queryScopedSelectorIds(rootId, normalizedSelector);
  return makeStaticNodeList(ids.map((id) => nodeFor(id)).filter(Boolean));
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
function makeStaticNodeList(items: Idl.Node[]): NodeListCls {
  // SAFETY: every numeric index and the length slot are installed before return.
  type WritableNodeList = {
    -readonly [K in keyof NodeListCls]: NodeListCls[K];
  } & { [nodeListLenSym]: number };
  const writable = Object.create(NodeListCls.prototype) as WritableNodeList;
  const n = items.length;
  for (let i = 0; i < n; i++) writable[i] = items[i];
  writable[nodeListLenSym] = n;
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
