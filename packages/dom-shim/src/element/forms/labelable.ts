// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Finds labelable controls and creates their live associated-label lists.

import { documentImpl as document, makeNodeList } from "../../state.js";
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
  addAncestorLabels(control, seen, out);
  addExplicitLabels(control, seen, out);
  return out;
}

function addAncestorLabels(control: Element, seen: Set<Element>, out: Element[]): void {
  let p = control.parentNode;
  while (p) {
    if (isHtmlTag(p, "label") && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
    p = p.parentNode;
  }
}

function addExplicitLabels(control: Element, seen: Set<Element>, out: Element[]): void {
  if (!control.id) return;
  const doc = control.ownerDocument || document;
  try {
    addLabelsForControl(doc.querySelectorAll("label[for]"), control, seen, out);
  } catch {}
}

function addLabelsForControl(
  labels: Iterable<Element>,
  control: Element,
  seen: Set<Element>,
  out: Element[],
): void {
  for (const label of labels) {
    if (isNewLabelForControl(label, control, seen)) addLabel(label, seen, out);
  }
}

function isNewLabelForControl(label: Element, control: Element, seen: Set<Element>): boolean {
  return label.getAttribute("for") === control.id && !seen.has(label);
}

function addLabel(label: Element, seen: Set<Element>, out: Element[]): void {
  seen.add(label);
  out.push(label);
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
