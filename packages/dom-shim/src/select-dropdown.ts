// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Manages the shim's single open select popup and its selection events.

import { KsEvent, KsInputEvent } from "./events/event.js";
import { ksGlobal } from "./state.js";
import { isOptionEffectivelyDisabled, selectOptions } from "./element/forms/select-options.js";
import type { Element } from "./element/element.js";
import { HTMLSelectElement } from "./element/forms/select.js";
import type * as Idl from "./idl/types.generated.js";

type SelectDocument = NonNullable<HTMLSelectElement["ownerDocument"]>;

// At most one dropdown is open at a time.
let openState: {
  select: HTMLSelectElement;
  overlay: Element;
  outsideListener: (ev: Event) => void;
} | null = null;

function closeDropdown(): void {
  if (!openState) return;
  const { overlay, outsideListener } = openState;
  openState = null;
  try {
    const doc = overlay.ownerDocument;
    doc.removeEventListener("click", outsideListener, true);
  } catch {}
  try {
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
  } catch {}
}

function openDropdown(select: HTMLSelectElement): void {
  closeDropdown();
  const doc = select.ownerDocument;
  if (!doc || !doc.body) return;

  const rect = dropdownRect(select);
  if (!rect) return;
  const win = ksGlobal;
  const pageX = (win.scrollX | 0) + rect.left;
  const pageY = (win.scrollY | 0) + rect.bottom;

  const overlay = createDropdownOverlay(doc, pageX, pageY, rect);
  const options = selectOptions(select);
  renderDropdownOptions(doc, overlay, select, options);
  const outsideListener = outsideDropdownListener(overlay, select);
  doc.body.appendChild(overlay);
  try {
    doc.addEventListener("click", outsideListener, true);
  } catch {}
  openState = { select, overlay, outsideListener };
}

function dropdownRect(
  select: HTMLSelectElement,
): ReturnType<HTMLSelectElement["getBoundingClientRect"]> | null {
  try {
    return select.getBoundingClientRect();
  } catch {
    return null;
  }
}

function createDropdownOverlay(
  doc: SelectDocument,
  pageX: number,
  pageY: number,
  rect: ReturnType<HTMLSelectElement["getBoundingClientRect"]>,
): Element {
  const overlay = doc.createElement("div");
  overlay.setAttribute("data-kitesurf-ua", "select-dropdown");
  overlay.setAttribute(
    "style",
    "position:absolute;" +
      `left:${pageX}px;top:${pageY}px;` +
      `min-width:${Math.max(0, rect.width)}px;` +
      "background:#fff;border:1px solid #999;" +
      "box-shadow:0 2px 8px rgba(0,0,0,0.25);" +
      "z-index:2147483647;max-height:300px;overflow-y:auto;" +
      "font:13px system-ui,sans-serif;color:#000;",
  );
  return overlay;
}

function renderDropdownOptions(
  doc: SelectDocument,
  overlay: Element,
  select: HTMLSelectElement,
  options: ReturnType<typeof selectOptions>,
): void {
  const count = options.length | 0;
  for (let i = 0; i < count; i++) {
    const opt = options[i];
    const { row, disabled } = createDropdownOptionRow(doc, opt);
    if (!disabled) installDropdownOptionListener(row, select, i);
    overlay.appendChild(row);
  }
}

function createDropdownOptionRow(
  doc: SelectDocument,
  option: ReturnType<typeof selectOptions>[number],
): { row: Element; disabled: boolean } {
  const row = doc.createElement("div");
  row.setAttribute("data-kitesurf-ua", "select-option");
  const selected = !!option.selected;
  const disabled = isOptionEffectivelyDisabled(option);
  row.setAttribute("style", dropdownOptionStyle(selected, disabled));
  row.textContent = option.text || "\u00a0";
  return { row, disabled };
}

function dropdownOptionStyle(selected: boolean, disabled: boolean): string {
  return (
    "padding:3px 8px;white-space:nowrap;cursor:default;" +
    (selected ? "background:#1e6fd9;color:#fff;" : "") +
    (disabled ? "color:#999;" : "")
  );
}

function installDropdownOptionListener(
  row: Element,
  select: HTMLSelectElement,
  index: number,
): void {
  row.addEventListener("click", (ev: Idl.Event) => handleDropdownOptionClick(ev, select, index));
}

function handleDropdownOptionClick(ev: Idl.Event, select: HTMLSelectElement, index: number): void {
  try {
    ev.stopPropagation();
  } catch {}
  if (select.selectedIndex !== index) selectDropdownOption(select, index);
  closeDropdown();
}

function selectDropdownOption(select: HTMLSelectElement, index: number): void {
  select.selectedIndex = index;
  try {
    select.dispatchEvent(new KsInputEvent("input", { bubbles: true, cancelable: false }));
  } catch {}
  try {
    select.dispatchEvent(new KsEvent("change", { bubbles: true, cancelable: false }));
  } catch {}
}

// Click-away closes in capture phase so row stopPropagation cannot starve it; the row also closes.
function outsideDropdownListener(overlay: Element, select: HTMLSelectElement): (ev: Event) => void {
  return (ev: Event) => {
    let n: unknown = ev && ev.target;
    while (n) {
      if (n === overlay || n === select) return;
      n = (n as { parentNode?: unknown }).parentNode;
    }
    closeDropdown();
  };
}

// PageScript calls this as a <select>'s click default action. Returns true
// when it handled the click.
export function toggleSelectDropdown(select: unknown): boolean {
  if (!(select instanceof HTMLSelectElement)) return false;
  if (select.disabled) return false;
  if (select.hasAttribute("multiple")) return false;
  const sizeAttr = parseInt(select.getAttribute("size") || "0", 10);
  if (sizeAttr > 1) return false;
  if (openState && openState.select === select) {
    closeDropdown();
  } else {
    openDropdown(select);
  }
  return true;
}

export function closeSelectDropdown(): void {
  closeDropdown();
}

ksGlobal.__ksSelectDropdownToggle = toggleSelectDropdown;
ksGlobal.__ksSelectDropdownClose = closeDropdown;
