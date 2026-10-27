// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Stores input dirty-state and runs form-control clone and attribute-change steps.

import { dom, documentImpl as document } from "../../state.js";
import { inputState, type InputControlState } from "../../registries.js";
import { markDamageNode, bumpMutationSeq } from "../../mutations/seq.js";
import { computeStep, sanitizeValue } from "../../input-types.js";
import { markRuntimeCreatedScript, copyScriptStartedFlag } from "../../mutations/observer.js";
import { asciiLowercaseFast } from "../reflect.js";
import { resolveFormOwner } from "./listed.js";
import { isHtmlTag } from "../html-tag.js";
import type { NodeBase } from "../../node-base.js";
import type { Element } from "../element.js";
import type { HTMLInputElement } from "./input.js";
import type * as Idl from "../../idl/types.generated.js";

function runCloneStepsDeep(src: NodeBase | null, clone: NodeBase | null): void {
  if (!src || !clone) return;
  const srcKids = src.childNodes;
  const cloneKids = clone.childNodes;
  if (!srcKids || !cloneKids) return;
  const n = Math.min(srcKids.length, cloneKids.length);
  for (let i = 0; i < n; i++) {
    const s = srcKids[i];
    const c = cloneKids[i];
    if (!s || !c) continue;
    runCloneSteps(s, c);
    runCloneStepsDeep(s, c);
  }
}

function runCloneSteps(src: NodeBase | null, clone: NodeBase | null): void {
  if (!src || !clone) return;
  const tag = src.nodeName || src._info?.nodeName;
  if (tag === "SCRIPT") cloneScriptState(src, clone);
  if (tag === "INPUT") cloneInputState(src, clone);
  else if (tag === "TEXTAREA") cloneTextAreaState(src, clone);
}

function cloneScriptState(src: NodeBase, clone: NodeBase): void {
  try {
    markRuntimeCreatedScript(clone._id);
  } catch {}
  try {
    copyScriptStartedFlag(src, clone);
  } catch {}
}

function cloneInputState(src: NodeBase, clone: NodeBase): void {
  const srcState = inputState.get(src._id);
  if (!srcState) return;
  const cloneState = inputStateOf(clone);
  cloneState.valueDirty = !!srcState.valueDirty;
  cloneState.value = srcState.value || "";
  cloneState.checkedDirty = !!srcState.checkedDirty;
  cloneState.checked = !!srcState.checked;
  cloneState.indeterminate = !!srcState.indeterminate;
  cloneState.userEdited = !!srcState.userEdited;
  if (cloneState.checkedDirty) setClonedCheckboxChecked(clone, cloneState.checked);
}

function setClonedCheckboxChecked(clone: NodeBase, checked: boolean): void {
  try {
    dom.setCheckboxChecked(clone._id, checked);
  } catch {}
}

function cloneTextAreaState(src: NodeBase, clone: NodeBase): void {
  const srcState = inputState.get(src._id);
  if (!srcState) return;
  const cloneState = inputStateOf(clone);
  cloneState.valueDirty = !!srcState.valueDirty;
  cloneState.value = srcState.value || "";
}

function inputStateOf(input: Pick<Element, "_id">): InputControlState {
  const id = input._id;
  let s = inputState.get(id);
  if (!s) {
    s = {
      valueDirty: false,
      value: "",
      userEdited: false,
      checkedDirty: false,
      checked: false,
    };
    inputState.set(id, s);
  }
  return s;
}

const INPUT_TYPES = new Set([
  "hidden",
  "text",
  "search",
  "tel",
  "url",
  "email",
  "password",
  "date",
  "month",
  "week",
  "time",
  "datetime-local",
  "number",
  "range",
  "color",
  "checkbox",
  "radio",
  "file",
  "submit",
  "image",
  "reset",
  "button",
]);
function inputTypeOf(input: Pick<Element, "getAttribute">): string {
  const raw = asciiLowercaseFast(input.getAttribute("type") || "");
  return INPUT_TYPES.has(raw) ? raw : "text";
}
function ksPushInputText(el: Element, str: string): void {
  try {
    const domHandle = dom;
    // This updates the editor buffer without rewriting the value content attribute.
    if (typeof domHandle.setInputText === "function" && domHandle.setInputText(el._id, str)) {
      markDamageNode(el._id);
      bumpMutationSeq();
    }
  } catch {}
}
function ksStepArg(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n | 0;
}
function ksApplyStep(input: HTMLInputElement, n: number): void {
  const t = inputTypeOf(input);
  const step = input.getAttribute("step");
  const min = input.getAttribute("min");
  const max = input.getAttribute("max");
  const stepResult = computeStep(t, input.value, min, max, step, n, input.getAttribute("value"));
  if (stepResult.error) {
    throw new DOMException(
      "stepUp/stepDown: not supported on input[type=" + t + "] with step=" + (step || "default"),
      "InvalidStateError",
    );
  }
  if (stepResult.noop || stepResult.value === undefined) return;
  input.value = stepResult.value;
}
const RESANITIZE_ATTRS = new Set(["type", "multiple", "min", "max", "step", "value"]);
function ksAttrNeedsResanitize(el: Element, attrName: string): boolean {
  return RESANITIZE_ATTRS.has(attrName) && el.localName === "input";
}
function ksResanitizeInputValue(el: Element): void {
  const s = inputState.get(el._id);
  if (s && s.valueDirty && inputValueMode(inputTypeOf(el)) === "value") {
    s.value = ksSanitizeInputValue(el, s.value);
  }
  // The range-input path is string-valued; Element.value also covers meter values.
  if (inputTypeOf(el) === "range") ksPushInputText(el, el.value as string);
}
function ksHandleInputTypeChange(el: Element, oldType: string): void {
  const oldMode = inputValueMode(oldType);
  const newMode = inputValueMode(inputTypeOf(el));
  if (oldMode !== newMode) applyInputModeChange(el, oldMode, newMode);
  ksResanitizeInputValue(el);
}

function applyInputModeChange(el: Element, oldMode: InputValueMode, newMode: InputValueMode): void {
  const state = inputStateOf(el);
  if (isValueToDefaultMode(oldMode, newMode)) return preserveValueAsDefault(el, state);
  if (isDefaultToValueMode(oldMode, newMode)) return adoptDefaultInputValue(el, state);
  if (oldMode === "filename" && newMode !== "filename") clearFilenameInputValue(state);
}

function isValueToDefaultMode(oldMode: InputValueMode, newMode: InputValueMode): boolean {
  return oldMode === "value" && isDefaultInputMode(newMode);
}

function isDefaultToValueMode(oldMode: InputValueMode, newMode: InputValueMode): boolean {
  return isDefaultInputMode(oldMode) && newMode === "value";
}

function isDefaultInputMode(mode: InputValueMode): boolean {
  return mode === "default" || mode === "default/on";
}

function preserveValueAsDefault(el: Element, state: InputControlState): void {
  if (state.valueDirty && state.value !== "") el.setAttribute("value", state.value);
}

function adoptDefaultInputValue(el: Element, state: InputControlState): void {
  state.value = el.getAttribute("value") ?? "";
  state.valueDirty = false;
}

function clearFilenameInputValue(state: InputControlState): void {
  state.value = "";
  state.valueDirty = false;
}
function ksSanitizeInputValue(
  input: Pick<Element, "getAttribute" | "hasAttribute">,
  raw: string,
): string {
  const t = inputTypeOf(input);
  return sanitizeValue(t, raw, {
    multiple: input.hasAttribute("multiple"),
    minAttr: input.getAttribute("min"),
    maxAttr: input.getAttribute("max"),
    stepAttr: input.getAttribute("step"),
  });
}
type InputValueMode = "default/on" | "filename" | "default" | "value";
function inputValueMode(type: string): InputValueMode {
  if (type === "checkbox" || type === "radio") return "default/on";
  if (type === "file") return "filename";
  if (
    type === "hidden" ||
    type === "submit" ||
    type === "reset" ||
    type === "image" ||
    type === "button"
  )
    return "default";
  return "value";
}

function uncheckSiblingRadios(input: Element, name: string): void {
  const myForm = resolveFormOwner(input);
  const result = findSiblingRadioCandidates(input, name);
  if (!result.ok) return;
  for (const candidate of result.candidates) uncheckRadioCandidate(input, myForm, candidate);
  bumpMutationSeq();
}

function findSiblingRadioCandidates(input: Element, name: string) {
  const scope = siblingRadioQueryScope(input);
  try {
    return {
      ok: true as const,
      candidates: scope.querySelectorAll(`input[type=radio][name=${JSON.stringify(name)}]`),
    };
  } catch {
    return { ok: false as const };
  }
}

function siblingRadioQueryScope(input: Element) {
  const doc = input.ownerDocument || document;
  let scope = doc;
  try {
    const root = typeof input.getRootNode === "function" ? input.getRootNode() : null;
    if (hasRadioQuerySelector(root)) scope = root;
  } catch {}
  return scope;
}

function hasRadioQuerySelector(
  root: ReturnType<Element["getRootNode"]> | null,
): root is Pick<Idl.DocumentFragment, "querySelectorAll"> {
  return Boolean(root && typeof root.querySelectorAll === "function");
}

function uncheckRadioCandidate(
  input: Element,
  myForm: ReturnType<typeof resolveFormOwner>,
  candidate: Element,
): void {
  if (candidate === input) return;
  if (!isHtmlTag(candidate, "input")) return;
  if (resolveFormOwner(candidate) !== myForm) return;
  if (!candidate.checked) return;
  const state = inputStateOf(candidate);
  state.checkedDirty = true;
  state.checked = false;
  updateUncheckedRadio(candidate);
}

function updateUncheckedRadio(candidate: Element): void {
  try {
    const domHandle = dom;
    if (typeof domHandle.setCheckboxChecked === "function") {
      domHandle.setCheckboxChecked(candidate._id, false);
      markDamageNode(candidate._id);
    }
  } catch {}
}

export {
  inputStateOf,
  inputTypeOf,
  inputValueMode,
  ksApplyStep,
  ksAttrNeedsResanitize,
  ksHandleInputTypeChange,
  ksPushInputText,
  ksResanitizeInputValue,
  ksSanitizeInputValue,
  ksStepArg,
  runCloneSteps,
  runCloneStepsDeep,
  uncheckSiblingRadios,
};
