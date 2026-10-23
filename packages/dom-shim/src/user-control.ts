// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Sets a form control's value the way a user would, through the control-value path shared
// with WebMCP.

import { isDisabledInFormContext } from "./element/index.js";
import { setControlValue } from "./model-context.js";

interface ControlOption {
  readonly value?: unknown;
  readonly disabled?: boolean;
  readonly parentNode?: { readonly localName?: unknown; readonly disabled?: boolean } | null;
}

interface UserSettableControl {
  readonly localName?: unknown;
  readonly type?: unknown;
  readonly multiple?: boolean;
  readonly readOnly?: boolean;
  readonly options?: ArrayLike<ControlOption>;
}

const NO_USER_VALUE = new Set(["hidden", "file", "button", "submit", "reset", "image"]);

export interface ControlSetResult {
  changed: boolean;
  error?: string;
}

function optionEnabled(opt: ControlOption): boolean {
  if (opt.disabled === true) return false;
  const group = opt.parentNode;
  return !(group && String(group.localName ?? "") === "optgroup" && group.disabled === true);
}

function isToggleControl(tag: string, type: string): boolean {
  return tag === "input" && (type === "checkbox" || type === "radio");
}

function isEntryControl(tag: string, type: string, toggle: boolean): boolean {
  return tag === "textarea" || (tag === "input" && !toggle && !NO_USER_VALUE.has(type));
}

function isUserSettableControl(tag: string, toggle: boolean, entry: boolean): boolean {
  return tag === "select" || toggle || entry;
}

function hasReadonlyEntry(control: UserSettableControl, entry: boolean): boolean {
  return entry && control.readOnly === true;
}

function isSelectValueOffered(control: UserSettableControl, value: unknown): boolean {
  const wanted =
    control.multiple === true && Array.isArray(value)
      ? value.map(String)
      : [value == null ? "" : String(value)];
  const options = Array.from(control.options ?? []);
  const offered = new Set(
    options.filter(optionEnabled).map((option) => String(option.value ?? "")),
  );
  return wanted.every((item) => offered.has(item));
}

function selectValueError(
  control: UserSettableControl,
  value: unknown,
  tag: string,
): string | null {
  if (tag !== "select") return null;
  return isSelectValueOffered(control, value) ? null : "no such option";
}

function controlError(
  control: UserSettableControl,
  value: unknown,
  tag: string,
  toggle: boolean,
  entry: boolean,
): string | null {
  if (!isUserSettableControl(tag, toggle, entry)) return "not a form control a user can set";
  if (isDisabledInFormContext(control)) return "control is disabled";
  if (hasReadonlyEntry(control, entry)) return "control is read-only";
  const selectionError = selectValueError(control, value, tag);
  if (selectionError) return selectionError;
  return null;
}

function controlTag(control: UserSettableControl): string {
  return String(control?.localName ?? "").toLowerCase();
}

function controlType(control: UserSettableControl): string {
  return String(control?.type ?? "").toLowerCase();
}

/**
 * Unsupported or ineligible controls return an error instead of changing.
 * Changed values use the shared trusted input/change dispatch path.
 */
export function setControlValueAsUser(
  control: UserSettableControl,
  value: unknown,
): ControlSetResult {
  const tag = controlTag(control);
  const type = controlType(control);
  const toggle = isToggleControl(tag, type);
  const entry = isEntryControl(tag, type, toggle);
  const error = controlError(control, value, tag, toggle, entry);
  if (error) return { changed: false, error };
  return { changed: setControlValue(control, value) };
}
