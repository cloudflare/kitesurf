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

/**
 * Unsupported or ineligible controls return an error instead of changing.
 * Changed values use the shared trusted input/change dispatch path.
 */
export function setControlValueAsUser(
  control: UserSettableControl,
  value: unknown,
): ControlSetResult {
  const tag = String(control?.localName ?? "").toLowerCase();
  const type = String(control?.type ?? "").toLowerCase();
  const toggle = tag === "input" && (type === "checkbox" || type === "radio");
  const entry = tag === "textarea" || (tag === "input" && !toggle && !NO_USER_VALUE.has(type));
  if (tag !== "select" && !toggle && !entry)
    return { changed: false, error: "not a form control a user can set" };
  if (isDisabledInFormContext(control)) return { changed: false, error: "control is disabled" };
  if (entry && control.readOnly === true) return { changed: false, error: "control is read-only" };
  if (tag === "select") {
    const wanted =
      control.multiple === true && Array.isArray(value)
        ? value.map(String)
        : [value == null ? "" : String(value)];
    const options = Array.from(control.options ?? []);
    const offered = new Set(options.filter(optionEnabled).map((o) => String(o.value ?? "")));
    if (!wanted.every((w) => offered.has(w))) return { changed: false, error: "no such option" };
  }
  return { changed: setControlValue(control, value) };
}
