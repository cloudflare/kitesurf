// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Records observed DOM mutations, validates observer options, and batches callback delivery.

import type * as Idl from "../idl/types.generated.js";
import { ksGlobal, dom, nodeFor } from "../state.js";
import { moPendingObservers, linkLoadFired } from "../registries.js";
import { getInternalState } from "../internal-state.js";
import { KsEvent } from "../events/event.js";
import { DOCUMENT_FRAGMENT_NODE } from "../constants.js";
import type { NodeBase } from "../node-base.js";

const REL_LOADABLE = /(?:^|\s)(?:stylesheet|preload|modulepreload)(?:\s|$)/i;
const OBSERVER_ANCESTOR_HOP_LIMIT = 4096;

type MutationKind = "attributes" | "characterData" | "childList";

interface MutationRecordExtras {
  addedNodes?: NodeBase[];
  removedNodes?: NodeBase[];
  previousSibling?: NodeBase | null;
  nextSibling?: NodeBase | null;
  attributeName?: string | null;
  attributeNamespace?: string | null;
  oldValue?: string | null;
}

interface NormalizedObserverOptions {
  attributes: boolean;
  childList: boolean;
  characterData: boolean;
  subtree: boolean;
  attributeOldValue: boolean;
  characterDataOldValue: boolean;
  attributeFilter?: unknown[];
}

interface ObserverRegistration {
  observer: MutationObserverImpl;
  targetId: number;
  options: NormalizedObserverOptions;
}

type LinkishNode = {
  _id?: unknown;
  tagName?: unknown;
  localName?: unknown;
  href?: unknown;
  nonce?: unknown;
  isConnected?: unknown;
  textContent?: unknown;
  getAttribute?: (name: string) => unknown;
  hasAttribute?: (name: string) => boolean;
  getRootNode?: (options?: { composed?: boolean }) => unknown;
  dispatchEvent?: Idl.EventTarget["dispatchEvent"];
  querySelectorAll?: (sel: string) => ArrayLike<LinkishNode>;
};

function notifyLinkInserts(insertedNode: LinkishNode, nested: LinkishNode[]): void {
  const fire = (el: LinkishNode): void => {
    try {
      const rel = (typeof el.getAttribute === "function" && el.getAttribute("rel")) || "";
      if (!REL_LOADABLE.test(String(rel))) return;
      let id = NaN;
      let href = "";
      try {
        id = Number(el._id);
        href = String(el.href ?? "");
      } catch {}
      if (
        String(rel).toLowerCase().split(/\s+/).includes("stylesheet") &&
        !(typeof el.getAttribute === "function" && el.getAttribute("media")) &&
        /^https?:/i.test(href)
      )
        return;
      if (Number.isFinite(id)) linkLoadFired.set(id, href);
      queueMicrotask(() => {
        let live = false;
        let nowHref = "";
        try {
          live = el.isConnected === true;
          nowHref = String(el.href ?? "");
        } catch {}
        if (!live || nowHref !== href) {
          if (Number.isFinite(id) && linkLoadFired.get(id) === href) {
            linkLoadFired.delete(id);
          }
          return;
        }
        try {
          if (typeof el.dispatchEvent === "function") {
            el.dispatchEvent(new KsEvent("load"));
          }
        } catch {}
      });
    } catch {}
  };
  try {
    if (String(insertedNode.tagName ?? "").toUpperCase() === "LINK") fire(insertedNode);
    for (const el of nested) fire(el);
  } catch {}
}

// Lets makeRecord construct records; pages can't.
const RECORD_TOKEN = Symbol("kitesurfMutationRecord");

// addedNodes and removedNodes are arrays (idl/type-gaps.json).
export class MutationRecord implements Idl.MutationRecord {
  readonly #type: MutationKind;
  readonly #target: NodeBase;
  readonly #addedNodes: NodeBase[];
  readonly #removedNodes: NodeBase[];
  readonly #previousSibling: NodeBase | null;
  readonly #nextSibling: NodeBase | null;
  readonly #attributeName: string | null;
  readonly #attributeNamespace: string | null;
  readonly #oldValue: string | null;
  constructor(token: symbol, type: MutationKind, target: NodeBase, extras: MutationRecordExtras) {
    if (token !== RECORD_TOKEN) throw new TypeError("Illegal constructor");
    this.#type = type;
    this.#target = target;
    this.#addedNodes = extras.addedNodes || [];
    this.#removedNodes = extras.removedNodes || [];
    this.#previousSibling = extras.previousSibling || null;
    this.#nextSibling = extras.nextSibling || null;
    this.#attributeName = extras.attributeName ?? null;
    this.#attributeNamespace = extras.attributeNamespace ?? null;
    this.#oldValue = extras.oldValue ?? null;
  }
  get type() {
    return this.#type;
  }
  get target() {
    return this.#target;
  }
  get addedNodes(): NodeBase[] {
    return this.#addedNodes;
  }
  get removedNodes(): NodeBase[] {
    return this.#removedNodes;
  }
  get previousSibling() {
    return this.#previousSibling;
  }
  get nextSibling() {
    return this.#nextSibling;
  }
  get attributeName() {
    return this.#attributeName;
  }
  get attributeNamespace() {
    return this.#attributeNamespace;
  }
  get oldValue() {
    return this.#oldValue;
  }
}

function makeRecord(
  type: MutationKind,
  target: NodeBase,
  extras: MutationRecordExtras,
): MutationRecord {
  return new MutationRecord(RECORD_TOKEN, type, target, extras);
}

let moDeliveryScheduled = false;

function scheduleMoDelivery() {
  if (moDeliveryScheduled) return;
  moDeliveryScheduled = true;
  const fire = () => {
    moDeliveryScheduled = false;
    // Clear before callbacks so callback mutations schedule a later delivery.
    const observers = Array.from(moPendingObservers);
    moPendingObservers.clear();
    for (const obs of observers) {
      // Transient registrations survive until this batch's removal records are collected.
      const records = takeQueuedRecords(obs);
      clearTransientObservers(obs);
      if (records.length === 0) continue;
      try {
        invokeObserverCallback(obs, records);
      } catch (e) {
        try {
          (ksGlobal.console || console).error("MO callback threw:", e);
        } catch {}
      }
    }
  };
  if (typeof queueMicrotask === "function") {
    queueMicrotask(fire);
  } else {
    setTimeout(fire, 0);
  }
}

const mutationObservers: ObserverRegistration[] = [];
const transientSourcesByTarget = new Map<number, Set<ObserverRegistration>>();
const transientTargetsBySource = new Map<ObserverRegistration, Set<number>>();

function forEachMatchingTransientSource(
  targetId: number,
  visit: (source: ObserverRegistration) => void,
): void {
  let cur = targetId;
  let safety = 0;
  while (safety <= OBSERVER_ANCESTOR_HOP_LIMIT) {
    const sources = transientSourcesByTarget.get(cur);
    if (sources) for (const source of sources) visit(source);
    let parent;
    try {
      parent = dom.parentId(cur);
    } catch {
      return;
    }
    if (parent < 0 || parent === cur) return;
    cur = parent;
    safety++;
  }
}

function clearTransientSource(source: ObserverRegistration): void {
  const targetIds = transientTargetsBySource.get(source);
  if (!targetIds) return;
  for (const targetId of targetIds) {
    const sources = transientSourcesByTarget.get(targetId);
    sources?.delete(source);
    if (sources?.size === 0) transientSourcesByTarget.delete(targetId);
  }
  transientTargetsBySource.delete(source);
}

function clearTransientObservers(observer: MutationObserverImpl): void {
  for (const entry of mutationObservers) {
    if (entry.observer === observer) clearTransientSource(entry);
  }
}

export function mutationObserverCount(): number {
  return mutationObservers.length;
}

function observerMatchesTarget(entry: ObserverRegistration, targetId: number): boolean {
  return targetMatchesRegistration(targetId, entry.targetId, entry.options.subtree);
}

function targetMatchesRegistration(
  targetId: number,
  registeredTargetId: number,
  subtree: boolean,
): boolean {
  if (registeredTargetId === targetId) return true;
  if (!subtree) return false;
  let cur = targetId;
  let safety = 0;
  while (safety < OBSERVER_ANCESTOR_HOP_LIMIT) {
    let parent;
    try {
      parent = dom.parentId(cur);
    } catch {
      return false;
    }
    if (parent < 0 || parent === cur) return false;
    if (parent === registeredTargetId) return true;
    cur = parent;
    safety++;
  }
  return false;
}

export function hasChildListObserver(targetId: number): boolean {
  if (
    mutationObservers.some(
      (entry) => entry.options.childList && observerMatchesTarget(entry, targetId),
    )
  )
    return true;
  let matched = false;
  forEachMatchingTransientSource(targetId, (source) => {
    if (source.options.childList) matched = true;
  });
  return matched;
}

export function hasSubtreeObserver(targetId: number): boolean {
  if (
    mutationObservers.some(
      (entry) => entry.options.subtree && observerMatchesTarget(entry, targetId),
    )
  )
    return true;
  let matched = false;
  forEachMatchingTransientSource(targetId, () => {
    matched = true;
  });
  return matched;
}

export function registerTransientObservers(rootId: number): void {
  const sources = new Set<ObserverRegistration>();
  for (const entry of mutationObservers) {
    if (
      entry.options.subtree &&
      entry.targetId !== rootId &&
      observerMatchesTarget(entry, rootId)
    ) {
      sources.add(entry);
    }
  }
  forEachMatchingTransientSource(rootId, (source) => sources.add(source));
  for (const source of sources) {
    let targetSources = transientSourcesByTarget.get(rootId);
    if (!targetSources) {
      targetSources = new Set();
      transientSourcesByTarget.set(rootId, targetSources);
    }
    if (targetSources.has(source)) continue;
    targetSources.add(source);
    moPendingObservers.add(source.observer);
    let sourceTargets = transientTargetsBySource.get(source);
    if (!sourceTargets) {
      sourceTargets = new Set();
      transientTargetsBySource.set(source, sourceTargets);
    }
    sourceTargets.add(rootId);
  }
  if (moPendingObservers.size > 0) scheduleMoDelivery();
}

// An observer can match several ancestor registrations; queue one record, keeping the old
// value if any matching registration requests it, including a removed subtree's transient ones.
// https://dom.spec.whatwg.org/#queue-a-mutation-record
function queueMutationRecord(
  kind: MutationKind,
  target: NodeBase,
  extras: MutationRecordExtras,
): void {
  if (mutationObservers.length === 0) return;
  if (!target || typeof target._id !== "number") return;
  const targetId = target._id;
  const interested = new Map<MutationObserverImpl, boolean>();
  const consider = (entry: ObserverRegistration, matches: boolean): void => {
    if (!matches) return;
    const opts = entry.options;
    if (kind === "attributes") {
      if (!opts.attributes) return;
      if (
        Array.isArray(opts.attributeFilter) &&
        !opts.attributeFilter.includes(extras.attributeName)
      )
        return;
    } else if (kind === "characterData") {
      if (!opts.characterData) return;
    } else if (kind === "childList") {
      if (!opts.childList) return;
    } else {
      return;
    }
    const wantsOldValue =
      (kind === "attributes" && opts.attributeOldValue) ||
      (kind === "characterData" && opts.characterDataOldValue);
    interested.set(entry.observer, interested.get(entry.observer) === true || wantsOldValue);
  };
  for (const entry of mutationObservers) {
    consider(entry, observerMatchesTarget(entry, targetId));
  }
  forEachMatchingTransientSource(targetId, (source) => consider(source, true));
  for (const [observer, wantsOldValue] of interested) {
    const recExtras = { ...extras };
    if ((kind === "attributes" || kind === "characterData") && !wantsOldValue) {
      recExtras.oldValue = null;
    }
    const rec = makeRecord(kind, target, recExtras);
    queueObserverRecord(observer, rec);
    moPendingObservers.add(observer);
  }
  if (moPendingObservers.size > 0) scheduleMoDelivery();
}

export function recordAttributeMutation(
  elementId: number,
  attributeName: string,
  attributeNamespace: string | null,
  oldValue: string | null,
): void {
  if (mutationObservers.length === 0) return;
  const target = nodeFor ? nodeFor(elementId) : null;
  if (!target) return;
  queueMutationRecord("attributes", target, {
    attributeName,
    attributeNamespace,
    oldValue,
  });
}

const suppressedChildListTargets = new WeakMap<object, number>();

export function suppressChildListMutations<T>(parent: object, fn: () => T): T {
  suppressedChildListTargets.set(parent, (suppressedChildListTargets.get(parent) ?? 0) + 1);
  try {
    return fn();
  } finally {
    const remaining = (suppressedChildListTargets.get(parent) ?? 1) - 1;
    if (remaining === 0) suppressedChildListTargets.delete(parent);
    else suppressedChildListTargets.set(parent, remaining);
  }
}

export function recordChildListMutation(
  parent: NodeBase,
  addedNodes: NodeBase[],
  removedNodes: NodeBase[],
  previousSibling: NodeBase | null,
  nextSibling: NodeBase | null,
): void {
  if (mutationObservers.length === 0) return;
  if (!parent) return;
  if (suppressedChildListTargets.has(parent)) return;
  queueMutationRecord("childList", parent, {
    addedNodes,
    removedNodes,
    previousSibling: previousSibling || null,
    nextSibling: nextSibling || null,
  });
}

function notifyIframeInserts(insertedNode: LinkishNode, nested: LinkishNode[]): void {
  const hook = getInternalState().afterIframeInsert;
  if (typeof hook !== "function") return;
  try {
    const tag = String(insertedNode.tagName ?? "").toUpperCase();
    if (tag === "IFRAME") {
      try {
        hook(insertedNode);
      } catch {}
    }
    for (const el of nested) {
      try {
        hook(el);
      } catch {}
    }
  } catch {}
}

interface RemovedNode {
  readonly nodeType?: number;
  readonly tagName?: string;
  readonly querySelectorAll?: (
    selectors: string,
  ) => Iterable<unknown> & { readonly length: number };
}

function notifyIframeRemove(hook: (element: unknown) => void, element: unknown) {
  try {
    hook(element);
  } catch {}
}

export function notifyIframeRemoves(removedNode: RemovedNode | null | undefined): void {
  if (!removedNode) return;
  const hook = getInternalState().afterIframeRemove;
  if (typeof hook !== "function") return;
  try {
    const tag = (removedNode.tagName || "").toUpperCase();
    if (tag === "IFRAME") {
      notifyIframeRemove(hook, removedNode);
    }
    if (typeof removedNode.querySelectorAll === "function") {
      let nested;
      try {
        nested = removedNode.querySelectorAll("iframe");
      } catch {
        nested = null;
      }
      if (nested && nested.length) {
        for (const el of nested) notifyIframeRemove(hook, el);
      }
    }
  } catch {}
}

const runtimeCreatedScriptIds = new Set<number>();
const executedScriptIds = new Set<number>();

export function markRuntimeCreatedScript(id: number): void {
  if (typeof id === "number" && id >= 0) runtimeCreatedScriptIds.add(id);
}

// A script from createElement starts with force async set, so its async IDL reads true until
// the page sets async. Parser-created scripts never have it.
// https://html.spec.whatwg.org/#script-force-async
const forceAsyncScriptIds = new Set<number>();

export function markForceAsyncScript(id: number): void {
  if (typeof id === "number" && id >= 0) forceAsyncScriptIds.add(id);
}

export function scriptForceAsync(id: number): boolean {
  return forceAsyncScriptIds.has(id);
}

export function clearScriptForceAsync(id: number): void {
  forceAsyncScriptIds.delete(id);
}

// A document.write'd script is parser-inserted: it must run in write order
// and before DOMContentLoaded. An appended script has no such ordering, so
// written scripts carry their own mark.
const writtenScriptIds = new Set<number>();

export function markWrittenScript(id: number): void {
  if (id < 0) return;
  runtimeCreatedScriptIds.add(id);
  writtenScriptIds.add(id);
}

export function copyScriptStartedFlag(src: LinkishNode, clone: LinkishNode): void {
  let srcId: unknown, cloneId: unknown;
  try {
    srcId = src._id;
    cloneId = clone._id;
  } catch {
    return;
  }
  if (typeof srcId !== "number" || typeof cloneId !== "number" || cloneId < 0) return;
  let started = executedScriptIds.has(srcId);
  if (!started && !runtimeCreatedScriptIds.has(srcId)) {
    let inFragment = false;
    try {
      const root = src.getRootNode?.() as { nodeType?: unknown } | null | undefined;
      inFragment = root?.nodeType === DOCUMENT_FRAGMENT_NODE;
    } catch {}
    let type = "";
    try {
      type = String(src.getAttribute?.("type") || "")
        .trim()
        .toLowerCase();
    } catch {}
    started =
      !inFragment &&
      (type === "" ||
        type === "text/javascript" ||
        type === "application/javascript" ||
        type === "module" ||
        type === "importmap");
  }
  if (started) executedScriptIds.add(cloneId);
}

function notifyScriptInserts(insertedNode: LinkishNode, nested: LinkishNode[]): void {
  const hook = getInternalState().afterScriptInsert;
  if (typeof hook !== "function") return;
  const consider = (el: LinkishNode) => {
    let id;
    try {
      id = el._id;
    } catch {
      return;
    }
    if (typeof id !== "number" || id < 0) return;
    if (!runtimeCreatedScriptIds.has(id)) return;
    if (executedScriptIds.has(id)) return;
    let rooted = false;
    try {
      rooted =
        typeof el.getRootNode === "function" &&
        el.getRootNode({ composed: true }) === ksGlobal.document;
    } catch {}
    if (!rooted) return;
    let connected = false;
    try {
      connected = el.isConnected === true;
    } catch {}
    if (!connected) return;
    let type = "";
    try {
      type = String(el.getAttribute?.("type") || "")
        .trim()
        .toLowerCase();
    } catch {}
    const isJs =
      type === "" ||
      type === "text/javascript" ||
      type === "application/javascript" ||
      type === "module";
    if (!isJs) return;
    let src = "";
    try {
      src = String(el.getAttribute?.("src") || "");
    } catch {}
    let source = "";
    try {
      source = String(el.textContent || "");
    } catch {}
    if (!src && source === "") return;
    // A browser that runs modules skips a classic script marked nomodule: no fetch, no events.
    // It counts as started, so dropping the attribute later does not run it. An empty script
    // has not started, so it is checked first.
    try {
      if (type !== "module" && el.hasAttribute?.("nomodule")) {
        executedScriptIds.add(id);
        return;
      }
    } catch {}
    let integrity = "";
    try {
      integrity = String(el.getAttribute?.("integrity") || "").trim();
    } catch {}
    let nonce = "";
    try {
      const idl = el.nonce;
      nonce = String(typeof idl === "string" ? idl : el.getAttribute?.("nonce") || "");
    } catch {}
    let crossOrigin: string | null = null;
    try {
      crossOrigin = el.hasAttribute?.("crossorigin")
        ? String(el.getAttribute?.("crossorigin") || "")
        : null;
    } catch {}
    executedScriptIds.add(id);
    const written = writtenScriptIds.has(id);
    try {
      hook({ id, src, type, source, integrity, nonce, crossOrigin, written });
    } catch {}
  };
  try {
    const tag = String(insertedNode.tagName ?? "").toUpperCase();
    if (tag === "SCRIPT") consider(insertedNode);
    for (const el of nested) consider(el);
  } catch {}
}

export function notifySubtreeInserts(insertedNode: LinkishNode): void {
  // Snapshot resource descendants before insertion hooks can mutate the subtree.
  const iframes: LinkishNode[] = [];
  const scripts: LinkishNode[] = [];
  const links: LinkishNode[] = [];
  try {
    if (typeof insertedNode.querySelectorAll === "function") {
      for (const el of Array.from(insertedNode.querySelectorAll("iframe,script,link"))) {
        const tag = String(el.localName ?? "").toLowerCase();
        if (tag === "iframe") iframes.push(el);
        else if (tag === "script") scripts.push(el);
        else if (tag === "link") links.push(el);
      }
    }
  } catch {}
  notifyIframeInserts(insertedNode, iframes);
  notifyScriptInserts(insertedNode, scripts);
  notifyLinkInserts(insertedNode, links);
}

export function recordCharacterDataMutation(node: NodeBase, oldValue: string): void {
  if (mutationObservers.length === 0) return;
  if (!node) return;
  queueMutationRecord("characterData", node, { oldValue });
}

function isObservable(value: unknown): value is { readonly _id: number } {
  return (
    typeof value === "object" && value !== null && "_id" in value && typeof value._id === "number"
  );
}

type ObservableTarget = { readonly _id: number };

// A created or imported document has no node id; its host element owns the tree.
function observableTarget(target: Idl.Node): ObservableTarget | null {
  if (isObservable(target)) return target;
  const host: unknown = Reflect.get(target, "_host");
  return isObservable(host) ? host : null;
}

type MutationCallback = (records: MutationRecord[], observer: MutationObserverImpl) => void;

let queueObserverRecord!: (observer: MutationObserverImpl, record: MutationRecord) => void;
let takeQueuedRecords!: (observer: MutationObserverImpl) => MutationRecord[];
let invokeObserverCallback!: (observer: MutationObserverImpl, records: MutationRecord[]) => void;

export class MutationObserverImpl implements Idl.MutationObserver {
  readonly #callback: MutationCallback;
  #records: MutationRecord[] = [];
  static {
    queueObserverRecord = (observer, record) => {
      observer.#records.push(record);
    };
    takeQueuedRecords = (observer) => {
      const records = observer.#records;
      observer.#records = [];
      return records;
    };
    invokeObserverCallback = (observer, records) => {
      observer.#callback.call(observer, records, observer);
    };
  }
  constructor(callback: MutationCallback) {
    if (typeof callback !== "function") {
      throw new TypeError("MutationObserver: callback is not a function");
    }
    this.#callback = callback;
  }
  /**
   * Empty or contradictory options throw `TypeError`.
   * Old-value and filter options infer the matching observation flag.
   */
  observe(target: Idl.Node, options?: Idl.MutationObserverInit) {
    const observed = observableTarget(target);
    if (!observed) {
      throw new TypeError("MutationObserver.observe: invalid target");
    }
    const opts = options || {};
    // Option defaults and checks: https://dom.spec.whatwg.org/#dom-mutationobserver-observe
    const attributesExplicit = "attributes" in opts;
    const characterDataExplicit = "characterData" in opts;
    const hasAttrOldValue = "attributeOldValue" in opts;
    const hasAttrFilter = "attributeFilter" in opts;
    const hasCharOldValue = "characterDataOldValue" in opts;

    let attributes = !!opts.attributes;
    if (!attributesExplicit && (hasAttrOldValue || hasAttrFilter)) {
      attributes = true;
    }
    let characterData = !!opts.characterData;
    if (!characterDataExplicit && hasCharOldValue) {
      characterData = true;
    }
    const childList = !!opts.childList;
    const subtree = !!opts.subtree;

    if (attributesExplicit && opts.attributes === false) {
      if (hasAttrOldValue && opts.attributeOldValue === true) {
        throw new TypeError("MutationObserver.observe: attributeOldValue requires attributes:true");
      }
      if (hasAttrFilter) {
        throw new TypeError("MutationObserver.observe: attributeFilter requires attributes:true");
      }
    }
    if (
      characterDataExplicit &&
      opts.characterData === false &&
      hasCharOldValue &&
      opts.characterDataOldValue === true
    ) {
      throw new TypeError(
        "MutationObserver.observe: characterDataOldValue requires characterData:true",
      );
    }
    if (!attributes && !childList && !characterData) {
      throw new TypeError(
        "MutationObserver.observe: at least one of attributes/childList/characterData must be true",
      );
    }

    const normalized: NormalizedObserverOptions = {
      attributes,
      childList,
      characterData,
      subtree,
      attributeOldValue: !!opts.attributeOldValue,
      characterDataOldValue: !!opts.characterDataOldValue,
      attributeFilter: Array.isArray(opts.attributeFilter)
        ? opts.attributeFilter.slice()
        : undefined,
    };
    // An existing registration for this target only gets new options.
    for (let i = 0; i < mutationObservers.length; i++) {
      const e = mutationObservers[i];
      if (e.observer === this && e.targetId === observed._id) {
        clearTransientSource(e);
        e.options = normalized;
        return;
      }
    }
    mutationObservers.push({
      observer: this,
      targetId: observed._id,
      options: normalized,
    });
  }
  disconnect() {
    clearTransientObservers(this);
    for (let i = mutationObservers.length - 1; i >= 0; i--) {
      if (mutationObservers[i].observer === this) {
        mutationObservers.splice(i, 1);
      }
    }
    this.#records = [];
    moPendingObservers.delete(this);
  }
  takeRecords() {
    return takeQueuedRecords(this);
  }
}
