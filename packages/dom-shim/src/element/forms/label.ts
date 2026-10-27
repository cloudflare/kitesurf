// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements HTMLLabelElement control lookup and label-to-control association.

import type * as Idl from "../../idl/types.generated.js";
import { elementDocument } from "../../state.js";
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
    if (forId) {
      const doc = elementDocument(this);
      const el = doc.getElementById(forId);
      return isLabelable(el) ? el : null;
    }
    const all = this.querySelectorAll("button, input, select, textarea, output, progress, meter");
    for (const c of all) {
      if (isLabelable(c)) return c;
    }
    return null;
  }
  get form() {
    const c = this.control;
    return c ? c.form : null;
  }
}

export { HTMLLabelElement };
