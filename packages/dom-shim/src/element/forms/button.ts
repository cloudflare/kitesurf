// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements HTMLButtonElement reflection, form ownership, validity, and activation behavior.

import type * as Idl from "../../idl/types.generated.js";
import { ELEMENT_NODE } from "../../constants.js";
import {
  defineAttribute,
  defineReflectedEnumWithDefaults,
  defineReflectedString,
  defineReflectedBoolean,
} from "../reflect.js";
import { activateFormButton, resolveFormOwner } from "./listed.js";
import { installValidityMixin, type ValidityMember } from "./validity.js";
import { labelsForControl } from "./labelable.js";
import { activationBehavior } from "../element.js";
import { HTMLElement } from "../html-element.js";
import { HTMLInputElement } from "./input.js";
import type { HTMLFormElement } from "./form.js";

const BUTTON_TYPES = new Set(["submit", "reset", "button"]);

// installValidityMixin and the loops below the class install these.
interface HTMLButtonElement extends Pick<
  Idl.HTMLButtonElement,
  | ValidityMember
  | "formAction"
  | "formEnctype"
  | "formMethod"
  | "formNoValidate"
  | "formTarget"
  | "popoverTargetElement"
  | "popoverTargetAction"
> {}

class HTMLButtonElement extends HTMLElement implements Idl.HTMLButtonElement {
  get type() {
    const raw = (this.getAttribute("type") || "").toLowerCase();
    if (BUTTON_TYPES.has(raw)) return raw;
    if (this.hasAttribute("command") || this.hasAttribute("commandfor")) {
      return "button";
    }
    return "submit";
  }
  set type(v) {
    this.setAttribute("type", String(v));
  }
  get command() {
    const raw = this.getAttribute("command");
    if (raw == null) return "";
    if (raw.startsWith("--")) return raw;
    const lower = raw.toLowerCase();
    if (
      lower === "show-modal" ||
      lower === "close" ||
      lower === "request-close" ||
      lower === "toggle-popover" ||
      lower === "show-popover" ||
      lower === "hide-popover"
    ) {
      return lower;
    }
    return "";
  }
  set command(v) {
    this.setAttribute("command", String(v));
  }
  get commandForElement() {
    const ref = this.getAttribute("commandfor");
    if (!ref) return null;
    const doc = this.ownerDocument;
    try {
      return doc?.getElementById?.(ref) || null;
    } catch {
      return null;
    }
  }
  // The value is not checked to be an Element, only to have getAttribute.
  set commandForElement(v: Idl.Element | null) {
    if (v == null) {
      this.removeAttribute("commandfor");
      return;
    }
    if (typeof v.getAttribute === "function") {
      this.setAttribute("commandfor", v.getAttribute("id") || "");
    }
  }
  get value() {
    return this.getAttribute("value") || "";
  }
  set value(v) {
    this.setAttribute("value", String(v));
  }
  get name() {
    return this.getAttribute("name") || "";
  }
  set name(v) {
    this.setAttribute("name", String(v));
  }
  get disabled() {
    return this.hasAttribute("disabled");
  }
  set disabled(v) {
    if (v) this.setAttribute("disabled", "");
    else this.removeAttribute("disabled");
  }
  get autofocus() {
    return this.hasAttribute("autofocus");
  }
  set autofocus(v) {
    if (v) this.setAttribute("autofocus", "");
    else this.removeAttribute("autofocus");
  }
  get form(): HTMLFormElement | null {
    return resolveFormOwner(this);
  }
  get labels() {
    return labelsForControl(this);
  }
  [activationBehavior](): void {
    const type = this.type;
    if (type === "submit" || type === "reset") activateFormButton(this, type);
  }
}
installValidityMixin(HTMLButtonElement);

const popoverTargets = new WeakMap<object, Idl.Element | null>();
for (const cls of [HTMLInputElement, HTMLButtonElement]) {
  defineAttribute(cls.prototype, "popoverTargetElement", {
    get() {
      return popoverTargets.get(this) ?? null;
    },
    // The value is not checked to be an Element, only to have nodeType 1.
    set(v) {
      popoverTargets.set(this, v && v.nodeType === ELEMENT_NODE ? v : null);
    },
  });
  defineReflectedEnumWithDefaults(
    cls.prototype,
    "popoverTargetAction",
    "popovertargetaction",
    ["toggle", "show", "hide"],
    "toggle",
    "toggle",
  );
  // A missing or empty formaction gives the document's URL.
  defineAttribute(cls.prototype, "formAction", {
    get() {
      const v = this.getAttribute("formaction");
      if (v == null || v === "") {
        const doc = this.ownerDocument;
        if (doc && typeof doc.URL === "string" && doc.URL) return doc.URL;
        return "";
      }
      try {
        return new URL(v, this.baseURI || undefined).toString();
      } catch {
        return v;
      }
    },
    set(value) {
      this.setAttribute("formaction", String(value));
    },
  });
  // Missing and invalid values have different defaults for form submission overrides.
  // https://html.spec.whatwg.org/#attr-fs-formenctype
  defineReflectedEnumWithDefaults(
    cls.prototype,
    "formEnctype",
    "formenctype",
    ["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"],
    "",
    "application/x-www-form-urlencoded",
  );
  defineReflectedEnumWithDefaults(
    cls.prototype,
    "formMethod",
    "formmethod",
    ["get", "post", "dialog"],
    "",
    "get",
  );
  defineReflectedString(cls.prototype, "formTarget", "formtarget");
  defineReflectedBoolean(cls.prototype, "formNoValidate", "formnovalidate");
}

export { HTMLButtonElement };
