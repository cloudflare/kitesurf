// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Finds labelable controls and creates their live associated-label lists.

import { elementDocument, makeNodeList } from "../../state.js";
import type { NodeListCls } from "../../collections.js";
import { inputTypeOf } from "./input-state.js";
import { htmlTagOf, isHtmlTag } from "../html-tag.js";
import type { Element } from "../element.js";
import type { HTMLElement } from "../html-element.js";

// https://html.spec.whatwg.org/#category-label
const LABELABLE_TAGS = new Set(["button", "meter", "output", "progress", "select", "textarea"]);
function isLabelable(el: unknown): el is HTMLElement {
  if (isHtmlTag(el, "input")) return inputTypeOf(el) !== "hidden";
  const tag = htmlTagOf(el);
  return tag !== null && LABELABLE_TAGS.has(tag);
}

const labelsNodeListCache = new WeakMap<Element, NodeListCls>();

function computeLabelsForControl(control: Element): Element[] {
  if (inputTypeOf(control) === "hidden") return [];
  const seen = new Set<Element>();
  const out: Element[] = [];
  let p = control.parentNode;
  while (p) {
    if (isHtmlTag(p, "label")) {
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
    p = p.parentNode;
  }
  if (control.id) {
    const doc = elementDocument(control);
    try {
      const all = doc.querySelectorAll("label[for]");
      for (const l of all) {
        if (l.getAttribute("for") === control.id && !seen.has(l)) {
          seen.add(l);
          out.push(l);
        }
      }
    } catch {}
  }
  return out;
}

function labelsForControl(control: Element): NodeListCls {
  let nl = labelsNodeListCache.get(control);
  if (!nl) {
    nl = makeNodeList(() => computeLabelsForControl(control));
    labelsNodeListCache.set(control, nl);
  }
  return nl;
}

export { isLabelable, labelsForControl };
