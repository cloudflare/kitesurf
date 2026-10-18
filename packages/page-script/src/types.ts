// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Defines structural views of DOM-shim values consumed by PageScript.

// Derive listener signatures from the dom-shim producer instead of maintaining a local copy.
import type { BuildDocumentResult } from "./dom-shim.js";

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
  navigator?: unknown;
}

export type { BuildDocumentResult } from "./dom-shim.js";

export type ShimGlobal = Record<PropertyKey, any>;
