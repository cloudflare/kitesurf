// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Defines structural views of DOM-shim values consumed by PageScript.

// Derive listener signatures from the dom-shim producer instead of maintaining a local copy.
import type { BuildDocumentResult, DomShimGlobals, ScrollIntoViewOptions } from "./dom-shim.js";

// DomHandle's runtime value comes from the loaded worker's wasm-bindgen sibling.
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
  value?: string | number;
  isContentEditable?: boolean;
  hasAttribute?: (name: string) => boolean;
  getAttribute?: (name: string) => string | null;
  getBoundingClientRect?: () => DomRect | null;
  getClientRects?: () => ArrayLike<DomRect | null>;
  querySelectorAll?: (sel: string) => ArrayLike<ShimElement>;
  querySelector?: (sel: string) => ShimElement | null;
  closest?: (sel: string) => ShimElement | null;
  focus?: () => void;
  scrollIntoView?: (options: ScrollIntoViewOptions) => void;
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
    // Method syntax: the shim takes a submitter element, and callers pass one.
    __ksRequestSubmit?(submitter?: unknown): string | null | void;
  } | null;
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
    // Method syntax: the shim takes a Node, and callers pass one.
    extend(node: unknown, offset: number): void;
    collapse(node: unknown, offset: number): void;
  } | null;
  execCommand?: (command: string, showUI: boolean, value: string) => boolean;
}

type ShimWindowProducer = BuildDocumentResult["window"];
type ShimGetComputedStyle = NonNullable<ShimWindowProducer["getComputedStyle"]>;

export interface ShimWindow extends ShimNode {
  addEventListener: ShimWindowProducer["addEventListener"];
  removeEventListener: ShimWindowProducer["removeEventListener"];
  history?: { state?: unknown };
  getComputedStyle?(
    element: ShimElement | Parameters<ShimGetComputedStyle>[0],
  ): Pick<ReturnType<ShimGetComputedStyle>, "getPropertyValue">;
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
  PerformanceNavigationTiming?: Function;
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

  // Called by name from the engine's rewritten module code, so they stay page globals; the wasm
  // reads __ks_resolve_import_map too.
  __ks_resolve_import_map?: (spec: unknown, referrerUrl?: string) => string;
  __ks_import?: (spec: unknown, referrerUrl?: string) => unknown;
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
