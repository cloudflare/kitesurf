// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Resolves form owners and collects the controls listed by a form.

import type * as Idl from "../../idl/types.generated.js";
import { elementDocument } from "../../state.js";
import { htmlTagOf, isHtmlTag } from "../html-tag.js";
import type { Element } from "../element.js";
import type { HTMLFormElement } from "./form.js";
import type { HTMLButtonElement } from "./button.js";
import type { HTMLFieldSetElement, HTMLLegendElement } from "./fieldset.js";
import type { HTMLInputElement } from "./input.js";
import type { HTMLObjectElement } from "../embedded.js";
import type { HTMLOutputElement } from "./output.js";
import type { HTMLSelectElement } from "./select.js";
import type { HTMLTextAreaElement } from "./textarea.js";

function resolveFormOwner(control: Element): HTMLFormElement | null {
  const ref = control.getAttribute("form");
  if (ref) {
    const doc = elementDocument(control);
    const owner = doc.getElementById(ref);
    if (isHtmlTag(owner, "form")) return owner;
  }
  let n = control.parentNode;
  while (n) {
    if (isHtmlTag(n, "form")) return n;
    n = n.parentNode;
  }
  return null;
}

type ListedElement =
  | HTMLButtonElement
  | HTMLFieldSetElement
  | HTMLInputElement
  | HTMLObjectElement
  | HTMLOutputElement
  | HTMLSelectElement
  | HTMLTextAreaElement;
// https://html.spec.whatwg.org/#category-listed
const LISTED_TAGS = new Set([
  "button",
  "fieldset",
  "input",
  "object",
  "output",
  "select",
  "textarea",
]);
function isFormListed(el: unknown): el is ListedElement {
  const tag = htmlTagOf(el);
  return tag !== null && LISTED_TAGS.has(tag);
}

function isInsideExemptLegend(control: Element, disabledFieldset: HTMLFieldSetElement): boolean {
  let firstLegend: HTMLLegendElement | null = null;
  const kids = disabledFieldset.children;
  if (kids) {
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i];
      if (isHtmlTag(child, "legend")) {
        firstLegend = child;
        break;
      }
    }
  }
  if (!firstLegend) return false;
  let p = control.parentNode;
  while (p && p !== disabledFieldset) {
    if (p === firstLegend) return true;
    p = p.parentNode;
  }
  return false;
}
function isDisabledInFormContext(input: object): boolean {
  // Shared callers pass DOM wrappers through a structural AgentControl contract.
  const control = input as Element;
  if (control.disabled) return true;
  let p = control.parentNode;
  while (p) {
    if (isHtmlTag(p, "fieldset") && p.disabled) {
      if (!isInsideExemptLegend(control, p)) return true;
    }
    p = p.parentNode;
  }
  return false;
}

// A submit or reset button's activation behavior.
// https://html.spec.whatwg.org/#the-button-element
function activateFormButton(
  control: HTMLButtonElement | HTMLInputElement,
  kind: "submit" | "reset",
): void {
  if (control.disabled) return;
  const form = control.form;
  if (!form) return;
  if (kind === "submit") {
    try {
      form.__ksRequestSubmit(control);
    } catch {
      /* spec'd throw paths */
    }
  } else {
    try {
      form.reset();
    } catch {
      /* unlikely */
    }
  }
}

function formListedDescendants(root: Element): ListedElement[] {
  const out: ListedElement[] = [];
  const walk = (node: Idl.Element) => {
    const kids = node.children;
    if (!kids) return;
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i];
      if (!child) continue;
      if (isFormListed(child)) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

export {
  activateFormButton,
  formListedDescendants,
  isDisabledInFormContext,
  isFormListed,
  resolveFormOwner,
};
