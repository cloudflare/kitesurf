// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements output-element values, form association, validity, and labels.

import type * as Idl from "../../idl/types.generated.js";
import { inputStateOf } from "./input-state.js";
import { resolveFormOwner } from "./listed.js";
import { installValidityMixin, type ValidityMember } from "./validity.js";
import { labelsForControl } from "./labelable.js";
import { HTMLElement } from "../html-element.js";
import type { HTMLFormElement } from "./form.js";

interface HTMLOutputElement extends Pick<Idl.HTMLOutputElement, ValidityMember> {
  get htmlFor(): Idl.HTMLOutputElement["htmlFor"];
}
class HTMLOutputElement extends HTMLElement implements Idl.HTMLOutputElement {
  get type() {
    return "output";
  }
  get name() {
    return this.getAttribute("name") || "";
  }
  set name(v) {
    this.setAttribute("name", String(v));
  }
  get value() {
    const s = inputStateOf(this);
    if (s.valueDirty) return s.value;
    return this.textContent || "";
  }
  set value(v) {
    const s = inputStateOf(this);
    s.valueDirty = true;
    s.value = String(v);
    this.textContent = s.value;
  }
  get defaultValue() {
    return this.textContent || "";
  }
  set defaultValue(v) {
    this.textContent = String(v);
  }
  get form(): HTMLFormElement | null {
    return resolveFormOwner(this);
  }
  get labels() {
    return labelsForControl(this);
  }
}
installValidityMixin(HTMLOutputElement);

export { HTMLOutputElement };
