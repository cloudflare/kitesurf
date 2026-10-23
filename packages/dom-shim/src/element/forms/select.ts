// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements select, option, and optgroup interfaces and their collection behavior.

import type * as Idl from "../../idl/types.generated.js";
import {
  makeHtmlCollection,
  HTMLOptionsCollectionCls,
  OPTIONS_OWNER_SYM,
  documentImpl as document,
  ksGlobal,
} from "../../state.js";
import { optionSelected, optionsCache } from "../../registries.js";
import { NodeBase } from "../../node-base.js";
import { defineReflectedUnsignedLong } from "../reflect.js";
import { resolveFormOwner } from "./listed.js";
import {
  selectOptions,
  resyncSelectLabel,
  selectedOptionsOf,
  selectClearedWith,
  ownerSelectOf,
  cachedSingleSelectChoice,
  explicitlySelected,
} from "./select-options.js";
import { installValidityMixin, type ValidityMember } from "./validity.js";
import { labelsForControl } from "./labelable.js";
import { attributeChangeSteps } from "../element.js";
import { HTMLElement } from "../html-element.js";
import type { HTMLOptionsCollectionCls as HTMLOptionsCollection } from "../../collections.js";
import type { HTMLFormElement } from "./form.js";

interface HTMLSelectElement extends Pick<Idl.HTMLSelectElement, ValidityMember> {}
class HTMLSelectElement extends HTMLElement implements Idl.HTMLSelectElement {
  get type() {
    return this.hasAttribute("multiple") ? "select-multiple" : "select-one";
  }
  get multiple() {
    return this.hasAttribute("multiple");
  }
  set multiple(v) {
    if (v) this.setAttribute("multiple", "");
    else this.removeAttribute("multiple");
  }
  get size() {
    const v = this.getAttribute("size");
    if (v == null) return this.multiple ? 4 : 0;
    const n = parseInt(v, 10);
    return Number.isNaN(n) || n < 0 ? 0 : n;
  }
  set size(v) {
    this.setAttribute("size", String(v));
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
  get required() {
    return this.hasAttribute("required");
  }
  set required(v) {
    if (v) this.setAttribute("required", "");
    else this.removeAttribute("required");
  }
  get autocomplete() {
    return this.getAttribute("autocomplete") || "";
  }
  set autocomplete(v) {
    this.setAttribute("autocomplete", String(v));
  }
  get options() {
    const cached = optionsCache.get(this);
    if (cached) return cached;
    const coll = makeHtmlCollection<HTMLOptionsCollection>(
      () => selectOptions(this),
      HTMLOptionsCollectionCls,
      OPTIONS_OWNER_SYM ? { [OPTIONS_OWNER_SYM]: this } : undefined,
    );
    optionsCache.set(this, coll);
    return coll;
  }
  get length() {
    return this.options.length;
  }
  set length(n) {
    resizeSelectOptions(this, n);
  }
  item(index: number) {
    const opts = selectOptions(this);
    const i = Number(index) >>> 0;
    return i < opts.length ? opts[i] : null;
  }
  namedItem(name: string) {
    if (!name) return null;
    const opts = selectOptions(this);
    for (const o of opts) {
      if (o.id === name || o.getAttribute("name") === name) return o;
    }
    return null;
  }
  get selectedIndex() {
    const opts = selectOptions(this);
    const first = selectedOptionsOf(this, opts)[0];
    return first ? opts.indexOf(first) : -1;
  }
  set selectedIndex(n) {
    const idx = Number(n);
    const opts = selectOptions(this);
    for (let i = 0; i < opts.length; i++) {
      opts[i].selected = i === idx;
    }
    if (idx >= 0 && idx < opts.length) selectClearedWith.delete(this);
    else selectClearedWith.set(this, opts);
    resyncSelectLabel(this);
  }
  get selectedOptions() {
    return makeHtmlCollection(() => selectedOptionsOf(this));
  }
  get value() {
    const first = selectedOptionsOf(this)[0];
    return first ? first.value : "";
  }
  set value(v) {
    const str = String(v);
    const opts = selectOptions(this);
    let matched = false;
    for (const o of opts) {
      const match = !matched && o.value === str;
      o.selected = match;
      if (match) matched = true;
    }
    if (matched) selectClearedWith.delete(this);
    else selectClearedWith.set(this, opts);
    resyncSelectLabel(this);
  }
  add(
    item: Idl.HTMLOptionElement | Idl.HTMLOptGroupElement,
    before?: Idl.HTMLElement | number | null,
  ) {
    assertOptionOrOptGroup(item);
    const refNode = selectInsertReference(this, before);
    const select: Idl.HTMLSelectElement = this;
    select.insertBefore(item, refNode);
    resyncSelectLabel(this);
  }
  remove(): void;
  remove(index: number): void;
  remove(index?: number): void {
    if (index === undefined) return removeSelectElement(this);
    removeSelectOptionAt(this, index);
  }
  get form(): HTMLFormElement | null {
    return resolveFormOwner(this);
  }
  get labels() {
    return labelsForControl(this);
  }
}

class HTMLOptionElement extends HTMLElement implements Idl.HTMLOptionElement {
  get value() {
    if (this.hasAttribute("value")) {
      return this.getAttribute("value") || "";
    }
    return this.text;
  }
  set value(v) {
    this.setAttribute("value", String(v));
  }
  get text() {
    const tc = (this.textContent || "").replace(/[\t\n\f\r ]+/g, " ").trim();
    return tc;
  }
  set text(v) {
    this.textContent = String(v);
  }
  get label() {
    if (this.hasAttribute("label")) {
      return this.getAttribute("label") || "";
    }
    return this.text;
  }
  set label(v) {
    this.setAttribute("label", String(v));
  }
  get defaultSelected() {
    return this.hasAttribute("selected");
  }
  set defaultSelected(v) {
    if (v) this.setAttribute("selected", "");
    else this.removeAttribute("selected");
  }
  get selected() {
    const select = ownerSelectOf(this);
    if (select && !select.multiple) {
      const choice = cachedSingleSelectChoice(select);
      return choice !== null && choice._id === this._id;
    }
    return explicitlySelected(this);
  }
  set selected(v) {
    setOptionSelectedness(this, v);
  }
  __ksSetSelectednessUndirty(bool: unknown): void {
    optionSelected.set(this._id, {
      selected: !!bool,
      dirty: false,
    });
  }
  get disabled() {
    if (this.hasAttribute("disabled")) return true;
    const p = this.parentNode;
    if (p && p instanceof HTMLOptGroupElement && p.disabled) return true;
    return false;
  }
  set disabled(v) {
    if (v) this.setAttribute("disabled", "");
    else this.removeAttribute("disabled");
  }
  get index() {
    let p = this.parentNode;
    while (p && !(p instanceof HTMLSelectElement)) {
      p = p.parentNode;
    }
    if (!p) return 0;
    const opts = selectOptions(p);
    const i = opts.indexOf(this);
    return i >= 0 ? i : 0;
  }
  get form(): HTMLFormElement | null {
    return resolveFormOwner(this);
  }
  [attributeChangeSteps](localName: string, value: string | null): void {
    super[attributeChangeSteps](localName, value);
    if (localName !== "selected") return;
    // An option's selected attribute updates its selected state until script changes it.
    // https://html.spec.whatwg.org/#concept-option-dirtiness
    synchronizeSelectedAttribute(this, value);
  }
}

function resizeSelectOptions(select: HTMLSelectElement, length: number): void {
  const target = Math.max(0, Math.min(100_000, Math.floor(Number(length) || 0)));
  const options = selectOptions(select);
  removeOptionsBeyondTarget(options, target);
  appendOptionsUntilTarget(select, options, target);
  resyncSelectLabel(select);
}

function removeOptionsBeyondTarget(options: HTMLOptionElement[], target: number): void {
  for (let i = options.length - 1; i >= target; i--) {
    const option = options[i];
    if (option && option.parentNode) option.parentNode.removeChild(option);
  }
}

function appendOptionsUntilTarget(
  select: HTMLSelectElement,
  options: HTMLOptionElement[],
  target: number,
): void {
  if (options.length < target) {
    const doc = select.ownerDocument || document;
    for (let i = options.length; i < target; i++) {
      select.appendChild(doc.createElement("option"));
    }
  }
}

function assertOptionOrOptGroup(item: Idl.HTMLOptionElement | Idl.HTMLOptGroupElement): void {
  if (!(item instanceof HTMLOptionElement) && !(item instanceof HTMLOptGroupElement)) {
    throw new (ksGlobal.DOMException || Error)(
      "HTMLSelectElement.add: argument must be Option or OptGroup",
      "TypeError",
    );
  }
}

function selectInsertReference(
  select: HTMLSelectElement,
  before: Idl.HTMLElement | number | null | undefined,
): NodeBase | null {
  if (before == null) return null;
  if (typeof before === "number") return optionReferenceAt(select, before);
  return nodeInsertReference(before);
}

function optionReferenceAt(select: HTMLSelectElement, index: number): NodeBase | null {
  const options = selectOptions(select);
  return index >= 0 && index < options.length ? options[index] : null;
}

function nodeInsertReference(before: Idl.HTMLElement): NodeBase {
  if (before instanceof NodeBase) return before;
  throw new TypeError("insertBefore: second argument is not a Node");
}

function removeSelectElement(select: HTMLSelectElement): void {
  if (select.parentNode) select.parentNode.removeChild(select);
}

function removeSelectOptionAt(select: HTMLSelectElement, index: number): void {
  const options = selectOptions(select);
  const optionIndex = Number(index) | 0;
  if (optionIndex < 0 || optionIndex >= options.length) return;
  const option = options[optionIndex];
  if (option.parentNode) option.parentNode.removeChild(option);
  resyncSelectLabel(select);
}

function setOptionSelectedness(option: HTMLOptionElement, value: unknown): void {
  const selected = !!value;
  const owner = ownerSelectOf(option);
  if (owner) selectClearedWith.delete(owner);
  optionSelected.set(option._id, { selected, dirty: true });
  const select = optionSelectAncestor(option);
  if (select) synchronizeOptionSiblings(option, select, selected);
}

function optionSelectAncestor(option: HTMLOptionElement): HTMLSelectElement | null {
  let parent = option.parentNode;
  while (parent && !(parent instanceof HTMLSelectElement)) parent = parent.parentNode;
  return parent;
}

function synchronizeOptionSiblings(
  option: HTMLOptionElement,
  select: HTMLSelectElement,
  selected: boolean,
): void {
  if (selected && !select.multiple) unselectOptionSiblings(option, select);
  resyncSelectLabel(select);
}

function unselectOptionSiblings(option: HTMLOptionElement, select: HTMLSelectElement): void {
  for (const sibling of selectOptions(select)) {
    if (sibling !== option) {
      optionSelected.set(sibling._id, { selected: false, dirty: true });
    }
  }
}

function synchronizeSelectedAttribute(option: HTMLOptionElement, value: string | null): void {
  const state = optionSelected.get(option._id);
  if (state && state.dirty) return;
  optionSelected.set(option._id, { selected: value !== null, dirty: false });
  if (value === null) return;
  clearOtherSelectedOptions(option);
}

function clearOtherSelectedOptions(option: HTMLOptionElement): void {
  const owner = ownerSelectOf(option);
  if (!owner || owner.multiple) return;
  clearSelectedSiblings(option, owner);
}

function clearSelectedSiblings(option: HTMLOptionElement, owner: HTMLSelectElement): void {
  for (const sibling of selectOptions(owner)) {
    if (sibling === option) continue;
    const dirty = optionSelected.get(sibling._id)?.dirty ?? false;
    optionSelected.set(sibling._id, { selected: false, dirty });
  }
}

class HTMLOptGroupElement extends HTMLElement implements Idl.HTMLOptGroupElement {
  get label() {
    return this.getAttribute("label") || "";
  }
  set label(v) {
    this.setAttribute("label", String(v));
  }
  get disabled() {
    return this.hasAttribute("disabled");
  }
  set disabled(v) {
    if (v) this.setAttribute("disabled", "");
    else this.removeAttribute("disabled");
  }
}
installValidityMixin(HTMLSelectElement);

defineReflectedUnsignedLong(HTMLSelectElement.prototype, "size", "size", 0);

export { HTMLOptGroupElement, HTMLOptionElement, HTMLSelectElement };
