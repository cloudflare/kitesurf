// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Holds the shared node, form, collection, and mutation registries used by the shim.

import type { DomHandle } from "../../core/pkg/kitesurf_core";
import type { MutationHint } from "./mutations/seq.js";
import type { MutationObserverImpl } from "./mutations/observer.js";
import type { NodeBase } from "./node-base.js";
import type { Element } from "./element/element.js";
import type {
  AttrCls,
  CSSStyleSheetCtor,
  DOMTokenListCls,
  DocumentFragmentImpl,
  HtmlCollectionCls,
  HTMLOptionsCollectionCls,
  NodeListCls,
} from "./collections.js";
import type { DetachedDocument, DocumentImpl } from "./document.js";
import type { ParsedDocument } from "./parser.js";

export interface InputControlState {
  valueDirty: boolean;
  value: string;
  userEdited: boolean;
  checkedDirty: boolean;
  checked: boolean;
  indeterminate?: boolean;
  defaultValueAttr?: string;
}

export const cache = new Map<number, NodeBase>();

export const weakWrappers = new Map<number, WeakRef<NodeBase>>();

export function liveWrapper(nodeId: number): NodeBase | undefined {
  const strong = cache.get(nodeId);
  if (strong) return strong;
  const ref = weakWrappers.get(nodeId);
  if (!ref) return undefined;
  const w = ref.deref();
  if (w === undefined) weakWrappers.delete(nodeId);
  return w;
}

export function hasLiveWrapper(nodeId: number): boolean {
  return liveWrapper(nodeId) !== undefined;
}

export function forgetNodeIds(ids: Iterable<number>): void {
  for (const id of ids) {
    weakWrappers.delete(id);
    formState.delete(id);
    inputState.delete(id);
    optionSelected.delete(id);
    selectionState.delete(id);
    customValidity.delete(id);
    elemNs.delete(id);
    xmlOwned.delete(id);
    elementOwnerIsHtml.delete(id);
    attrNs.delete(id);
    fragmentIds.delete(id);
    templateContentFragment.delete(id);
    stampedPiIds.delete(id);
    commentData.delete(id);
    linkLoadFired.delete(id);
    forgetIdGlobal(id);
    elementScrollendSeq.delete(id);
  }
}

export const adoptedWrapperIds = new Set<number>();

export const linkLoadFired = new Map<number, string>();

export const formState = new Map<number, { value?: string; checked?: boolean }>();

// A form's page-facing proxy lets named controls override its members. The engine's form
// algorithms read members off the form behind it, as a browser's own steps never see named
// properties, and keep the proxy as `this` and event target so listeners see the page's form.
const formProxyTargets = new WeakMap<object, object>();
const formPageProxies = new WeakMap<object, object>();

export function registerFormProxy(proxy: object, form: object): void {
  formProxyTargets.set(proxy, form);
  formPageProxies.set(form, proxy);
}

// The page-facing proxy for a form, for registries keyed by the wrapper the page sees.
export function formPageProxy<T extends object>(form: T): T {
  const proxy = formPageProxies.get(form);
  return proxy === undefined ? form : (proxy as T);
}

export function formBehindProxy<T extends object>(form: T): T {
  const behind = formProxyTargets.get(form);
  return behind === undefined ? form : (behind as T);
}

export const inputState = new Map<number, InputControlState>();

export let selectednessWrites = 0;
export class SelectednessMap<K, V> extends Map<K, V> {
  override set(key: K, value: V): this {
    selectednessWrites++;
    return super.set(key, value);
  }
  override delete(key: K): boolean {
    selectednessWrites++;
    return super.delete(key);
  }
  override clear(): void {
    selectednessWrites++;
    super.clear();
  }
}
export class SelectednessWeakMap<K extends object, V> extends WeakMap<K, V> {
  override set(key: K, value: V): this {
    selectednessWrites++;
    return super.set(key, value);
  }
  override delete(key: K): boolean {
    selectednessWrites++;
    return super.delete(key);
  }
}

export const optionSelected = new SelectednessMap<number, { selected: boolean; dirty: boolean }>();

export const selectionState = new Map<number, { start: number; end: number; direction: string }>();

export const customValidity = new Map<number, string>();

export const elemNs = new Map<number, { qname: string; ns: string | null; viaNS?: boolean }>();

export const xmlOwned = new Set<number>();

export const hostIdToDoc = new Map<number, DetachedDocument>();

// Attrs hold their owner; wrapper keys preserve identity without rooting removed trees.
export const attrInstances = new WeakMap<Element, Map<string, AttrCls>>();

export const elementOwnerIsHtml = new Map<number, boolean>();

// A node's document, when it isn't the live page document. DOMParser
// documents count: a node can be adopted into one.
export type NodeOwnerDocument = DocumentImpl | DetachedDocument | ParsedDocument;
export const nodeOwnerDoc = new WeakMap<object, NodeOwnerDocument>();

export const syntheticParent = new WeakMap<object, DocumentImpl | DetachedDocument>();

export const attrNs = new Map<
  number,
  Map<
    string,
    { ns: string | null; prefix: string | null; localName: string; qname: string; parsed?: boolean }
  >
>();

export const fragmentIds = new Set<number>();

export const templateContentFragment = new Map<number, DocumentFragmentImpl>();

export const stampedPiIds = new Set<number>();

export const commentData = new Map<number, string>();

export const nodeListCache = new WeakMap<object, NodeListCls<NodeBase>>();

export const childrenCache = new WeakMap<object, HtmlCollectionCls>();
export const optionsCache = new WeakMap<object, HTMLOptionsCollectionCls>();

export const classListCache = new WeakMap<object, DOMTokenListCls>();

export const relListCache = new WeakMap<object, DOMTokenListCls>();
export const htmlForCache = new WeakMap<object, DOMTokenListCls>();
export const sandboxCache = new WeakMap<object, DOMTokenListCls>();
export const sizesCache = new WeakMap<object, DOMTokenListCls>();

// Per-instance getter / setter functions for the various
// collection / proxy types. WeakMap-keyed by the proxy itself.
export const nodeListGetters = new WeakMap<object, () => NodeBase[]>();
export const htmlCollectionGetters = new WeakMap<object, () => Element[]>();

// A sheet holds its owner, so its cache must not outlive the owner's wrapper.
export const sheetCache = new WeakMap<object, CSSStyleSheetCtor>();

// Canvas node ID to weak wrapper reference. The wrapper holds its
// context identity; finalization releases the wasm surface without
// pinning the wrapper. Keep this cache through unrelated DOM resets.
export const canvas2dCache = new Map<number, { deref(): object | undefined }>();

export const postMutationHooks: Array<(hint?: MutationHint) => void> = [];

interface NamedGlobalEntry {
  getter: () => unknown;
  // A bare owner ID until a second node introduces the same name.
  nodeIds: number | Set<number>;
}

// Owners are IDs, not wrappers, so an entry never keeps a wrapper alive.
export const stampedNames = new Map<string, NamedGlobalEntry>();

export const nodeIdName = new Map<number, string>();
const namedGlobalObject = globalThis;

export function forgetIdGlobal(nodeId: number): void {
  const name = nodeIdName.get(nodeId);
  if (name === undefined) return;
  nodeIdName.delete(nodeId);
  const entry = stampedNames.get(name);
  if (!entry) return;
  if (typeof entry.nodeIds === "number") {
    if (entry.nodeIds !== nodeId) return;
  } else {
    entry.nodeIds.delete(nodeId);
    if (entry.nodeIds.size > 0) return;
  }
  stampedNames.delete(name);
  // Do not delete a page-defined replacement or execute its getter during GC cleanup.
  if (Object.getOwnPropertyDescriptor(namedGlobalObject, name)?.get === entry.getter) {
    Reflect.deleteProperty(namedGlobalObject, name);
  }
}

export const moPendingObservers = new Set<MutationObserverImpl>();

export const parsedHandleXml = new WeakSet<object>();

// Registries keyed by a DomHandle keep the handle off the page-visible object, but
// the collection prototypes are shared with the page: a replaced method must never
// receive the handle. Every such call goes through a method bound here at module
// load, so it allocates no argument list and ignores later page replacements.
const nativeCall = Function.prototype.call;
const nativeBind = Function.prototype.bind;

// `bind.call(bind, call)` with all three intrinsics captured at module load: the
// result invokes a method with its first argument as `this`, so later page
// replacements of `call`, `bind` or a prototype method cannot intercept the call.
const uncurriedBinder = Reflect.apply(nativeBind, nativeBind, [nativeCall]) as (
  fn: unknown,
) => unknown;
function bindCall<T>(fn: unknown): T {
  return uncurriedBinder(fn) as T;
}

const weakMapGet = bindCall<<K extends object, V>(map: WeakMap<K, V>, key: K) => V | undefined>(
  WeakMap.prototype.get,
);
const weakMapSet = bindCall<<K extends object, V>(map: WeakMap<K, V>, key: K, value: V) => void>(
  WeakMap.prototype.set,
);
const weakSetHas = bindCall<(set: WeakSet<object>, key: object) => boolean>(WeakSet.prototype.has);
const weakSetAdd = bindCall<(set: WeakSet<object>, key: object) => void>(WeakSet.prototype.add);

export function weakMapLookup<K extends object, V>(map: WeakMap<K, V>, key: K): V | undefined {
  return weakMapGet(map, key);
}

export function weakMapStore<K extends object, V>(map: WeakMap<K, V>, key: K, value: V): void {
  weakMapSet(map, key, value);
}

export function weakSetContains(set: WeakSet<object>, key: object): boolean {
  return weakSetHas(set, key);
}

export function weakSetInsert(set: WeakSet<object>, key: object): void {
  weakSetAdd(set, key);
}

const finalizationRegister =
  typeof FinalizationRegistry !== "undefined"
    ? bindCall<(registry: FinalizationRegistry<unknown>, target: object, held: unknown) => void>(
        FinalizationRegistry.prototype.register,
      )
    : null;

// Register a held value without resolving `register` off the prototype again.
export function registerFinalizationHeld(
  registry: FinalizationRegistry<unknown>,
  target: object,
  held: unknown,
): void {
  if (finalizationRegister) finalizationRegister(registry, target, held);
}

// A parser wrapper's wasm handle, kept off the page-visible object: page code can
// read and replace any property it can see.
const parsedHandles = new WeakMap<object, DomHandle>();

export function parsedHandle(node: object): DomHandle | undefined {
  return weakMapLookup(parsedHandles, node);
}

export function hasParsedHandle(node: object): boolean {
  return parsedHandle(node) !== undefined;
}

export function registerParsedHandle(node: object, handle: DomHandle): void {
  weakMapStore(parsedHandles, node, handle);
}

export const boundFromGlobal = new WeakMap<object, Function>();

export const elementScrollendSeq = new Map<number, number>();

export let scrollendSeq = 0;
export let localScrollX = 0;
export let localScrollY = 0;

export function bumpScrollendSeq(): number {
  scrollendSeq++;
  return scrollendSeq;
}

export function setLocalScroll(x: number, y: number): void {
  localScrollX = x;
  localScrollY = y;
}

export function resetRegistries(): void {
  cache.clear();
  weakWrappers.clear();
  adoptedWrapperIds.clear();
  formState.clear();
  inputState.clear();
  optionSelected.clear();
  selectionState.clear();
  customValidity.clear();
  elemNs.clear();
  xmlOwned.clear();
  hostIdToDoc.clear();
  elementOwnerIsHtml.clear();
  attrNs.clear();
  fragmentIds.clear();
  templateContentFragment.clear();
  stampedPiIds.clear();
  commentData.clear();
  stampedNames.clear();
  nodeIdName.clear();
  moPendingObservers.clear();
  elementScrollendSeq.clear();
  scrollendSeq = 0;
  localScrollX = 0;
  localScrollY = 0;
}
