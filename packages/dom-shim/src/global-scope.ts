// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// The page isolate's globalThis as dom-shim sees it. page-script shares the same globalThis, so
// its PageScriptGlobals extends this. A key one package writes and the other reads belongs here.
// `typeof globalThis` lacks what workers-types declares as a class or const (DOMException, Blob,
// crypto, console), so those, the page globals the shim installs and every hook are listed here.

import type { DocumentImpl } from "./document.js";
import type { Element } from "./element/element.js";
import type { KsDataTransfer, KsFileList } from "./file-input.js";
import type * as Idl from "./idl/types.generated.js";

// window.getComputedStyle's Proxy. The generated IDL type has no per-property members, so
// camelCase reads (`.opacity`) go through the index signature.
export type ComputedStyle = Idl.CSSStyleProperties & { readonly [property: string]: unknown };

export interface DomShimGlobals {
  // workerd natives that `typeof globalThis` leaves out.
  DOMException: typeof DOMException;
  TextEncoder: typeof TextEncoder;
  crypto: Crypto;
  console: Console;
  // workerd's Blob and File until file-input.ts swaps in the shim's stand-ins, which keep the
  // native prototypes.
  Blob: typeof Blob;
  File: typeof File;

  // Page globals installed by dom-shim (file-input.ts) or by page-script from buildDocument's
  // return. Optional: absent until installed, and absent for good in a bare WPT harness.
  FileList?: typeof KsFileList;
  DataTransfer?: typeof KsDataTransfer;
  DataTransferItem?: unknown;
  DataTransferItemList?: unknown;
  ImageData?: new (data: Uint8ClampedArray, width: number, height: number) => unknown;
  DOMStringMap?: { prototype: object };
  document?: DocumentImpl;
  window?: unknown;
  location?: { href: string; origin: string };
  // Legacy window.event, the event being dispatched (dispatch.ts).
  event?: unknown;
  onerror?: unknown;
  innerWidth?: number;
  innerHeight?: number;
  scrollX: number;
  scrollY: number;
  getComputedStyle(element: object, pseudoElement?: string | null): ComputedStyle;
  // Page JS may reassign these through window's setters, so readers check typeof before calling.
  requestAnimationFrame?: (callback: (time: number) => void) => number;
  cancelAnimationFrame?: (handle: number) => void;

  // Engine hooks. page-script installs most; dom-shim installs the __ksLabelActivate,
  // __ksSelectDropdown*, __ks_scrollByWheel and __ks_createElementNoUpgrade entry points.
  __ks_cdpDomActive?: boolean;
  __ks_tty_cell_w?: number;
  __ks_tty_cell_h?: number;
  // Trace parent of the current RPC, stamped by ws-dispatch.
  __ksTp?: string;
  // Test override for the canvas push throttle, in ms. Set by page JS.
  __KS_CANVAS_PUSH_MS?: unknown;
  __ksJsSpanEnter?: (op: string, bytes: number, detail: string) => number;
  __ksJsSpanExit?: (slot: number) => void;
  __ksFontOutlineDemand?: () => Promise<void> | null;
  __ks_fontsReady?: () => Promise<void>;
  __ks_fontsInflightCount?: () => number;
  __ks_fontDemand?: () => boolean;
  __ks_notifyConnected?: (root: Element) => void;
  __ks_upgradeCustomElement?: (element: Element, tagName: string) => void;
  __ks_customElementObservesAttribute?: (element: Element, name: string) => boolean;
  __ks_notifyCustomElementAttributeChanged?: (
    element: Element,
    name: string,
    oldValue: string | null,
    newValue: string | null,
    namespace: string | null,
  ) => void;
  __ks_createElementNoUpgrade?: (tag: string) => unknown;
  __ks_scrollByWheel?: (hitNodeId: number, dx: number, dy: number) => boolean;
  __ksLabelActivate?: (target: unknown, original?: unknown) => void;
  __ksSelectDropdownToggle?: (select: unknown) => boolean;
  __ksSelectDropdownClose?: () => void;
}

export type ShimGlobal = typeof globalThis & DomShimGlobals;
