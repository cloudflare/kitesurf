// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Manages the shim's single open select popup and its selection events.

import { KsEvent, KsInputEvent } from "./events/event.js";
import { elementDocument, ksGlobal } from "./state.js";
import type * as Idl from "./idl/types.generated.js";
import { isOptionEffectivelyDisabled, selectOptions } from "./element/forms/select-options.js";
import type { Element } from "./element/element.js";
import { HTMLSelectElement } from "./element/forms/select.js";
import { ksInternals } from "./internals.js";

// At most one dropdown is open at a time.
let openState: {
  select: HTMLSelectElement;
  overlay: Element;
  outsideListener: (ev: Idl.Event) => void;
} | null = null;

function closeDropdown(): void {
  if (!openState) return;
  const { overlay, outsideListener } = openState;
  openState = null;
  try {
    const doc = elementDocument(overlay);
    doc.removeEventListener("click", outsideListener, true);
  } catch {}
  try {
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
  } catch {}
}

function openDropdown(select: HTMLSelectElement): void {
  closeDropdown();
  const doc = elementDocument(select);
  if (!doc.body) return;

  let rect: ReturnType<HTMLSelectElement["getBoundingClientRect"]> | null = null;
  try {
    rect = select.getBoundingClientRect();
  } catch {}
  if (!rect) return;
  const win = ksGlobal;
  const pageX = (win.scrollX | 0) + rect.left;
  const pageY = (win.scrollY | 0) + rect.bottom;

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

  const options = selectOptions(select);
  const count = options.length | 0;
  for (let i = 0; i < count; i++) {
    const opt = options[i];
    const row = doc.createElement("div");
    row.setAttribute("data-kitesurf-ua", "select-option");
    const selected = !!opt.selected;
    const disabled = isOptionEffectivelyDisabled(opt);
    row.setAttribute(
      "style",
      "padding:3px 8px;white-space:nowrap;cursor:default;" +
        (selected ? "background:#1e6fd9;color:#fff;" : "") +
        (disabled ? "color:#999;" : ""),
    );
    row.textContent = opt.text || "\u00a0";
    if (!disabled) {
      const index = i;
      row.addEventListener("click", (ev: Idl.Event) => {
        try {
          ev.stopPropagation();
        } catch {}
        const changed = select.selectedIndex !== index;
        if (changed) {
          select.selectedIndex = index;
          try {
            select.dispatchEvent(new KsInputEvent("input", { bubbles: true, cancelable: false }));
          } catch {}
          try {
            select.dispatchEvent(new KsEvent("change", { bubbles: true, cancelable: false }));
          } catch {}
        }
        closeDropdown();
      });
    }
    overlay.appendChild(row);
  }

  // Click-away closes. Capture phase so a row's stopPropagation
  // doesn't starve it; the row handler closes anyway.
  const outsideListener = (ev: Idl.Event) => {
    let n: unknown = ev && ev.target;
    while (n) {
      if (n === overlay || n === select) return;
      n = (n as { parentNode?: unknown }).parentNode;
    }
    closeDropdown();
  };
  doc.body.appendChild(overlay);
  try {
    doc.addEventListener("click", outsideListener, true);
  } catch {}
  openState = { select, overlay, outsideListener };
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

ksInternals.toggleSelectDropdown = toggleSelectDropdown;
