// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements text-control selection APIs and their range-change notifications.

import type * as Idl from "../../idl/types.generated.js";
import { DOCUMENT_FRAGMENT_NODE } from "../../constants.js";
import { documentImpl as document, dom } from "../../state.js";
import { dispatchTrustedEvent } from "../../events/dispatch.js";
import { selectionState } from "../../registries.js";
import { markDamageNode, bumpMutationSeq } from "../../mutations/seq.js";
import { KsEvent } from "../../events/event.js";
import { inputTypeOf } from "./input-state.js";
import { isHtmlTag } from "../html-tag.js";
import { defineAttribute } from "../reflect.js";
import type { HTMLInputElement } from "./input.js";
import type { HTMLTextAreaElement } from "./textarea.js";

type TextControl = HTMLInputElement | HTMLTextAreaElement;
type SelectionState = NonNullable<ReturnType<typeof selectionState.get>>;

const SELECTION_TYPES = new Set(["text", "search", "url", "tel", "password"]);

function supportsSelection(control: unknown): boolean {
  if (isHtmlTag(control, "textarea")) return true;
  if (isHtmlTag(control, "input")) {
    return SELECTION_TYPES.has(inputTypeOf(control));
  }
  return false;
}

function selectionStateOf(control: TextControl): SelectionState {
  const id = control._id;
  let s = selectionState.get(id);
  if (!s) {
    s = { start: 0, end: 0, direction: "none" };
    selectionState.set(id, s);
  }
  const len = (control.value || "").length;
  if (s.start > len) s.start = len;
  if (s.end > len) s.end = len;
  return s;
}

function ksToUint32(v: unknown): number {
  return Number(v) >>> 0;
}

const pendingSelectEvent = new Set();
function ksSetSelectionRange(
  control: TextControl,
  start: number,
  end: number,
  direction: string | undefined,
) {
  const len = (control.value || "").length;
  const b = Math.min(end, len);
  const a = Math.min(start, b);
  const dir = direction === "forward" || direction === "backward" ? direction : "none";
  const s = selectionStateOf(control);
  const changed = s.start !== a || s.end !== b || s.direction !== dir;
  s.start = a;
  s.end = b;
  s.direction = dir;
  if (!changed) return;
  ksPushSelectionToWasm(control);
  ksFireControlSelectionchange(control);
  const id = control._id;
  if (pendingSelectEvent.has(id)) return;
  pendingSelectEvent.add(id);
  setTimeout(() => {
    pendingSelectEvent.delete(id);
    try {
      dispatchTrustedEvent(
        control,
        new KsEvent("select", {
          bubbles: true,
          cancelable: false,
        }),
      );
    } catch {}
  }, 0);
}

const pendingSelectionchange = new Set<number>();
let suppressControlSelectionchange = 0;
function ksFireControlSelectionchange(control: TextControl) {
  if (suppressControlSelectionchange > 0) return;
  const id = control._id;
  if (pendingSelectionchange.has(id)) return;
  pendingSelectionchange.add(id);
  setTimeout(() => {
    pendingSelectionchange.delete(id);
    const target = selectionchangeTarget(control);
    try {
      dispatchTrustedEvent(
        target,
        new KsEvent("selectionchange", {
          bubbles: true,
          cancelable: false,
        }),
      );
    } catch {}
  }, 0);
}

function selectionchangeTarget(control: TextControl): TextControl | typeof document {
  try {
    const root = control.getRootNode ? control.getRootNode() : null;
    if (isShadowRootWithHost(root)) return document;
  } catch {}
  return control;
}

function isShadowRootWithHost(root: ReturnType<TextControl["getRootNode"]> | null): boolean {
  return Boolean(root && root.nodeType === DOCUMENT_FRAGMENT_NODE && Reflect.get(root, "host"));
}

function ksCollapseSelectionTo(control: TextControl, offset: number) {
  const position = Math.min(Math.max(offset, 0), (control.value || "").length);
  const s = selectionStateOf(control);
  const changed = s.start !== position || s.end !== position || s.direction !== "none";
  s.start = position;
  s.end = position;
  s.direction = "none";
  ksPushSelectionToWasm(control);
  if (changed) ksFireControlSelectionchange(control);
}

function ksCollapseSelectionToEnd(control: TextControl): void {
  ksCollapseSelectionTo(control, (control.value || "").length);
}

function ksPushSelectionToWasm(control: TextControl) {
  try {
    const s = selectionStateOf(control);
    const domHandle = dom;
    if (
      typeof domHandle.setInputSelection === "function" &&
      domHandle.setInputSelection(control._id, s.start | 0, s.end | 0)
    ) {
      markDamageNode(control._id);
      bumpMutationSeq();
    }
  } catch {}
}

type SelectionMember =
  | "selectionStart"
  | "selectionEnd"
  | "selectionDirection"
  | "setSelectionRange"
  | "select"
  | "setRangeText";
type SelectionPrototype = TextControl & {
  __ksCollapseSelectionTo?: (offset: number) => void;
};

type SelectionRange = { start: number; end: number };

function installSelectionMixin(Cls: { prototype: SelectionPrototype }): void {
  defineAttribute(Cls.prototype, "selectionStart", {
    get() {
      if (!supportsSelection(this)) return null;
      return selectionStateOf(this).start;
    },
    set(v) {
      if (!supportsSelection(this)) {
        throw new DOMException(
          "selectionStart: not supported on this element",
          "InvalidStateError",
        );
      }
      const n = ksToUint32(v);
      const s = selectionStateOf(this);
      ksSetSelectionRange(this, n, Math.max(n, s.end), s.direction);
    },
  });
  defineAttribute(Cls.prototype, "selectionEnd", {
    get() {
      if (!supportsSelection(this)) return null;
      return selectionStateOf(this).end;
    },
    set(v) {
      if (!supportsSelection(this)) {
        throw new DOMException("selectionEnd: not supported on this element", "InvalidStateError");
      }
      const s = selectionStateOf(this);
      ksSetSelectionRange(this, s.start, ksToUint32(v), s.direction);
    },
  });
  defineAttribute(Cls.prototype, "selectionDirection", {
    get() {
      if (!supportsSelection(this)) return null;
      return selectionStateOf(this).direction;
    },
    set(v) {
      if (!supportsSelection(this)) {
        throw new DOMException(
          "selectionDirection: not supported on this element",
          "InvalidStateError",
        );
      }
      const s = selectionStateOf(this);
      ksSetSelectionRange(this, s.start, s.end, String(v));
    },
  });
  Cls.prototype.setSelectionRange = function (
    this: TextControl,
    start: number,
    end: number,
    direction?: string,
  ) {
    if (!supportsSelection(this)) {
      throw new DOMException(
        "setSelectionRange: not supported on this element",
        "InvalidStateError",
      );
    }
    ksSetSelectionRange(this, ksToUint32(start), ksToUint32(end), direction);
  };
  Cls.prototype.__ksCollapseSelectionTo = function (this: TextControl, offset: number) {
    if (supportsSelection(this)) ksCollapseSelectionTo(this, offset);
  };
  Cls.prototype.select = function (this: TextControl) {
    if (!supportsSelection(this)) return;
    ksSetSelectionRange(this, 0, (this.value || "").length, "none");
  };
  Cls.prototype.setRangeText = function (
    this: TextControl,
    replacement: string,
    start?: number,
    end?: number,
    selectMode?: Idl.SelectionMode,
  ) {
    setRangeTextImplementation(this, arguments.length, replacement, start, end, selectMode);
  };
}

function setRangeTextImplementation(
  control: TextControl,
  argumentCount: number,
  replacement: string,
  start: number | undefined,
  end: number | undefined,
  selectMode: Idl.SelectionMode | undefined,
): void {
  validateRangeTextCall(control, argumentCount);
  const value = control.value || "";
  const selection = selectionStateOf(control);
  const oldStart = selection.start;
  const oldEnd = selection.end;
  const bounds = rangeTextBounds(argumentCount, start, end, oldStart, oldEnd, value.length);
  const replacementText = normalizeRangeTextReplacement(replacement);
  const newValue = value.slice(0, bounds.start) + replacementText + value.slice(bounds.end);
  // Coalesce the value and range updates into one selectionchange after the final range is set.
  setSuppressedInputValue(control, newValue);
  const mode = selectMode || "preserve";
  const range = rangeAfterReplacement(mode, bounds, replacementText.length, oldStart, oldEnd);
  const finalChanged = rangeTextSelectionChanged(range, oldStart, oldEnd);
  setSuppressedSelectionRange(control, range, selection.direction);
  if (finalChanged) ksFireControlSelectionchange(control);
}

function normalizeRangeTextReplacement(replacement: string): string {
  return replacement == null ? "" : String(replacement);
}

function rangeTextSelectionChanged(
  range: SelectionRange,
  oldStart: number,
  oldEnd: number,
): boolean {
  return range.start !== oldStart || range.end !== oldEnd;
}

function validateRangeTextCall(control: TextControl, argumentCount: number): void {
  if (argumentCount === 0) throw new TypeError("setRangeText: 1 argument required");
  if (!supportsSelection(control)) {
    throw new DOMException("setRangeText: not supported on this element", "InvalidStateError");
  }
}

function rangeTextBounds(
  argumentCount: number,
  start: number | undefined,
  end: number | undefined,
  oldStart: number,
  oldEnd: number,
  length: number,
): SelectionRange {
  if (argumentCount < 2) return { start: oldStart, end: oldEnd };
  const startOffset = ksToUint32(start);
  const endOffset = ksToUint32(end);
  if (startOffset > endOffset) {
    throw new DOMException("setRangeText: start > end", "IndexSizeError");
  }
  return {
    start: Math.min(length, startOffset),
    end: Math.min(length, endOffset),
  };
}

function setSuppressedInputValue(control: TextControl, value: string): void {
  suppressControlSelectionchange++;
  try {
    control.value = value;
  } finally {
    suppressControlSelectionchange--;
  }
}

function rangeAfterReplacement(
  mode: Idl.SelectionMode | "preserve",
  bounds: SelectionRange,
  replacementLength: number,
  oldStart: number,
  oldEnd: number,
): SelectionRange {
  if (mode === "select") {
    return { start: bounds.start, end: bounds.start + replacementLength };
  }
  if (mode === "start") return { start: bounds.start, end: bounds.start };
  if (mode === "end") {
    return { start: bounds.start + replacementLength, end: bounds.start + replacementLength };
  }
  return preservedRange(bounds, replacementLength, oldStart, oldEnd);
}

function preservedRange(
  bounds: SelectionRange,
  replacementLength: number,
  oldStart: number,
  oldEnd: number,
): SelectionRange {
  const delta = replacementLength - (bounds.end - bounds.start);
  return {
    start:
      oldStart > bounds.end ? oldStart + delta : oldStart > bounds.start ? bounds.start : oldStart,
    end:
      oldEnd > bounds.end
        ? oldEnd + delta
        : oldEnd > bounds.start
          ? bounds.start + replacementLength
          : oldEnd,
  };
}

function setSuppressedSelectionRange(
  control: TextControl,
  range: SelectionRange,
  direction: string,
): void {
  suppressControlSelectionchange++;
  try {
    ksSetSelectionRange(control, range.start, range.end, direction);
  } finally {
    suppressControlSelectionchange--;
  }
}

export {
  type SelectionMember,
  installSelectionMixin,
  ksCollapseSelectionToEnd,
  selectionStateOf,
  supportsSelection,
};
