// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements fieldset and legend wrappers, form ownership, and listed-control lookup.

import type * as Idl from "../../idl/types.generated.js";
import { makeHtmlCollection } from "../../state.js";
import { resolveFormOwner, formListedDescendants } from "./listed.js";
import { installValidityMixin, type ValidityMember } from "./validity.js";
import { HTMLElement } from "../html-element.js";
import type { HTMLFormElement } from "./form.js";

interface HTMLFieldSetElement extends Pick<Idl.HTMLFieldSetElement, ValidityMember> {}
class HTMLFieldSetElement extends HTMLElement implements Idl.HTMLFieldSetElement {
  get type() {
    return "fieldset";
  }
  get disabled() {
    return this.hasAttribute("disabled");
  }
  set disabled(v) {
    if (v) this.setAttribute("disabled", "");
    else this.removeAttribute("disabled");
  }
  get name() {
    return this.getAttribute("name") || "";
  }
  set name(v) {
    this.setAttribute("name", String(v));
  }
  get form(): HTMLFormElement | null {
    return resolveFormOwner(this);
  }
  get elements() {
    return makeHtmlCollection(() => formListedDescendants(this));
  }
}
interface HTMLLegendElement extends Pick<Idl.HTMLLegendElement, "align"> {}
class HTMLLegendElement extends HTMLElement implements Idl.HTMLLegendElement {
  get form() {
    const parent = this.parentNode;
    if (parent && parent instanceof HTMLFieldSetElement) {
      return parent.form;
    }
    return null;
  }
}
installValidityMixin(HTMLFieldSetElement);

export { HTMLFieldSetElement, HTMLLegendElement };
