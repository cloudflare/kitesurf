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
  if (type === "email") {
    if (control.multiple) {
      const parts = value.split(",").map(stripAsciiWhitespace);
      if (parts.some((part) => !isValidEmail(part))) flags.typeMismatch = true;
    } else if (!isValidEmail(stripAsciiWhitespace(value))) {
      flags.typeMismatch = true;
    }
  } else if (type === "url" && !isValidUrl(stripAsciiWhitespace(value))) {
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
  let validPattern = false;
  try {
    new RegExp(pattern, "v");
    validPattern = true;
  } catch {}
  if (!validPattern) return;
  try {
    const re = new RegExp(`^(?:${pattern})$`, "v");
    const mismatch =
      type === "email" && control.multiple
        ? value
            .split(",")
            .map(stripAsciiWhitespace)
            .some((part) => !re.test(part))
        : !re.test(value);
    if (mismatch) flags.patternMismatch = true;
  } catch {}
}

function inputStep(type: string, stepRaw: string | null) {
  if (stepRaw == null || stepRaw === "") {
    if (type === "date") return MS_PER_DAY;
    if (type === "week") return MS_PER_WEEK;
    if (type === "time" || type === "datetime-local") return MS_PER_MINUTE;
    return 1;
  }
  const step = +stepRaw;
  if (!Number.isFinite(step) || step <= 0) return null;
  if (type === "date") return step * MS_PER_DAY;
  if (type === "week") return step * MS_PER_WEEK;
  if (type === "time" || type === "datetime-local") return step * MS_PER_SECOND;
  return step;
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
  if (minN != null && num < minN) flags.rangeUnderflow = true;
  if (maxN != null && num > maxN) flags.rangeOverflow = true;
  if (stepRaw === "any") return;
  const step = inputStep(type, stepRaw);
  if (step == null || step <= 0) return;
  const base = minN != null ? minN : type === "week" ? -3 * MS_PER_DAY : 0;
  const diff = (num - base) / step;
  if (Math.abs(diff - Math.round(diff)) > STEP_ALIGNMENT_EPSILON) flags.stepMismatch = true;
}

function computeValidity(control: Element): ValidityFlags {
  const flags: ValidityFlags = {
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
  const custom = customValidity.get(control._id);
  if (custom) flags.customError = true;

  if (isHtmlTag(control, "input")) {
    const type = inputTypeOf(control);
    const value = control.value;
    const required = control.required;
    if (
      required &&
      type !== "submit" &&
      type !== "reset" &&
      type !== "button" &&
      type !== "image"
    ) {
      if (type === "checkbox" || type === "radio") {
        if (!control.checked) flags.valueMissing = true;
      } else if (!value) {
        flags.valueMissing = true;
      }
    }
    applyTypeMismatch(control, flags, type, value);
    const pattern = control.getAttribute("pattern");
    if (value && pattern) applyPatternMismatch(control, flags, type, value, pattern);
    const userEdited = inputStateOf(control).userEdited;
    if (userEdited) {
      const ml = control.maxLength;
      if (ml >= 0 && value.length > ml) flags.tooLong = true;
      const mn = control.minLength;
      if (mn >= 0 && value && value.length < mn) flags.tooShort = true;
    }
    const numericLike =
      type === "number" ||
      type === "range" ||
      type === "date" ||
      type === "month" ||
      type === "week" ||
      type === "time" ||
      type === "datetime-local";
    if (numericLike && value) applyNumericValidity(control, flags, type, value);
  } else if (isHtmlTag(control, "textarea")) {
    const value = control.value;
    const required = control.required;
    if (required && !value) flags.valueMissing = true;
    const userEdited = inputStateOf(control).userEdited;
    if (userEdited) {
      const ml = control.maxLength;
      if (ml >= 0 && value.length > ml) flags.tooLong = true;
      const mn = control.minLength;
      if (mn >= 0 && value && value.length < mn) flags.tooShort = true;
    }
  } else if (isHtmlTag(control, "select")) {
    const required = control.required;
    if (required) {
      if (control.value === "") flags.valueMissing = true;
    }
  }

  flags.valid = !(
    flags.valueMissing ||
    flags.typeMismatch ||
    flags.patternMismatch ||
    flags.tooLong ||
    flags.tooShort ||
    flags.rangeUnderflow ||
    flags.rangeOverflow ||
    flags.stepMismatch ||
    flags.badInput ||
    flags.customError
  );
  return flags;
}

function willValidate(control: Element): boolean {
  if (isHtmlTag(control, "input")) {
    const type = inputTypeOf(control);
    if (
      type === "hidden" ||
      type === "reset" ||
      type === "submit" ||
      type === "button" ||
      type === "image"
    )
      return false;
    if (control.disabled || control.readOnly) return false;
  } else if (isHtmlTag(control, "textarea")) {
    if (control.disabled || control.readOnly) return false;
  } else if (isHtmlTag(control, "select")) {
    if (control.disabled) return false;
  } else if (isHtmlTag(control, "button")) {
    if (control.disabled) return false;
    if (control.type !== "submit") return false;
  } else if (isHtmlTag(control, "fieldset")) {
    return false;
  } else if (isHtmlTag(control, "output")) {
    return false;
  } else {
    return false;
  }
  let p = control.parentNode;
  while (p) {
    if (isHtmlTag(p, "fieldset") && p.disabled) return false;
    if (p instanceof HTMLDataListElement) return false;
    p = p.parentNode;
  }
  return true;
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
      if (flags.valid) return "";
      const custom = customValidity.get(this._id);
      if (custom && flags.customError) return custom;
      if (flags.valueMissing) return "Please fill out this field.";
      if (flags.typeMismatch) return "Please enter a valid value.";
      if (flags.patternMismatch) return "Please match the requested format.";
      if (flags.tooLong) return "Please shorten this text.";
      if (flags.tooShort) return "Please lengthen this text.";
      if (flags.rangeUnderflow) return "Value is below the minimum.";
      if (flags.rangeOverflow) return "Value is above the maximum.";
      if (flags.stepMismatch) return "Please enter a valid value.";
      if (flags.badInput) return "Please enter a valid value.";
      return "";
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
