// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// The page isolate's globalThis as dom-shim sees it; page-script's PageScriptGlobals extends it.
// `typeof globalThis` lacks what workers-types declares as a class or const (DOMException, Blob,
// crypto, console), so those and the page globals the shim installs are listed here. Engine hooks
// live on the internals record instead (internals.ts).

import type { DocumentImpl } from "./document.js";
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

  // Test override for the canvas push throttle, in ms. Set by page JS.
  __KS_CANVAS_PUSH_MS?: unknown;
}

export type ShimGlobal = typeof globalThis & DomShimGlobals;
