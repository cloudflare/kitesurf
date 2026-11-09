// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements the <dialog> methods. The shim has no top layer, so show() and
// showModal() only toggle the open attribute.

import { KsEvent } from "../events/event.js";
import { HTMLDialogElement } from "./html-classes.js";

interface DialogLike {
  open: boolean;
  returnValue: string;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  dispatchEvent(event: KsEvent): boolean;
}

const returnValues = new WeakMap<object, string>();

const dialogShow = function (this: DialogLike): void {
  if (this.open) throw new DOMException("The dialog is already open.", "InvalidStateError");
  this.setAttribute("open", "");
};

const dialogClose = function (this: DialogLike, returnValue?: string): void {
  if (!this.open) return;
  if (returnValue !== undefined) this.returnValue = returnValue;
  this.removeAttribute("open");
  this.dispatchEvent(new KsEvent("close", { bubbles: false, cancelable: false }));
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
  showModal: { configurable: true, writable: true, value: dialogShow },
  close: { configurable: true, writable: true, value: dialogClose },
  requestClose: { configurable: true, writable: true, value: dialogRequestClose },
});
