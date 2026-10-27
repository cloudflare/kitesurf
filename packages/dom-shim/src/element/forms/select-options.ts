// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Resolves option lists and selectedness for select controls.

import { dom, isElementNode } from "../../state.js";
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
  if (option.disabled) return true;
  let p = option.parentNode;
  while (p) {
    // Any element named optgroup or select counts, in any namespace.
    if (isElementNode(p) && p.localName === "optgroup" && p.disabled) return true;
    if (isElementNode(p) && p.localName === "select") break;
    p = p.parentNode;
  }
  return false;
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
  let last: HTMLOptionElement | null = null;
  for (const o of opts) if (explicitlySelected(o)) last = o;
  if (last || select.size > 1) return last;
  // Preserve an explicit empty selection until the option list changes.
  const cleared = selectClearedWith.get(select);
  if (cleared) {
    if (cleared.length === opts.length && cleared.every((o, i) => o === opts[i])) return null;
    selectClearedWith.delete(select);
  }
  for (const o of opts) if (!isOptionEffectivelyDisabled(o)) return o;
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
  const opts = selectOptions(select);
  let chosen: HTMLOptionElement | null = null;
  chosen = selectedOptionsOf(select, opts)[0] ?? null;
  if (!chosen && opts.length > 0) chosen = opts[0];
  const text = chosen ? chosen.textContent || "" : null;
  let removedLabelId = -1;
  if (!text) {
    const ids = Array.from<number>(dom.childIds(select._id));
    const lastId = ids.at(-1);
    if (lastId !== undefined) {
      try {
        if (dom.nodeInfo(lastId)?.nodeType === TEXT_NODE) removedLabelId = lastId;
      } catch {}
    }
  }
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
