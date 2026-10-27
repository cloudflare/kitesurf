// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Holds the PageScript generation's shared DOM, globals, and lifecycle state.

import type { RawCdpMutation } from "@kitesurf/jsrpc-types/shared";
import type { LoadCompletion } from "@kitesurf/jsrpc-types/page-script";
import type {
  BuildDocumentResult,
  DomHandle,
  ShimDocument,
  ShimElement,
  ShimGlobal,
  ShimNode,
  ShimWindow,
} from "./types.ts";

import { DEFAULT_VIEWPORT_HEIGHT_PX, DEFAULT_VIEWPORT_WIDTH_PX } from "./internal-state.js";
export { DEFAULT_VIEWPORT_HEIGHT_PX, DEFAULT_VIEWPORT_WIDTH_PX };

export interface PageScriptState {
  dom: DomHandle | null;

  blobUrls: Map<string, Blob>;

  pageUrl: string;

  sourceDoctype: { markup: string; marker: string } | null;

  connectionId: string;

  mainFrameId: string;

  cookieKey: string;

  document: ShimDocument | null;
  window: ShimWindow | null;

  lastForceRestyleSeq: number;

  lastRecordScrollX: number;
  lastRecordScrollY: number;
  lastRecordViewportW: number;
  lastRecordViewportH: number;

  currentMediaType: "screen" | "print";

  paintCacheHandle: DomHandle | null;
  paintCacheSeq: number;
  paintCacheFresh: boolean;
  paintCacheViewportW: number;
  paintCacheViewportH: number;
  paintViewportW: number;
  paintViewportH: number;
  scrollX: number;
  scrollY: number;

  getOpLog: () => unknown[];
  setReadyState: (s: string) => void;
  drainCookieWrites: () => string[];
  setCookieString: (s: string) => void;
  resolveNodeId: (id: number) => ShimElement | null;
  getActiveElement: () => ShimElement | null;
  drainCdpMutationsRaw: () => RawCdpMutation[];
  dispatchTrustedEvent: (target: ShimNode, event: unknown) => boolean;
  notifyImageResults: (nodeIds: Iterable<number>, ok: boolean) => void;

  notifyStylesheetResults: (url: string, ok: boolean) => void;

  loadCompletion: Promise<LoadCompletion> | null;

  navigateStarted: boolean;

  loadCompletionArmed: Promise<void>;
  settleLoadCompletionArmed: () => void;

  // The navigate's emulated color scheme, mirrored for the shim's matchMedia so it agrees with
  // the cascade.
  darkColorScheme: boolean;

  // Runs queued custom-element upgrades. installGlobals sets it; module imports and inbound calls
  // drain in handler scope, where callbacks may do I/O.
  drainCustomElementUpgrades: (() => void) | null;
}

// globalThis with the keys page-script and dom-shim add to it (PageScriptGlobals in types.ts).
export const ksGlobal = globalThis as ShimGlobal;

// The same object for computed keys (constructor-install loops). No type can list those keys,
// so reads are `unknown` and need narrowing.
export const ksGlobalByKey: Record<PropertyKey, unknown> = globalThis;

// Every buildDocument constructor named Event or *Event.
type ShimEventCtorName = Extract<keyof BuildDocumentResult, "Event" | `${string}Event`>;
export type ShimEventCtors = Pick<BuildDocumentResult, ShimEventCtorName>;

// The dom-shim event constructors, which engine-created events use instead of a globalThis.Event
// that page libraries can overwrite. Empty until installGlobals fills it.
export const ksEventCtors: Partial<ShimEventCtors> = {};

// One captured constructor. Before installGlobals it throws the TypeError a bare
// `new ksEventCtors.X()` would have.
export function shimEventCtor<K extends ShimEventCtorName>(name: K): ShimEventCtors[K] {
  const ctor = ksEventCtors[name];
  if (ctor === undefined) throw new TypeError(`${name} is not installed yet`);
  return ctor;
}

let settleArmed: () => void = () => {};
const armedDeferred = new Promise<void>((resolve) => {
  settleArmed = resolve;
});

export const state: PageScriptState = {
  dom: null,
  blobUrls: new Map(),
  pageUrl: "",
  sourceDoctype: null,
  connectionId: "",
  mainFrameId: "",
  cookieKey: "",
  document: null,
  window: null,
  lastForceRestyleSeq: -1,
  lastRecordScrollX: 0,
  lastRecordScrollY: 0,
  lastRecordViewportW: 0,
  lastRecordViewportH: 0,
  currentMediaType: "screen",

  paintCacheHandle: null,
  paintCacheSeq: -1,
  paintCacheFresh: false,
  paintCacheViewportW: 0,
  paintCacheViewportH: 0,
  paintViewportW: DEFAULT_VIEWPORT_WIDTH_PX,
  paintViewportH: DEFAULT_VIEWPORT_HEIGHT_PX,
  scrollX: 0,
  scrollY: 0,

  getOpLog: () => [],
  setReadyState: () => {},
  drainCookieWrites: () => [],
  setCookieString: () => {},
  resolveNodeId: () => null,
  getActiveElement: () => null,
  drainCdpMutationsRaw: () => [],
  dispatchTrustedEvent: (target, event) => target.dispatchEvent(event),
  notifyImageResults: () => {},
  notifyStylesheetResults: () => {},

  loadCompletion: null,

  navigateStarted: false,
  loadCompletionArmed: armedDeferred,
  settleLoadCompletionArmed: () => settleArmed(),

  darkColorScheme: false,
  drainCustomElementUpgrades: null,
};
