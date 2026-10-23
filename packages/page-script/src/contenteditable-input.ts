// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Applies contenteditable edits and dispatches the relevant input events.

import { ksEventCtors, ksGlobal, state } from "./state.ts";
import type { ShimCaretNode, ShimDocument, ShimElement } from "./types.ts";

type Dispatch = (target: unknown, event: unknown) => boolean;

export type EditInputType =
  | "insertText"
  | "insertParagraph"
  | "insertLineBreak"
  | "deleteContentBackward"
  | "deleteContentForward";

const COMMANDS: Record<EditInputType, string> = {
  insertText: "insertText",
  insertParagraph: "insertParagraph",
  insertLineBreak: "insertLineBreak",
  deleteContentBackward: "delete",
  deleteContentForward: "forwardDelete",
};

type EditSelection = NonNullable<ReturnType<NonNullable<ShimDocument["getSelection"]>>>;

export function editingHostOf(el: ShimElement | null): ShimElement | null {
  if (!el || el.isContentEditable !== true) return null;
  let host = el;
  while (host.parentElement && host.parentElement.isContentEditable === true) {
    host = host.parentElement;
  }
  return host;
}

function firstCaretPosition(host: ShimCaretNode): [ShimCaretNode, number] {
  let node = host;
  while (node.firstChild && hasNonBreakElementChild(node.firstChild)) node = node.firstChild;
  if (node.firstChild && node.firstChild.nodeType === 3) return [node.firstChild, 0];
  return [node, 0];
}

function hasNonBreakElementChild(node: NonNullable<ShimCaretNode["firstChild"]>): boolean {
  return node.nodeType === 1 && node.nodeName !== "BR";
}

function targetOffsets(
  range: ReturnType<EditSelection["getRangeAt"]>,
  inputType: EditInputType,
): { start: number; end: number } {
  const isTextCaret = range.collapsed && range.startContainer.nodeType === 3;
  const length = isTextCaret ? (range.startContainer.data || "").length : 0;
  const start = targetStartOffset(range.startOffset, isTextCaret, inputType);
  const end = targetEndOffset(range.endOffset, isTextCaret, inputType, length);
  return { start, end };
}

function targetStartOffset(start: number, isTextCaret: boolean, inputType: EditInputType): number {
  return isTextCaret && inputType === "deleteContentBackward" && start > 0 ? start - 1 : start;
}

function targetEndOffset(
  end: number,
  isTextCaret: boolean,
  inputType: EditInputType,
  length: number,
): number {
  return isTextCaret && inputType === "deleteContentForward" && end < length ? end + 1 : end;
}

function targetRanges(sel: EditSelection, inputType: EditInputType): unknown[] {
  const StaticRange = ksGlobal.StaticRange as
    | (new (init: Record<string, unknown>) => unknown)
    | undefined;
  if (typeof StaticRange !== "function" || sel.rangeCount === 0) return [];
  const r = sel.getRangeAt(0);
  const { start, end } = targetOffsets(r, inputType);
  try {
    return [
      new StaticRange({
        startContainer: r.startContainer,
        startOffset: start,
        endContainer: r.endContainer,
        endOffset: end,
      }),
    ];
  } catch {
    return [];
  }
}

type InputEventCtor = new (type: string, init: Record<string, unknown>) => unknown;

function prepareSelection(host: ShimElement, sel: EditSelection): void {
  if (sel.rangeCount === 0 || !sel.anchorNode || !host.contains?.(sel.anchorNode)) {
    const [node, offset] = firstCaretPosition(host);
    sel.collapse(node, offset);
  }
}

function dispatchBeforeInput(
  host: ShimElement,
  inputType: EditInputType,
  data: string | null,
  sel: EditSelection,
  InputEvent: InputEventCtor,
  dispatch: Dispatch,
): boolean {
  const before = new InputEvent("beforeinput", {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: state.window,
    inputType,
    data,
    targetRanges: targetRanges(sel, inputType),
  });
  return dispatch(host, before);
}

function dispatchTextInput(
  host: ShimElement,
  inputType: EditInputType,
  data: string | null,
  dispatch: Dispatch,
): boolean {
  if (inputType !== "insertText" && inputType !== "insertParagraph") return true;
  const TextEvent = ksEventCtors.TextEvent as
    | (new (type: string, init: Record<string, unknown>) => unknown)
    | undefined;
  if (typeof TextEvent !== "function") return true;
  const textInput = new TextEvent("textInput", {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: state.window,
    data: inputType === "insertText" ? data : "\n",
  });
  return dispatch(host, textInput);
}

function dispatchInput(
  host: ShimElement,
  inputType: EditInputType,
  data: string | null,
  doc: NonNullable<typeof state.document>,
  sel: EditSelection,
  InputEvent: InputEventCtor,
  dispatch: Dispatch,
): boolean {
  if (!selectionRemainsInHost(host, sel)) return true;
  if (!executeEditCommand(doc, inputType, data)) return true;
  dispatch(
    host,
    new InputEvent("input", {
      bubbles: true,
      cancelable: false,
      composed: true,
      view: state.window,
      inputType,
      data,
    }),
  );
  return true;
}

function selectionRemainsInHost(host: ShimElement, sel: EditSelection): boolean {
  return !!sel.anchorNode && !!host.contains?.(sel.anchorNode);
}

function executeEditCommand(
  doc: NonNullable<typeof state.document>,
  inputType: EditInputType,
  data: string | null,
): boolean {
  return !!doc.execCommand?.(COMMANDS[inputType], false, data ?? "");
}

interface EditingContext {
  doc: NonNullable<typeof state.document>;
  sel: EditSelection;
  InputEvent: InputEventCtor;
}

function selectionForDocument(doc: typeof state.document) {
  return doc?.getSelection?.();
}

function getEditingContext(): EditingContext | null {
  const doc = state.document;
  const InputEvent = ksEventCtors.InputEvent as InputEventCtor | undefined;
  const sel = selectionForDocument(doc);
  if (!doc || !sel || typeof InputEvent !== "function") return null;
  return { doc, sel, InputEvent };
}

export function editContentEditable(
  host: ShimElement,
  inputType: EditInputType,
  data: string | null,
  dispatch: Dispatch,
): boolean {
  const context = getEditingContext();
  if (!context) return true;
  const { doc, sel, InputEvent } = context;
  prepareSelection(host, sel);
  if (!dispatchBeforeInput(host, inputType, data, sel, InputEvent, dispatch)) return false;
  if (!dispatchTextInput(host, inputType, data, dispatch)) return false;
  return dispatchInput(host, inputType, data, doc, sel, InputEvent, dispatch);
}
