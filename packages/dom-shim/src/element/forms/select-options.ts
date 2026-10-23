// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Resolves option lists and selectedness for select controls.

import { dom } from "../../state.js";
import { TEXT_NODE } from "../../constants.js";
import { SelectednessWeakMap, optionSelected, selectednessWrites } from "../../registries.js";
import { getInternalState } from "../../internal-state.js";
import { bumpMutationSeq } from "../../mutations/seq.js";
import { dropUnwrappedSubtrees } from "../../node-base.js";
import { isHtmlTag } from "../html-tag.js";
import type { Element } from "../element.js";
import type { HTMLOptionElement, HTMLSelectElement } from "./select.js";

function isOptionEffectivelyDisabled(option: HTMLOptionElement | null | undefined): boolean {
  if (!option) return true;
  return option.disabled || hasDisabledOptionAncestor(option);
}

function hasDisabledOptionAncestor(option: HTMLOptionElement): boolean {
  let p = option.parentNode;
  while (p) {
    if (isDisabledOptgroup(p)) return true;
    if (p.localName === "select") break;
    p = p.parentNode;
  }
  return false;
}

function isDisabledOptgroup(node: Element): boolean {
  return node.localName === "optgroup" && node.disabled;
}
function selectOptions(select: Element): HTMLOptionElement[] {
  const out: HTMLOptionElement[] = [];
  const walk = (node: Element) => {
    const kids = node.children;
    if (!kids) return;
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i];
      if (isHtmlTag(child, "option")) {
        out.push(child);
      } else if (isHtmlTag(child, "optgroup")) {
        walk(child);
      }
    }
  };
  walk(select);
  return out;
}
const selectClearedWith = new SelectednessWeakMap<object, readonly object[]>();
function explicitlySelected(option: HTMLOptionElement): boolean {
  const state = optionSelected.get(option._id);
  return state ? state.selected : option.hasAttribute("selected");
}
function ownerSelectOf(option: Element): HTMLSelectElement | null {
  let p = option.parentNode;
  if (isHtmlTag(p, "optgroup")) p = p.parentNode;
  return isHtmlTag(p, "select") ? p : null;
}
function singleSelectChoice(
  select: HTMLSelectElement,
  opts: HTMLOptionElement[] = selectOptions(select),
): HTMLOptionElement | null {
  const last = lastExplicitlySelected(opts);
  if (last || select.size > 1) return last;
  // Preserve an explicit empty selection until the option list changes.
  if (hasPreservedEmptySelection(select, opts)) return null;
  return firstEnabledOption(opts);
}

function lastExplicitlySelected(opts: HTMLOptionElement[]): HTMLOptionElement | null {
  let last: HTMLOptionElement | null = null;
  for (const option of opts) if (explicitlySelected(option)) last = option;
  return last;
}

function hasPreservedEmptySelection(select: HTMLSelectElement, opts: HTMLOptionElement[]): boolean {
  const cleared = selectClearedWith.get(select);
  if (!cleared) return false;
  if (cleared.length === opts.length && cleared.every((option, index) => option === opts[index])) {
    return true;
  }
  selectClearedWith.delete(select);
  return false;
}

function firstEnabledOption(opts: HTMLOptionElement[]): HTMLOptionElement | null {
  for (const option of opts) {
    if (!isOptionEffectivelyDisabled(option)) return option;
  }
  return null;
}
// Selectedness writes do not advance mutationSeq, so cache invalidation also tracks them.
const singleChoiceCache = new WeakMap<
  object,
  { seq: number; writes: number; choice: { _id?: number } | null }
>();
function cachedSingleSelectChoice(select: HTMLSelectElement): { _id?: number } | null {
  const seq = getInternalState().mutationSeq | 0;
  const hit = singleChoiceCache.get(select);
  if (hit && hit.seq === seq && hit.writes === selectednessWrites) return hit.choice;
  const choice = singleSelectChoice(select);
  singleChoiceCache.set(select, { seq, writes: selectednessWrites, choice });
  return choice;
}
function selectedOptionsOf(
  select: HTMLSelectElement,
  opts: HTMLOptionElement[] = selectOptions(select),
): HTMLOptionElement[] {
  if (select.multiple) return opts.filter(explicitlySelected);
  const chosen = singleSelectChoice(select, opts);
  return chosen ? [chosen] : [];
}

function resyncSelectLabel(select: Element | null): void {
  if (!isHtmlTag(select, "select")) return;
  if (typeof dom.setSelectLabel !== "function") return;
  const opts = selectOptions(select);
  const text = selectLabelText(select, opts);
  const removedLabelId = removedSelectLabelTextId(select, text);
  setSelectLabel(select, text, removedLabelId);
}

function selectLabelText(select: HTMLSelectElement, opts: HTMLOptionElement[]): string | null {
  const selected = selectedOptionsOf(select, opts)[0] ?? null;
  const chosen = fallbackLabelOption(selected, opts);
  return textOfLabelOption(chosen);
}

function fallbackLabelOption(
  selected: HTMLOptionElement | null,
  opts: HTMLOptionElement[],
): HTMLOptionElement | null {
  if (!selected && opts.length > 0) return opts[0];
  return selected;
}

function textOfLabelOption(option: HTMLOptionElement | null): string | null {
  return option ? option.textContent || "" : null;
}

function removedSelectLabelTextId(select: HTMLSelectElement, text: string | null): number {
  if (text || typeof dom.childIds !== "function") return -1;
  const lastId = lastChildNodeId(select);
  if (lastId === undefined) return -1;
  return isTextNodeId(lastId) ? lastId : -1;
}

function lastChildNodeId(select: HTMLSelectElement): number | undefined {
  const ids = Array.from<number>(dom.childIds(select._id));
  return ids.at(-1);
}

function isTextNodeId(id: number): boolean {
  try {
    return dom.nodeInfo(id)?.nodeType === TEXT_NODE;
  } catch {}
  return false;
}

function setSelectLabel(
  select: HTMLSelectElement,
  text: string | null,
  removedLabelId: number,
): void {
  try {
    dom.setSelectLabel(select._id, text);
    if (removedLabelId >= 0) dropUnwrappedSubtrees([removedLabelId]);
    bumpMutationSeq();
  } catch {}
}

export {
  cachedSingleSelectChoice,
  explicitlySelected,
  isOptionEffectivelyDisabled,
  ownerSelectOf,
  resyncSelectLabel,
  selectClearedWith,
  selectOptions,
  selectedOptionsOf,
};
