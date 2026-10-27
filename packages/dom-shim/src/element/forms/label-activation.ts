// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Label lookup and forwarding metadata shared by Element.click() and PageScript's CDP click.
// This lives below label.ts because element.ts cannot import a module that extends HTMLElement.
import { __ks_trustedFlags } from "../../trust.js";
import { KsPointerEvent } from "../../events/event.js";
import type { KsMouseEvent } from "../../events/event.js";
import { isElementWrapper, isHtmlTag } from "../html-tag.js";
import { inputTypeOf } from "./input-state.js";
import type { Element } from "../element.js";

export type ForwardedClick = {
  trusted: boolean;
  init: {
    pointerId: number | undefined;
    pointerType: string | undefined;
    isPrimary: boolean | undefined;
    detail: number;
    clientX: number;
    clientY: number;
    screenX: number;
    screenY: number;
  };
};

// Keep pointer properties from a real user click (WPT label-forwarded-click-pointer-properties).
// Only the shim's event brand, never a page-provided isTrusted property, grants trust.
export function forwardedClickFrom(original: KsMouseEvent | null): ForwardedClick | null {
  if (!original) return null;
  return {
    trusted: __ks_trustedFlags.get(original) === true,
    init: {
      pointerId: original instanceof KsPointerEvent ? original.pointerId : undefined,
      pointerType: original instanceof KsPointerEvent ? original.pointerType : undefined,
      isPrimary: original instanceof KsPointerEvent ? original.isPrimary : undefined,
      detail: original.detail,
      clientX: original.clientX,
      clientY: original.clientY,
      screenX: original.screenX,
      screenY: original.screenY,
    },
  };
}

// Interactive content (HTML "interactive content"): a click inside one stays its own and
// never reaches the label around it (WPT clicking-interactive-content, label-default-action).
function isInteractiveContent(el: Element): boolean {
  switch ((el.nodeName || "").toUpperCase()) {
    case "A":
      return el.hasAttribute("href");
    case "AUDIO":
    case "VIDEO":
      return el.hasAttribute("controls");
    case "IMG":
      return el.hasAttribute("usemap");
    case "INPUT":
      return inputTypeOf(el) !== "hidden";
    case "BUTTON":
    case "DETAILS":
    case "EMBED":
    case "IFRAME":
    case "LABEL":
    case "SELECT":
    case "TEXTAREA":
      return true;
    default:
      return false;
  }
}

// An unprevented click on a label, or on non-interactive content in it, is a click on its control.
// Without it a styled checkbox under its label never ticked.
export function labelControlFor(target: unknown): Element | null {
  let n: unknown = target;
  for (; isElementWrapper(n); n = n.parentNode) {
    if (isHtmlTag(n, "label")) break;
    if (isInteractiveContent(n)) return null;
  }
  if (!isHtmlTag(n, "label")) return null;
  // label.control only returns a labelable element, which is always a wrapper.
  const control = n.control;
  // Both click paths pass the shim Element that received the click.
  if (!control || control === target || control.contains(target as Element)) return null;
  return control;
}

export function focusForwardedTextControl(control: Element): void {
  const kind = (control.nodeName || "").toUpperCase();
  if (takesTextFocus(kind, control)) control.focus();
}

function takesTextFocus(kind: string, control: Element): boolean {
  switch (kind) {
    case "TEXTAREA":
    case "SELECT":
      return true;
    case "INPUT":
      return !["checkbox", "radio", "submit", "reset", "button", "image"].includes(
        inputTypeOf(control),
      );
    default:
      return false;
  }
}
