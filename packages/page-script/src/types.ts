// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Defines structural views of DOM-shim values consumed by PageScript.

// Derive listener signatures from the dom-shim producer instead of maintaining a local copy.
import type { BuildDocumentResult, DomShimGlobals } from "./dom-shim.js";

// DomHandle's runtime value comes from the loaded worker's wasm-bindgen sibling.
import type { DomHandle } from "../../core/pkg/kitesurf_core";
export type { DomHandle } from "../../core/pkg/kitesurf_core";

export interface ShimCaretNode {
  nodeType?: number;
  nodeName?: string;
  data?: string;
  firstChild?: ShimCaretNode | null;
}

export interface ShimNode extends ShimCaretNode {
  _id?: number;
  contains?(other: unknown): boolean;
  parentNode?: ShimNode | null;
  parentElement?: ShimElement | null;
  dispatchEvent(ev: unknown): boolean;
  addEventListener?: BuildDocumentResult["document"]["addEventListener"];
  removeEventListener?: BuildDocumentResult["document"]["removeEventListener"];
}

export interface ShimElement extends ShimNode {
  tagName?: string;
  namespaceURI?: string | null;
  type?: string;
  checked?: boolean;
  value?: string;
  isContentEditable?: boolean;
  hasAttribute?: (name: string) => boolean;
  getAttribute?: (name: string) => string | null;
  getBoundingClientRect?: () => DomRect | null;
  getClientRects?: () => DomRect[];
  querySelectorAll?: (sel: string) => ArrayLike<ShimElement>;
  querySelector?: (sel: string) => ShimElement | null;
  closest?: (sel: string) => ShimElement | null;
  focus?: () => void;
  scrollIntoView?: (options: { block: string; inline: string }) => void;
  blur?: () => void;
  click?: () => void;
  selectionStart?: number | null;
  selectionEnd?: number | null;
  selectionDirection?: string | null;
  setSelectionRange?: (start: number, end: number, direction?: string) => void;
  __ksCollapseSelectionTo?: (offset: number) => void;
  __ksMarkUserEdited?: () => void;
  form?: {
    elements: ArrayLike<ShimElement>;
    __ksRequestSubmit?: (submitter?: unknown) => string | void;
  };
}

export interface ShimEvent {
  type?: string;
  bubbles?: boolean;
  cancelable?: boolean;
  defaultPrevented?: boolean;
  oldURL?: string;
  newURL?: string;
  state?: unknown;
  deltaX?: number;
  deltaY?: number;
}

export interface DomRect {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface ShimDocument extends ShimNode {
  body: ShimElement | null;
  documentElement: ShimElement | null;
  activeElement: ShimElement | null;
  querySelectorAll: (sel: string) => ArrayLike<ShimElement>;
  doctype?: ShimNode | null;
  baseURI?: string;
  getSelection?: () => {
    rangeCount: number;
    anchorNode: ShimCaretNode | null;
    getRangeAt: (index: number) => {
      startContainer: ShimCaretNode;
      startOffset: number;
      endContainer: ShimCaretNode;
      endOffset: number;
      collapsed: boolean;
    };
    extend: (node: unknown, offset: number) => void;
    collapse: (node: unknown, offset: number) => void;
  } | null;
  execCommand?: (command: string, showUI: boolean, value: string) => boolean;
}

export interface ShimWindow extends ShimNode {
  addEventListener: BuildDocumentResult["document"]["addEventListener"];
  removeEventListener: BuildDocumentResult["document"]["removeEventListener"];
  history?: { state?: unknown };
  getComputedStyle?: (element: ShimElement) => { visibility: string };
  location?: { href?: string; search?: string; [k: string]: unknown };
  navigator: ShimNavigator;
}

// The members of the shim's navigator that page-script reads or fills in.
export interface ShimNavigator {
  userAgent?: string;
  language?: string;
  languages?: readonly string[];
  platform?: string;
  mediaDevices?: unknown;
}

export type { BuildDocumentResult } from "./dom-shim.js";

// The page isolate's globalThis as page-script sees it: dom-shim's view plus the keys only this
// package touches. A key both packages use belongs in DomShimGlobals (dom-shim global-scope.ts).
export interface PageScriptGlobals extends DomShimGlobals {
  // workerd natives that `typeof globalThis` leaves out.
  TextDecoder: typeof TextDecoder;
  Headers: typeof Headers;
  URL: typeof URL;
  AbortController: typeof AbortController;
  origin: string;
  // workerd's until globals.ts swaps in its writable shim; both have these.
  performance: Pick<Performance, "now" | "timeOrigin">;
  // The shim window's navigator once installGlobals runs (workerd's before).
  navigator: ShimNavigator;

  // The shim window's aliases (globals.ts installGlobals).
  window?: ShimWindow;
  self: unknown;
  frames?: unknown;
  postMessage?: (...args: unknown[]) => unknown;

  // Constructors installed from buildDocument's return. EventTarget, Event, MessageEvent and
  // ErrorEvent start as workerd's and are swapped for the shim's before page JS runs.
  EventTarget: BuildDocumentResult["EventTarget"];
  Event: BuildDocumentResult["Event"];
  MessageEvent: BuildDocumentResult["MessageEvent"];
  ErrorEvent: BuildDocumentResult["ErrorEvent"];
  CustomEvent?: BuildDocumentResult["CustomEvent"];
  PromiseRejectionEvent?: BuildDocumentResult["PromiseRejectionEvent"];
  FormData?: BuildDocumentResult["FormData"];
  Animation?: BuildDocumentResult["Animation"];
  AnimationEffect?: BuildDocumentResult["AnimationEffect"];
  KeyframeEffect?: BuildDocumentResult["KeyframeEffect"];
  AnimationTimeline?: BuildDocumentResult["AnimationTimeline"];
  DocumentTimeline?: BuildDocumentResult["DocumentTimeline"];
  AnimationPlaybackEvent?: BuildDocumentResult["AnimationPlaybackEvent"];
  ValidityState?: BuildDocumentResult["ValidityState"];
  CanvasRenderingContext2D?: BuildDocumentResult["CanvasRenderingContext2D"];
  CanvasGradient?: BuildDocumentResult["CanvasGradient"];
  CanvasPattern?: BuildDocumentResult["CanvasPattern"];
  DOMParser?: BuildDocumentResult["DOMParser"];
  StaticRange?: BuildDocumentResult["StaticRange"];
  HTMLDocument?: BuildDocumentResult["Document"];

  // Constructors page-script defines in place, some as plain functions. Nothing constructs them
  // through ksGlobal, so only presence is typed.
  MessageChannel?: Function;
  MessagePort?: Function;
  BroadcastChannel?: Function;
  PerformanceEntry?: Function;
  PerformanceMark?: Function;
  PerformanceMeasure?: Function;
  PerformanceObserver?: Function;
  OffscreenCanvas?: Function;
  Highlight?: Function;
  HighlightRegistry?: Function;
  MediaQueryList?: Function;
  MediaQueryListEvent?: Function;
  XMLHttpRequestUpload?: Function;
  HTMLImageElement?: Function;
  HTMLAudioElement?: Function;
  DOMPoint?: Function;
  FontFace?: Function;
  CSS?: KsCssNamespace;

  // Engine hooks owned by page-script.
  __ks_function_patched?: boolean;
  // Boa's trampolines into V8.
  __ks_thisfwd?: (call: Function, ctor: Function, handle: number) => Function;
  __ks_argpack?: (call: Function, fnHandle: number, recvHandle: number) => Function;
  __ks_resolve_import_map?: (spec: unknown, referrerUrl?: string) => string;
  __ks_import?: (spec: unknown, referrerUrl?: string) => unknown;
  __ks_native_import?: (url: unknown) => Promise<unknown>;
  __ks_module_source?: (url: unknown) => Promise<string>;
  __ks_dark_scheme?: boolean;
  __ksMediaState?: unknown;
  // Custom-element constructor → defined tag name.
  __ks_ctorTagNames?: WeakMap<object, string>;
  __ks_drainCustomElementUpgrades?: () => void;
  __ks_canonicalize_inline_style?: (
    css: string,
  ) => Array<{ name: string; value: string; important?: boolean }>;
  __ks_uaStylesheetText?: string;
  __ks_dom_debug?: DomHandle | null;
  // Installed by the engine's memprof build.
  __ks_memprof_imports?: unknown;
  __memprof_dump?: () => string;
  __memprof_reset?: () => void;
}

// The `CSS` namespace object (globals.ts): its functions plus one `CSS.<unit>()` factory per CSS
// unit and the highlight registry.
export interface KsCssNamespace {
  escape(identifier: unknown): string;
  supports(propertyOrCondition: unknown, value?: unknown): boolean;
  registerProperty(options: unknown): void;
  highlights?: unknown;
  [unit: string]: unknown;
}

export type ShimGlobal = typeof globalThis & PageScriptGlobals;
