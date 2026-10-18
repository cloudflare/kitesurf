// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Tests a node for an HTML element interface by its tag, for the modules that cannot import the
// interface's class: element.ts and the helpers the interface modules import sit below them
// (MODULES.md "Initialization dependencies"). The tag comes from the same key resolveElementClass
// picks the wrapper's class by, so the test and the class agree.

import { elemNs, fragmentIds } from "../registries.js";
import { ELEMENT_NODE, HTML_NS } from "../constants.js";
import { NodeBase } from "../node-base.js";
import type { Element } from "./element.js";
import type { HTMLObjectElement } from "./embedded.js";
import type { HTMLButtonElement } from "./forms/button.js";
import type { HTMLFieldSetElement, HTMLLegendElement } from "./forms/fieldset.js";
import type { HTMLFormElement } from "./forms/form.js";
import type { HTMLInputElement } from "./forms/input.js";
import type { HTMLLabelElement } from "./forms/label.js";
import type { HTMLMeterElement, HTMLProgressElement } from "./forms/meter.js";
import type { HTMLOutputElement } from "./forms/output.js";
import type { HTMLOptGroupElement, HTMLOptionElement, HTMLSelectElement } from "./forms/select.js";
import type { HTMLTextAreaElement } from "./forms/textarea.js";

interface HtmlTagMap {
  button: HTMLButtonElement;
  fieldset: HTMLFieldSetElement;
  form: HTMLFormElement;
  input: HTMLInputElement;
  label: HTMLLabelElement;
  legend: HTMLLegendElement;
  meter: HTMLMeterElement;
  object: HTMLObjectElement;
  optgroup: HTMLOptGroupElement;
  option: HTMLOptionElement;
  output: HTMLOutputElement;
  progress: HTMLProgressElement;
  select: HTMLSelectElement;
  textarea: HTMLTextAreaElement;
}

// The tag resolveElementClass looks an interface up by, or null outside the HTML namespace.
// A null namespace counts as HTML there, so it does here.
function htmlInterfaceTag(
  localName: unknown,
  namespaceURI: string | null | undefined,
): string | null {
  if (namespaceURI && namespaceURI !== HTML_NS) return null;
  return String(localName || "").toLowerCase();
}

// A wrapper nodeFor built from an element node, in any namespace. That includes the
// DocumentFragment stand-ins, which extend Element too.
function isNodeBase(node: unknown): node is NodeBase {
  return (
    node !== null &&
    (typeof node === "object" || typeof node === "function") &&
    NodeBase.prototype.isPrototypeOf(node)
  );
}

function isElementWrapper(node: unknown): node is Element {
  if (!isNodeBase(node)) return false;
  const info = node._info;
  return !!info && info.nodeType === ELEMENT_NODE;
}

// The interface tag of a shim element wrapper, from the inputs nodeFor gives resolveElementClass.
// Null for anything else: parsed-document elements are not NodeBase wrappers, and a
// DocumentFragment stand-in is an element only in wasm.
function htmlTagOf(node: unknown): string | null {
  if (!isElementWrapper(node)) return null;
  const { _id, _info } = node;
  if (fragmentIds.has(_id)) return null;
  const entry = elemNs.get(_id);
  return htmlInterfaceTag(_info.localName, entry ? entry.ns : HTML_NS);
}

function isHtmlTag<K extends keyof HtmlTagMap>(node: unknown, tag: K): node is HtmlTagMap[K] {
  return htmlTagOf(node) === tag;
}

export { htmlInterfaceTag, htmlTagOf, isElementWrapper, isHtmlTag };
