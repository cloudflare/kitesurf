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

type EditingEventCtor = new (type: string, init: Record<string, unknown>) => unknown;

// Chrome gives InputEvent and TextEvent the window as their view; the shim's window is not a
// DOM-typed Window, so these two constructors take a looser init here.
export function editingEvent(
  name: "InputEvent" | "TextEvent",
  type: string,
  init: Record<string, unknown>,
): unknown {
  const EventCtor = ksEventCtors[name] as EditingEventCtor | undefined;
  if (typeof EventCtor !== "function") throw new TypeError(`${name} is not installed yet`);
  return new EventCtor(type, { bubbles: true, composed: true, view: state.window, ...init });
}

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
  while (node.firstChild && node.firstChild.nodeType === 1 && node.firstChild.nodeName !== "BR") {
    node = node.firstChild;
  }
  if (node.firstChild && node.firstChild.nodeType === 3) return [node.firstChild, 0];
  return [node, 0];
}

function targetRanges(sel: EditSelection, inputType: EditInputType): unknown[] {
  const StaticRange = ksGlobal.StaticRange as
    | (new (init: Record<string, unknown>) => unknown)
    | undefined;
  if (typeof StaticRange !== "function" || sel.rangeCount === 0) return [];
  const r = sel.getRangeAt(0);
  let start = r.startOffset;
  let end = r.endOffset;
  if (r.collapsed && r.startContainer.nodeType === 3) {
    const len = (r.startContainer.data || "").length;
    if (inputType === "deleteContentBackward" && start > 0) start--;
    if (inputType === "deleteContentForward" && end < len) end++;
  }
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

export function editContentEditable(
  host: ShimElement,
  inputType: EditInputType,
  data: string | null,
  dispatch: Dispatch,
): boolean {
  const doc = state.document;
  const sel = doc?.getSelection?.();
  if (!doc || !sel || typeof ksEventCtors.InputEvent !== "function") return true;
  if (sel.rangeCount === 0 || !sel.anchorNode || !host.contains?.(sel.anchorNode)) {
    const [node, offset] = firstCaretPosition(host);
    sel.collapse(node, offset);
  }
  const before = editingEvent("InputEvent", "beforeinput", {
    cancelable: true,
    inputType,
    data,
    targetRanges: targetRanges(sel, inputType),
  });
  if (!dispatch(host, before)) return false;
  const enteredText = inputType === "insertText" || inputType === "insertParagraph";
  if (enteredText && typeof ksEventCtors.TextEvent === "function") {
    const textInput = editingEvent("TextEvent", "textInput", {
      cancelable: true,
      data: inputType === "insertText" ? data : "\n",
    });
    if (!dispatch(host, textInput)) return false;
  }
  if (!sel.anchorNode || !host.contains?.(sel.anchorNode)) return true;
  if (!doc.execCommand?.(COMMANDS[inputType], false, data ?? "")) return true;
  dispatch(host, editingEvent("InputEvent", "input", { cancelable: false, inputType, data }));
  return true;
}
