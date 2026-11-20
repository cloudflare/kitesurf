// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements select, option, and optgroup interfaces and their collection behavior.

import type * as Idl from "../../idl/types.generated.js";
import {
  makeHtmlCollection,
  HTMLOptionsCollectionCls,
  OPTIONS_OWNER_SYM,
  elementDocument,
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
    const target = Math.max(0, Math.min(100_000, Math.floor(Number(n) || 0)));
    const opts = selectOptions(this);
    for (let i = opts.length - 1; i >= target; i--) {
      const o = opts[i];
      if (o && o.parentNode) o.parentNode.removeChild(o);
    }
    if (opts.length < target) {
      const doc = elementDocument(this);
      for (let i = opts.length; i < target; i++) {
        this.appendChild(doc.createElement("option"));
      }
    }
    resyncSelectLabel(this);
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
    if (!(item instanceof HTMLOptionElement) && !(item instanceof HTMLOptGroupElement)) {
      throw new (ksGlobal.DOMException || Error)(
        "HTMLSelectElement.add: argument must be Option or OptGroup",
        "TypeError",
      );
    }
    let refNode: NodeBase | null = null;
    if (before == null) {
      refNode = null;
    } else if (typeof before === "number") {
      const opts = selectOptions(this);
      refNode = before >= 0 && before < opts.length ? opts[before] : null;
    } else if (before instanceof NodeBase) {
      refNode = before;
    } else {
      throw new TypeError("insertBefore: second argument is not a Node");
    }
    this.insertBefore(item, refNode);
    resyncSelectLabel(this);
  }
  remove(): void;
  remove(index: number): void;
  remove(index?: number): void {
    if (index === undefined) {
      if (this.parentNode) this.parentNode.removeChild(this);
      return;
    }
    const opts = selectOptions(this);
    const i = Number(index) | 0;
    if (i >= 0 && i < opts.length) {
      const o = opts[i];
      if (o.parentNode) o.parentNode.removeChild(o);
      resyncSelectLabel(this);
    }
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
    const bool = !!v;
    const owner = ownerSelectOf(this);
    if (owner) selectClearedWith.delete(owner);
    optionSelected.set(this._id, { selected: bool, dirty: true });
    let p = this.parentNode;
    while (p && !(p instanceof HTMLSelectElement)) {
      p = p.parentNode;
    }
    if (p) {
      if (bool && !p.multiple) {
        const siblings = selectOptions(p);
        for (const o of siblings) {
          if (o !== this) {
            optionSelected.set(o._id, { selected: false, dirty: true });
          }
        }
      }
      resyncSelectLabel(p);
    }
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
    const state = optionSelected.get(this._id);
    if (state && state.dirty) return;
    optionSelected.set(this._id, { selected: value !== null, dirty: false });
    if (value === null) return;
    // A select without multiple clears the other options.
    // https://html.spec.whatwg.org/#the-select-element
    const owner = ownerSelectOf(this);
    if (owner && !owner.multiple) {
      for (const o of selectOptions(owner)) {
        if (o === this) continue;
        const dirty = optionSelected.get(o._id)?.dirty ?? false;
        optionSelected.set(o._id, { selected: false, dirty });
      }
    }
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
