// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements textarea values, selection, validity, and form-association behavior.

import type * as Idl from "../../idl/types.generated.js";
import {
  defineReflectedLimitedPositiveUnsignedLongFallback,
  defineReflectedNonNegativeLong,
  defineReflectedString,
} from "../reflect.js";
import { inputStateOf, ksPushInputText } from "./input-state.js";
import { resolveFormOwner } from "./listed.js";
import {
  ksCollapseSelectionToEnd,
  installSelectionMixin,
  type SelectionMember,
} from "./selection.js";
import { installValidityMixin, type ValidityMember } from "./validity.js";
import { labelsForControl } from "./labelable.js";
import { HTMLElement } from "../html-element.js";
import type { HTMLFormElement } from "./form.js";

interface HTMLTextAreaElement extends Pick<
  Idl.HTMLTextAreaElement,
  ValidityMember | SelectionMember | "dirName"
> {}

class HTMLTextAreaElement extends HTMLElement implements Idl.HTMLTextAreaElement {
  declare minLength: number;
  get type() {
    return "textarea";
  }
  get value() {
    const s = inputStateOf(this);
    const raw = s.valueDirty ? s.value : this.textContent || "";
    return raw.indexOf("\r") === -1 ? raw : raw.replace(/\r\n?/g, "\n");
  }
  set value(v) {
    const s = inputStateOf(this);
    const str = String(v);
    if (s.defaultValueAttr === undefined) {
      s.defaultValueAttr = this.textContent || "";
    }
    const beforeValue = this.value;
    s.valueDirty = true;
    s.value = str;
    const changed = this.value !== beforeValue;
    ksPushInputText(this, str);
    if (changed) ksCollapseSelectionToEnd(this);
  }
  get defaultValue() {
    return this.textContent || "";
  }
  set defaultValue(v) {
    this.textContent = String(v);
  }
  get name() {
    return this.getAttribute("name") || "";
  }
  set name(v) {
    this.setAttribute("name", String(v));
  }
  get placeholder() {
    return this.getAttribute("placeholder") || "";
  }
  set placeholder(v) {
    this.setAttribute("placeholder", String(v));
  }
  get autocomplete() {
    return this.getAttribute("autocomplete") || "";
  }
  set autocomplete(v) {
    this.setAttribute("autocomplete", String(v));
  }
  get wrap() {
    return this.getAttribute("wrap") || "";
  }
  set wrap(v) {
    this.setAttribute("wrap", String(v));
  }
  get required() {
    return this.hasAttribute("required");
  }
  set required(v) {
    if (v) this.setAttribute("required", "");
    else this.removeAttribute("required");
  }
  get disabled() {
    return this.hasAttribute("disabled");
  }
  set disabled(v) {
    if (v) this.setAttribute("disabled", "");
    else this.removeAttribute("disabled");
  }
  get readOnly() {
    return this.hasAttribute("readonly");
  }
  set readOnly(v) {
    if (v) this.setAttribute("readonly", "");
    else this.removeAttribute("readonly");
  }
  get autofocus() {
    return this.hasAttribute("autofocus");
  }
  set autofocus(v) {
    if (v) this.setAttribute("autofocus", "");
    else this.removeAttribute("autofocus");
  }
  get rows() {
    const v = this.getAttribute("rows");
    if (v == null) return 2;
    const n = parseInt(v, 10);
    return Number.isNaN(n) || n <= 0 ? 2 : n;
  }
  set rows(v) {
    this.setAttribute("rows", String(v));
  }
  get cols() {
    const v = this.getAttribute("cols");
    if (v == null) return 20;
    const n = parseInt(v, 10);
    return Number.isNaN(n) || n <= 0 ? 20 : n;
  }
  set cols(v) {
    this.setAttribute("cols", String(v));
  }
  get maxLength() {
    const v = this.getAttribute("maxlength");
    if (v == null) return -1;
    const n = parseInt(v, 10);
    return Number.isNaN(n) || n < 0 ? -1 : n;
  }
  set maxLength(v) {
    const n = v | 0;
    if (n < 0) {
      throw new DOMException(
        "Failed to set the 'maxLength' property: The value provided (" + v + ") is negative.",
        "IndexSizeError",
      );
    }
    this.setAttribute("maxlength", String(n));
  }
  get textLength() {
    return this.value.length;
  }
  get form(): HTMLFormElement | null {
    return resolveFormOwner(this);
  }
  get labels() {
    return labelsForControl(this);
  }
  select() {}
  setSelectionRange(_start: number, _end: number, _dir?: string) {}
  ksMarkUserEdited(): void {
    inputStateOf(this).userEdited = true;
  }
}
installValidityMixin(HTMLTextAreaElement);
installSelectionMixin(HTMLTextAreaElement);

defineReflectedLimitedPositiveUnsignedLongFallback(
  HTMLTextAreaElement.prototype,
  "cols",
  "cols",
  20,
);
defineReflectedLimitedPositiveUnsignedLongFallback(
  HTMLTextAreaElement.prototype,
  "rows",
  "rows",
  2,
);
defineReflectedNonNegativeLong(HTMLTextAreaElement.prototype, "maxLength", "maxlength", -1);
defineReflectedNonNegativeLong(HTMLTextAreaElement.prototype, "minLength", "minlength", -1);

defineReflectedString(HTMLTextAreaElement.prototype, "dirName", "dirname");

export { HTMLTextAreaElement };
