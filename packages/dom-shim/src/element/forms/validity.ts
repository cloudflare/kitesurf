// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Computes constraint validity and installs the shared validity API on form controls.

import type * as Idl from "../../idl/types.generated.js";
import {
  MS_PER_DAY,
  MS_PER_MINUTE,
  MS_PER_SECOND,
  MS_PER_WEEK,
  STEP_ALIGNMENT_EPSILON,
} from "../../constants.js";
import { customValidity } from "../../registries.js";
import { parseByType } from "../../input-types.js";
import { KsEvent } from "../../events/event.js";
import { inputTypeOf, inputStateOf } from "./input-state.js";
import type { HTMLInputElement } from "./input.js";
import type { HTMLTextAreaElement } from "./textarea.js";
import type { HTMLSelectElement } from "./select.js";
import { isHtmlTag } from "../html-tag.js";
import { HTMLDataListElement } from "../html-classes.js";
import type { Element } from "../element.js";
import { defineAttribute } from "../reflect.js";

const EMAIL_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

type ValidityFlags = Record<
  | "valueMissing"
  | "typeMismatch"
  | "patternMismatch"
  | "tooLong"
  | "tooShort"
  | "rangeUnderflow"
  | "rangeOverflow"
  | "stepMismatch"
  | "badInput"
  | "customError"
  | "valid",
  boolean
>;

function isValidEmail(s: string): boolean {
  if (!s) return false;
  return EMAIL_RE.test(s);
}

function isValidUrl(s: string): boolean {
  if (!s) return false;
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

function stripAsciiWhitespace(value: string) {
  return value.replace(/\r\n|\r|\n/g, "").replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
}

function applyTypeMismatch(
  control: HTMLInputElement,
  flags: ValidityFlags,
  type: string,
  value: string,
) {
  if (!value) return;
  if (type === "email") return applyEmailTypeMismatch(control, flags, value);
  if (type === "url" && !isValidUrl(stripAsciiWhitespace(value))) flags.typeMismatch = true;
}

function applyEmailTypeMismatch(
  control: HTMLInputElement,
  flags: ValidityFlags,
  value: string,
): void {
  if (control.multiple) {
    const parts = value.split(",").map(stripAsciiWhitespace);
    if (parts.some((part) => !isValidEmail(part))) flags.typeMismatch = true;
  } else if (!isValidEmail(stripAsciiWhitespace(value))) {
    flags.typeMismatch = true;
  }
}

function applyPatternMismatch(
  control: HTMLInputElement,
  flags: ValidityFlags,
  type: string,
  value: string,
  pattern: string,
) {
  if (!isValidPattern(pattern)) return;
  try {
    const re = new RegExp(`^(?:${pattern})$`, "v");
    if (patternMismatches(control, type, value, re)) flags.patternMismatch = true;
  } catch {}
}

function isValidPattern(pattern: string): boolean {
  try {
    new RegExp(pattern, "v");
    return true;
  } catch {
    return false;
  }
}

function patternMismatches(
  control: HTMLInputElement,
  type: string,
  value: string,
  pattern: RegExp,
): boolean {
  if (type === "email" && control.multiple) {
    return value
      .split(",")
      .map(stripAsciiWhitespace)
      .some((part) => !pattern.test(part));
  }
  return !pattern.test(value);
}

function inputStep(type: string, stepRaw: string | null) {
  if (stepRaw == null || stepRaw === "") return defaultInputStep(type);
  const step = +stepRaw;
  if (!Number.isFinite(step) || step <= 0) return null;
  return scaledInputStep(type, step);
}

function defaultInputStep(type: string): number {
  switch (type) {
    case "date":
      return MS_PER_DAY;
    case "week":
      return MS_PER_WEEK;
    case "time":
    case "datetime-local":
      return MS_PER_MINUTE;
    default:
      return 1;
  }
}

function scaledInputStep(type: string, step: number): number {
  switch (type) {
    case "date":
      return step * MS_PER_DAY;
    case "week":
      return step * MS_PER_WEEK;
    case "time":
    case "datetime-local":
      return step * MS_PER_SECOND;
    default:
      return step;
  }
}

function applyNumericValidity(control: Element, flags: ValidityFlags, type: string, value: string) {
  const num = parseByType(type, value);
  if (num == null) {
    flags.badInput = true;
    return;
  }
  const minRaw = control.getAttribute("min");
  const maxRaw = control.getAttribute("max");
  const stepRaw = control.getAttribute("step");
  const minN = minRaw != null ? parseByType(type, minRaw) : null;
  const maxN = maxRaw != null ? parseByType(type, maxRaw) : null;
  applyNumericRangeValidity(flags, num, minN, maxN);
  if (stepRaw === "any") return;
  applyNumericStepValidity(flags, type, num, minN, stepRaw);
}

function applyNumericRangeValidity(
  flags: ValidityFlags,
  value: number,
  min: number | null,
  max: number | null,
): void {
  if (min != null && value < min) flags.rangeUnderflow = true;
  if (max != null && value > max) flags.rangeOverflow = true;
}

function applyNumericStepValidity(
  flags: ValidityFlags,
  type: string,
  value: number,
  min: number | null,
  stepRaw: string | null,
): void {
  const step = inputStep(type, stepRaw);
  if (step == null || step <= 0) return;
  const base = inputStepBase(type, min);
  const diff = (value - base) / step;
  if (Math.abs(diff - Math.round(diff)) > STEP_ALIGNMENT_EPSILON) flags.stepMismatch = true;
}

function inputStepBase(type: string, min: number | null): number {
  return min != null ? min : type === "week" ? -3 * MS_PER_DAY : 0;
}

function computeValidity(control: Element): ValidityFlags {
  const flags = emptyValidityFlags();
  const custom = customValidity.get(control._id);
  if (custom) flags.customError = true;
  computeControlValidity(control, flags);
  flags.valid = noValidityErrors(flags);
  return flags;
}

function emptyValidityFlags(): ValidityFlags {
  return {
    valueMissing: false,
    typeMismatch: false,
    patternMismatch: false,
    tooLong: false,
    tooShort: false,
    rangeUnderflow: false,
    rangeOverflow: false,
    stepMismatch: false,
    badInput: false,
    customError: false,
    valid: true,
  };
}

function noValidityErrors(flags: ValidityFlags): boolean {
  return !hasPrimaryValidityError(flags) && !hasNumericValidityError(flags);
}

function hasPrimaryValidityError(flags: ValidityFlags): boolean {
  return (
    flags.valueMissing ||
    flags.typeMismatch ||
    flags.patternMismatch ||
    flags.tooLong ||
    flags.tooShort
  );
}

function hasNumericValidityError(flags: ValidityFlags): boolean {
  return (
    flags.rangeUnderflow ||
    flags.rangeOverflow ||
    flags.stepMismatch ||
    flags.badInput ||
    flags.customError
  );
}

function computeControlValidity(control: Element, flags: ValidityFlags): void {
  if (isHtmlTag(control, "input")) return computeInputValidity(control, flags);
  if (isHtmlTag(control, "textarea")) return computeTextareaValidity(control, flags);
  if (isHtmlTag(control, "select")) computeSelectValidity(control, flags);
}

function computeInputValidity(control: HTMLInputElement, flags: ValidityFlags): void {
  const type = inputTypeOf(control);
  const value = control.value;
  const required = control.required;
  applyInputRequiredValidity(control, flags, type, value, required);
  applyTypeMismatch(control, flags, type, value);
  const pattern = control.getAttribute("pattern");
  if (value && pattern) applyPatternMismatch(control, flags, type, value, pattern);
  applyEditedInputLengthValidity(control, flags, value);
  applyNumericInputValidity(control, flags, type, value);
}

function applyInputRequiredValidity(
  control: HTMLInputElement,
  flags: ValidityFlags,
  type: string,
  value: string,
  required: boolean,
): void {
  if (!inputTypeSupportsRequired(type, required)) return;
  if (isCheckableInputType(type)) {
    if (!control.checked) flags.valueMissing = true;
    return;
  }
  if (!value) flags.valueMissing = true;
}

function inputTypeSupportsRequired(type: string, required: boolean): boolean {
  return required && type !== "submit" && type !== "reset" && type !== "button" && type !== "image";
}

function isCheckableInputType(type: string): boolean {
  return type === "checkbox" || type === "radio";
}

type LengthConstrainedControl = Element & Pick<Idl.HTMLInputElement, "maxLength" | "minLength">;

function applyEditedInputLengthValidity(
  control: LengthConstrainedControl,
  flags: ValidityFlags,
  value: string,
): void {
  if (!inputStateOf(control).userEdited) return;
  const maxLength = control.maxLength;
  if (isTooLong(maxLength, value)) flags.tooLong = true;
  const minLength = control.minLength;
  if (isTooShort(minLength, value)) flags.tooShort = true;
}

function isTooLong(maxLength: number, value: string): boolean {
  return maxLength >= 0 && value.length > maxLength;
}

function isTooShort(minLength: number, value: string): boolean {
  return minLength >= 0 && !!value && value.length < minLength;
}

function applyNumericInputValidity(
  control: HTMLInputElement,
  flags: ValidityFlags,
  type: string,
  value: string,
): void {
  if (isNumericInputType(type) && value) applyNumericValidity(control, flags, type, value);
}

function isNumericInputType(type: string): boolean {
  switch (type) {
    case "number":
    case "range":
    case "date":
    case "month":
    case "week":
    case "time":
    case "datetime-local":
      return true;
    default:
      return false;
  }
}

function computeTextareaValidity(control: HTMLTextAreaElement, flags: ValidityFlags): void {
  const value = control.value;
  if (control.required && !value) flags.valueMissing = true;
  applyEditedInputLengthValidity(control, flags, value);
}

function computeSelectValidity(control: HTMLSelectElement, flags: ValidityFlags): void {
  const required = control.required;
  if (required && control.value === "") flags.valueMissing = true;
}

function willValidate(control: Element): boolean {
  if (!controlTypeCanValidate(control)) return false;
  return !hasDisabledValidationAncestor(control);
}

function controlTypeCanValidate(control: Element): boolean {
  if (isHtmlTag(control, "input")) return inputCanValidate(control);
  return nonInputControlCanValidate(control);
}

function inputCanValidate(control: HTMLInputElement): boolean {
  if (!inputTypeCanValidate(inputTypeOf(control))) return false;
  return !control.disabled && !control.readOnly;
}

function inputTypeCanValidate(type: string): boolean {
  switch (type) {
    case "hidden":
    case "reset":
    case "submit":
    case "button":
    case "image":
      return false;
    default:
      return true;
  }
}

function nonInputControlCanValidate(control: Element): boolean {
  if (isHtmlTag(control, "textarea")) return !control.disabled && !control.readOnly;
  if (isHtmlTag(control, "select")) return !control.disabled;
  return buttonOrUnsupportedControlCanValidate(control);
}

function buttonOrUnsupportedControlCanValidate(control: Element): boolean {
  if (isHtmlTag(control, "button")) return !control.disabled && control.type === "submit";
  if (isHtmlTag(control, "fieldset")) return false;
  if (isHtmlTag(control, "output")) return false;
  return false;
}

function hasDisabledValidationAncestor(control: Element): boolean {
  let p = control.parentNode;
  while (p) {
    if (isInvalidValidationAncestor(p)) return true;
    p = p.parentNode;
  }
  return false;
}

function isInvalidValidationAncestor(parent: Element): boolean {
  return (
    (isHtmlTag(parent, "fieldset") && parent.disabled) || parent instanceof HTMLDataListElement
  );
}

const ValidityStateToken = Symbol("kitesurfValidityState");
class ValidityStateImpl implements Idl.ValidityState {
  readonly #control: Element;
  constructor(control: Element, token?: symbol) {
    if (token !== ValidityStateToken) throw new TypeError("Illegal constructor");
    this.#control = control;
  }
  get valueMissing() {
    return computeValidity(this.#control).valueMissing;
  }
  get typeMismatch() {
    return computeValidity(this.#control).typeMismatch;
  }
  get patternMismatch() {
    return computeValidity(this.#control).patternMismatch;
  }
  get tooLong() {
    return computeValidity(this.#control).tooLong;
  }
  get tooShort() {
    return computeValidity(this.#control).tooShort;
  }
  get rangeUnderflow() {
    return computeValidity(this.#control).rangeUnderflow;
  }
  get rangeOverflow() {
    return computeValidity(this.#control).rangeOverflow;
  }
  get stepMismatch() {
    return computeValidity(this.#control).stepMismatch;
  }
  get badInput() {
    return computeValidity(this.#control).badInput;
  }
  get customError() {
    return computeValidity(this.#control).customError;
  }
  get valid() {
    return computeValidity(this.#control).valid;
  }
}
const validityStates = new WeakMap<object, ValidityStateImpl>();
function makeValidityState(control: Element): ValidityStateImpl {
  let state = validityStates.get(control);
  if (!state) {
    state = new ValidityStateImpl(control, ValidityStateToken);
    validityStates.set(control, state);
  }
  return state;
}

type ValidityMember =
  | "validity"
  | "validationMessage"
  | "willValidate"
  | "setCustomValidity"
  | "checkValidity"
  | "reportValidity";
// Every control the mixin goes on declares these members.
type ValidityHost = Element & Pick<Idl.HTMLInputElement, ValidityMember>;
function installValidityMixin(Cls: { prototype: ValidityHost }): void {
  defineAttribute(Cls.prototype, "validity", {
    get() {
      return makeValidityState(this);
    },
  });
  defineAttribute(Cls.prototype, "validationMessage", {
    get() {
      if (!willValidate(this)) return "";
      const flags = computeValidity(this);
      return validityMessage(this, flags);
    },
  });
  defineAttribute(Cls.prototype, "willValidate", {
    get() {
      return willValidate(this);
    },
  });
  Cls.prototype.setCustomValidity = function (msg: unknown) {
    const s = String(msg == null ? "" : msg)
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");
    customValidity.set(this._id, s);
  };
  Cls.prototype.checkValidity = function () {
    if (!willValidate(this)) return true;
    const valid = computeValidity(this).valid;
    if (!valid) {
      const ev = new KsEvent("invalid", { bubbles: false, cancelable: true });
      this.dispatchEvent(ev);
    }
    return valid;
  };
  Cls.prototype.reportValidity = function () {
    return this.checkValidity();
  };
}

function validityMessage(control: Element, flags: ValidityFlags): string {
  if (flags.valid) return "";
  const custom = customValidity.get(control._id);
  if (custom && flags.customError) return custom;
  return primaryValidityMessage(flags);
}

function primaryValidityMessage(flags: ValidityFlags): string {
  if (flags.valueMissing) return "Please fill out this field.";
  if (flags.typeMismatch) return "Please enter a valid value.";
  if (flags.patternMismatch) return "Please match the requested format.";
  return lengthValidityMessage(flags);
}

function lengthValidityMessage(flags: ValidityFlags): string {
  if (flags.tooLong) return "Please shorten this text.";
  if (flags.tooShort) return "Please lengthen this text.";
  return rangeValidityMessage(flags);
}

function rangeValidityMessage(flags: ValidityFlags): string {
  if (flags.rangeUnderflow) return "Value is below the minimum.";
  if (flags.rangeOverflow) return "Value is above the maximum.";
  if (flags.stepMismatch) return "Please enter a valid value.";
  if (flags.badInput) return "Please enter a valid value.";
  return "";
}

export {
  type ValidityMember,
  ValidityStateImpl,
  computeValidity,
  installValidityMixin,
  isValidEmail,
  isValidUrl,
  makeValidityState,
  willValidate,
};
