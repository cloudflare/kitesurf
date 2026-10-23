// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements HTMLLabelElement control lookup and label-to-control association.

import type * as Idl from "../../idl/types.generated.js";
import { documentImpl as document } from "../../state.js";
import { isLabelable } from "./labelable.js";
import { HTMLElement } from "../html-element.js";

class HTMLLabelElement extends HTMLElement implements Idl.HTMLLabelElement {
  get htmlFor() {
    return this.getAttribute("for") || "";
  }
  set htmlFor(v) {
    this.setAttribute("for", String(v));
  }
  get control() {
    const forId = this.getAttribute("for");
    if (forId) return controlForId(this, forId);
    return firstLabelableDescendant(this);
  }
  get form() {
    const c = this.control;
    return c ? c.form : null;
  }
}

function controlForId(label: HTMLLabelElement, id: string): HTMLElement | null {
  const doc = label.ownerDocument || document;
  const element = doc.getElementById(id);
  return isLabelable(element) ? element : null;
}

function firstLabelableDescendant(label: HTMLLabelElement): HTMLElement | null {
  const all = label.querySelectorAll("button, input, select, textarea, output, progress, meter");
  for (const control of all) {
    if (isLabelable(control)) return control;
  }
  return null;
}

export { HTMLLabelElement };
