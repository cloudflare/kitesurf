// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements HTMLInputElement values, checkedness, type-specific state, files, and selection.

import type * as Idl from "../../idl/types.generated.js";
import { dom, documentImpl as document } from "../../state.js";
import { inputState } from "../../registries.js";
import { markDamageNode, bumpMutationSeq } from "../../mutations/seq.js";
import {
  fileInputFiles,
  setInputFiles,
  fileInputLists,
  fileListFor,
  getInputFiles,
  isKsFileList,
  setInputFileList,
} from "../../file-input.js";
import {
  isSteppable,
  parseByType,
  serializeByType,
  acceptsValueAsDate,
  valueAsDateFromString,
  valueAsDateToString,
} from "../../input-types.js";
import {
  defineReflectedBoolean,
  defineReflectedEnumWithDefaults,
  defineReflectedString,
  defineReflectedUrl,
  defineReflectedUnsignedLong,
  defineReflectedNonNegativeLong,
  defineReflectedLimitedPositiveUnsignedLong,
} from "../reflect.js";
import {
  ksApplyStep,
  ksStepArg,
  inputTypeOf,
  inputStateOf,
  inputValueMode,
  ksSanitizeInputValue,
  ksPushInputText,
  uncheckSiblingRadios,
} from "./input-state.js";
import { activateFormButton, resolveFormOwner } from "./listed.js";
import {
  supportsSelection,
  ksCollapseSelectionToEnd,
  installSelectionMixin,
  type SelectionMember,
} from "./selection.js";
import { installValidityMixin, type ValidityMember } from "./validity.js";
import { labelsForControl } from "./labelable.js";
import { activationBehavior, attributeChangeSteps } from "../element.js";
import { HTMLElement } from "../html-element.js";
import { HTMLDataListElement } from "../html-classes.js";
import type { HTMLFormElement } from "./form.js";

interface HTMLInputElement extends Pick<
  Idl.HTMLInputElement,
  | ValidityMember
  | SelectionMember
  | "alpha"
  | "colorSpace"
  | "dirName"
  | "useMap"
  | "accept"
  | "alt"
  | "height"
  | "width"
  | "formAction"
  | "formEnctype"
  | "formMethod"
  | "formNoValidate"
  | "formTarget"
  | "popoverTargetElement"
  | "popoverTargetAction"
  | "align"
> {}

class HTMLInputElement extends HTMLElement implements Idl.HTMLInputElement {
  stepUp(n?: number): void {
    ksApplyStep(this, ksStepArg(arguments.length ? n : 1));
  }
  stepDown(n?: number): void {
    ksApplyStep(this, -ksStepArg(arguments.length ? n : 1));
  }
  showPicker() {
    const t = inputTypeOf(this);
    const applicable = new Set([
      "date",
      "month",
      "week",
      "time",
      "datetime-local",
      "color",
      "file",
    ]);
    if (!applicable.has(t)) {
      throw new DOMException(
        "showPicker: not supported on input[type=" + t + "]",
        "InvalidStateError",
      );
    }
  }
  get type() {
    return inputTypeOf(this);
  }
  set type(v) {
    this.setAttribute("type", String(v));
  }
  get value() {
    return inputValue(this);
  }
  set value(v) {
    setInputValue(this, v);
  }
  get defaultValue() {
    const s = inputState.get(this._id);
    if (s && s.defaultValueAttr !== undefined) return s.defaultValueAttr;
    return this.getAttribute("value") || "";
  }
  set defaultValue(v) {
    const str = String(v);
    this.setAttribute("value", str);
    inputStateOf(this).defaultValueAttr = str;
  }
  ksMarkUserEdited(): void {
    inputStateOf(this).userEdited = true;
  }
  get checked() {
    const s = inputStateOf(this);
    if (s.checkedDirty) return s.checked;
    return this.hasAttribute("checked");
  }
  set checked(v) {
    setInputChecked(this, v);
  }
  get defaultChecked() {
    return this.hasAttribute("checked");
  }
  set defaultChecked(v) {
    if (v) this.setAttribute("checked", "");
    else this.removeAttribute("checked");
  }
  get indeterminate() {
    const s = inputStateOf(this);
    return !!s.indeterminate;
  }
  set indeterminate(v) {
    const s = inputStateOf(this);
    s.indeterminate = !!v;
  }
  get name() {
    return this.getAttribute("name") || "";
  }
  set name(v) {
    this.setAttribute("name", String(v));
  }
  get placeholder() {
    return this.getAttribute("placeholder") || "";
  }
  set placeholder(v) {
    this.setAttribute("placeholder", String(v));
  }
  get autocomplete() {
    return this.getAttribute("autocomplete") || "";
  }
  set autocomplete(v) {
    this.setAttribute("autocomplete", String(v));
  }
  get pattern() {
    return this.getAttribute("pattern") || "";
  }
  set pattern(v) {
    this.setAttribute("pattern", String(v));
  }
  get min() {
    return this.getAttribute("min") || "";
  }
  set min(v) {
    this.setAttribute("min", String(v));
  }
  get max() {
    return this.getAttribute("max") || "";
  }
  set max(v) {
    this.setAttribute("max", String(v));
  }
  get step() {
    return this.getAttribute("step") || "";
  }
  set step(v) {
    this.setAttribute("step", String(v));
  }
  get required() {
    return this.hasAttribute("required");
  }
  set required(v) {
    if (v) this.setAttribute("required", "");
    else this.removeAttribute("required");
  }
  get disabled() {
    return this.hasAttribute("disabled");
  }
  set disabled(v) {
    if (v) this.setAttribute("disabled", "");
    else this.removeAttribute("disabled");
  }
  get readOnly() {
    return this.hasAttribute("readonly");
  }
  set readOnly(v) {
    if (v) this.setAttribute("readonly", "");
    else this.removeAttribute("readonly");
  }
  get autofocus() {
    return this.hasAttribute("autofocus");
  }
  set autofocus(v) {
    if (v) this.setAttribute("autofocus", "");
    else this.removeAttribute("autofocus");
  }
  get multiple() {
    return this.hasAttribute("multiple");
  }
  set multiple(v) {
    if (v) this.setAttribute("multiple", "");
    else this.removeAttribute("multiple");
  }
  get maxLength() {
    const v = this.getAttribute("maxlength");
    if (v == null) return -1;
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? -1 : n;
  }
  set maxLength(v) {
    this.setAttribute("maxlength", String(v));
  }
  get minLength() {
    const v = this.getAttribute("minlength");
    if (v == null) return -1;
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? -1 : n;
  }
  set minLength(v) {
    this.setAttribute("minlength", String(v));
  }
  get size() {
    const v = this.getAttribute("size");
    if (v == null) return 20;
    const n = parseInt(v, 10);
    return Number.isNaN(n) || n <= 0 ? 20 : n;
  }
  set size(v) {
    this.setAttribute("size", String(v));
  }
  get valueAsNumber() {
    const t = inputTypeOf(this);
    if (!isSteppable(t)) return NaN;
    const parsed = parseByType(t, this.value);
    return parsed == null ? NaN : parsed;
  }
  set valueAsNumber(v) {
    setInputValueAsNumber(this, v);
  }
  get valueAsDate() {
    const t = inputTypeOf(this);
    if (!acceptsValueAsDate(t)) return null;
    return valueAsDateFromString(t, this.value);
  }
  set valueAsDate(v) {
    const t = inputTypeOf(this);
    if (!acceptsValueAsDate(t)) {
      throw new DOMException(
        "valueAsDate: not supported on input[type=" + t + "]",
        "InvalidStateError",
      );
    }
    if (v !== null && !(v instanceof Date)) {
      throw new TypeError("valueAsDate: expected Date or null");
    }
    const s = valueAsDateToString(t, v);
    this.value = s == null ? "" : s;
  }
  get form(): HTMLFormElement | null {
    return resolveFormOwner(this);
  }
  get list() {
    const ref = this.getAttribute("list");
    if (!ref) return null;
    const doc = this.ownerDocument || document;
    const el = doc.getElementById(ref);
    return el instanceof HTMLDataListElement ? el : null;
  }
  get labels() {
    if (inputTypeOf(this) === "hidden") return null;
    return labelsForControl(this);
  }
  get files() {
    if (inputTypeOf(this) !== "file") return null;
    const assigned = fileInputLists.get(this._id);
    if (assigned) return assigned;
    return fileListFor(getInputFiles(this._id));
  }
  set files(v: unknown) {
    if (inputTypeOf(this) !== "file") return;
    if (v === null || v === undefined) return;
    if (!isKsFileList(v)) {
      throw new TypeError("files: value is not a FileList");
    }
    setInputFileList(this._id, v);
    bumpMutationSeq();
  }
  select() {
    /* no-op stub */
  }
  setSelectionRange(_start: number, _end: number, _dir?: string) {
    /* no-op stub */
  }
  [attributeChangeSteps](localName: string, value: string | null): void {
    super[attributeChangeSteps](localName, value);
    if (localName !== "checked") return;
    // If script has not changed the checked state, the checked attribute sets it.
    // https://html.spec.whatwg.org/#attr-input-checked
    synchronizeCheckedAttribute(this, value);
  }
  [activationBehavior](): void {
    const type = inputTypeOf(this);
    if (type === "submit" || type === "image") activateFormButton(this, "submit");
    else if (type === "reset") activateFormButton(this, "reset");
  }
}

function inputValue(input: HTMLInputElement): string {
  const state = inputStateOf(input);
  const type = inputTypeOf(input);
  const mode = inputValueMode(type);
  const attr = input.getAttribute("value");
  switch (mode) {
    case "value":
      return inputValueModeValue(input, state, attr);
    case "default":
      return reflectedInputValue(attr, "");
    case "default/on":
      return reflectedInputValue(attr, "on");
    case "filename":
      return inputFileValue(input._id);
  }
  return "";
}

function inputValueModeValue(
  input: HTMLInputElement,
  state: ReturnType<typeof inputStateOf>,
  attr: string | null,
): string {
  if (state.valueDirty) return state.value;
  return ksSanitizeInputValue(input, reflectedInputValue(attr, ""));
}

function reflectedInputValue(attr: string | null, fallback: string): string {
  return attr == null ? fallback : attr;
}

function inputFileValue(id: number): string {
  const files = fileInputFiles.get(id);
  if (files && files.length > 0) return "C:\\fakepath\\" + (files[0].name || "");
  return "";
}

function setInputValue(input: HTMLInputElement, value: unknown): void {
  const state = inputStateOf(input);
  const type = inputTypeOf(input);
  const mode = inputValueMode(type);
  const stringValue = value === null ? "" : String(value);
  switch (mode) {
    case "filename":
      setFileInputValue(input, state, stringValue);
      return;
    case "default":
    case "default/on":
      input.setAttribute("value", stringValue);
      return;
    case "value":
      setTextInputValue(input, state, stringValue);
  }
}

function setFileInputValue(
  input: HTMLInputElement,
  state: ReturnType<typeof inputStateOf>,
  value: string,
): void {
  if (value !== "") {
    throw new DOMException(
      "HTMLInputElement.value: setting non-empty value on file input not allowed",
      "InvalidStateError",
    );
  }
  setInputFiles(input._id, []);
  state.valueDirty = true;
  state.value = "";
}

function setTextInputValue(
  input: HTMLInputElement,
  state: ReturnType<typeof inputStateOf>,
  value: string,
): void {
  if (state.defaultValueAttr === undefined) {
    state.defaultValueAttr = input.getAttribute("value") ?? "";
  }
  const beforeValue = input.value;
  state.valueDirty = true;
  state.value = ksSanitizeInputValue(input, value);
  ksPushInputText(input, state.value);
  if (supportsSelection(input) && state.value !== beforeValue) {
    ksCollapseSelectionToEnd(input);
  }
}

function setInputChecked(input: HTMLInputElement, value: unknown): void {
  const state = inputStateOf(input);
  const checked = !!value;
  if (state.checkedDirty && state.checked === checked) return;
  state.checkedDirty = true;
  state.checked = checked;
  writeInputChecked(input, checked);
  markDamageNode(input._id);
  bumpMutationSeq();
  if (checked) uncheckRadioSiblingsIfNeeded(input);
}

function writeInputChecked(input: HTMLInputElement, checked: boolean): void {
  try {
    const domHandle = dom;
    if (typeof domHandle.setCheckboxChecked === "function") {
      domHandle.setCheckboxChecked(input._id, checked);
    }
  } catch {}
}

function uncheckRadioSiblingsIfNeeded(input: HTMLInputElement): void {
  if (inputTypeOf(input) !== "radio") return;
  const name = input.getAttribute("name");
  if (name) uncheckSiblingRadios(input, name);
}

function setInputValueAsNumber(input: HTMLInputElement, value: unknown): void {
  const number = Number(value);
  if (number === Infinity || number === -Infinity) {
    throw new TypeError("valueAsNumber: value is infinite");
  }
  const type = inputTypeOf(input);
  if (!isSteppable(type)) {
    throw new DOMException(
      "valueAsNumber: not supported on input[type=" + type + "]",
      "InvalidStateError",
    );
  }
  if (Number.isNaN(number)) {
    input.value = "";
    return;
  }
  const serialized = serializeByType(type, number);
  input.value = parsedNumberString(type, serialized);
}

function parsedNumberString(type: string, value: string): string {
  return parseByType(type, value) == null ? "" : value;
}

function synchronizeCheckedAttribute(input: HTMLInputElement, value: string | null): void {
  const type = inputTypeOf(input);
  if (!isCheckboxOrRadio(type)) return;
  const state = inputState.get(input._id);
  const checked = checkedAttributeValue(state, value);
  writeCheckedAttribute(input, checked);
  if (shouldUncheckAttributeRadio(checked, state, type)) uncheckAttributeRadioSiblings(input);
}

function isCheckboxOrRadio(type: string): boolean {
  return type === "checkbox" || type === "radio";
}

function checkedAttributeValue(
  state: ReturnType<typeof inputState.get>,
  value: string | null,
): boolean {
  return state?.checkedDirty ? !!state.checked : value !== null;
}

function writeCheckedAttribute(input: HTMLInputElement, checked: boolean): void {
  try {
    dom.setCheckboxChecked?.(input._id, checked);
  } catch {}
}

function shouldUncheckAttributeRadio(
  checked: boolean,
  state: ReturnType<typeof inputState.get>,
  type: string,
): boolean {
  return checked && !state?.checkedDirty && type === "radio";
}

function uncheckAttributeRadioSiblings(input: HTMLInputElement): void {
  const name = input.getAttribute("name");
  if (name) uncheckSiblingRadios(input, name);
}

installValidityMixin(HTMLInputElement);
installSelectionMixin(HTMLInputElement);

defineReflectedBoolean(HTMLInputElement.prototype, "alpha", "alpha");
defineReflectedEnumWithDefaults(
  HTMLInputElement.prototype,
  "colorSpace",
  "colorspace",
  ["limited-srgb", "display-p3"],
  "limited-srgb",
  "limited-srgb",
);

defineReflectedString(HTMLInputElement.prototype, "dirName", "dirname");
defineReflectedString(HTMLInputElement.prototype, "useMap", "usemap");
defineReflectedString(HTMLInputElement.prototype, "accept", "accept");
defineReflectedString(HTMLInputElement.prototype, "alt", "alt");
defineReflectedUrl(HTMLInputElement.prototype, "src", "src");
defineReflectedUnsignedLong(HTMLInputElement.prototype, "height", "height", 0);
defineReflectedUnsignedLong(HTMLInputElement.prototype, "width", "width", 0);
defineReflectedNonNegativeLong(HTMLInputElement.prototype, "minLength", "minlength", -1);
defineReflectedNonNegativeLong(HTMLInputElement.prototype, "maxLength", "maxlength", -1);
defineReflectedLimitedPositiveUnsignedLong(HTMLInputElement.prototype, "size", "size", 20);

export { HTMLInputElement };
