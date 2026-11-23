// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements the <dialog> methods. The shim has no top layer, so show() and
// showModal() only track the modal state and toggle the open attribute.

import { KsEvent } from "../events/event.js";
import { HTMLDialogElement } from "./html-classes.js";

interface DialogLike {
  open: boolean;
  returnValue: string;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  dispatchEvent(event: KsEvent): boolean;
  querySelectorAll(selector: string): ArrayLike<FocusTarget>;
  focus?: () => void;
}

interface FocusTarget {
  hasAttribute?(name: string): boolean;
  focus?: () => void;
}

// The first focusable area in tree order, else the dialog itself.
// https://html.spec.whatwg.org/multipage/interactive-elements.html#dialog-focusing-steps
const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  "area[href]",
  "iframe",
  "summary",
  "[contenteditable]",
  "[tabindex]",
].join(",");

function focusInsideDialog(dialog: DialogLike): void {
  let target: FocusTarget | null = null;
  try {
    const autofocus = dialog.querySelectorAll("[autofocus]")[0];
    const focusable = dialog.querySelectorAll(FOCUSABLE_SELECTOR)[0];
    target = autofocus ?? focusable ?? null;
  } catch {}
  const focus = (target ?? dialog).focus;
  if (typeof focus === "function") {
    try {
      focus.call(target ?? dialog);
    } catch {}
  }
}

const returnValues = new WeakMap<object, string>();
const modalDialogs = new WeakMap<object, boolean>();

// show()/showModal() are idempotent per modal state; mixed calls throw.
// https://html.spec.whatwg.org/multipage/interactive-elements.html#dom-dialog-show
const dialogShow = function (this: DialogLike): void {
  if (this.open) {
    if (modalDialogs.get(this) === true) {
      throw new DOMException("The dialog is already open.", "InvalidStateError");
    }
    return;
  }
  modalDialogs.set(this, false);
  this.setAttribute("open", "");
};

const dialogShowModal = function (this: DialogLike): void {
  if (this.open) {
    if (modalDialogs.get(this) === true) return;
    throw new DOMException("The dialog is already open.", "InvalidStateError");
  }
  modalDialogs.set(this, true);
  this.setAttribute("open", "");
  focusInsideDialog(this);
};

const dialogClose = function (this: DialogLike, returnValue?: string): void {
  if (!this.open) return;
  if (returnValue !== undefined) this.returnValue = returnValue;
  this.removeAttribute("open");
  modalDialogs.delete(this);
  // close() queues the close event as a task, so listeners run after close().
  // https://html.spec.whatwg.org/multipage/interactive-elements.html#dom-dialog-close
  const dialog = this;
  setTimeout(() => {
    dialog.dispatchEvent(new KsEvent("close", { bubbles: false, cancelable: false }));
  }, 0);
};

const dialogRequestClose = function (this: DialogLike, returnValue?: string): void {
  if (!this.open) return;
  const cancel = new KsEvent("cancel", { bubbles: false, cancelable: true });
  if (!this.dispatchEvent(cancel)) return;
  dialogClose.call(this, returnValue);
};

Object.defineProperties(HTMLDialogElement.prototype, {
  returnValue: {
    configurable: true,
    enumerable: true,
    get(this: DialogLike): string {
      return returnValues.get(this) ?? "";
    },
    set(this: DialogLike, value: unknown): void {
      returnValues.set(this, String(value));
    },
  },
  show: { configurable: true, writable: true, value: dialogShow },
  showModal: { configurable: true, writable: true, value: dialogShowModal },
  close: { configurable: true, writable: true, value: dialogClose },
  requestClose: { configurable: true, writable: true, value: dialogRequestClose },
});
