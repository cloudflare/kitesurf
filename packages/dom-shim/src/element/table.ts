// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements table-related HTML element classes and their row, cell, and caption helpers.

import type * as Idl from "../idl/types.generated.js";
import type { Element } from "./element.js";
import { makeHtmlCollection, documentImpl as document } from "../state.js";
import { HTML_NS } from "../constants.js";
import {
  defineReflectedStringNullEmpty,
  defineReflectedString,
  defineReflectedEnum,
  defineClampedLong,
  defineReflectedBoolean,
} from "./reflect.js";
import { HTMLElement, checkInternalConstruct } from "./html-element.js";
import { HTMLTableCaptionElement, HTMLTableColElement } from "./html-classes.js";

// The reflections below the classes install these. align is installed by
// tag-attributes.ts.
interface HTMLTableElement extends Pick<
  Idl.HTMLTableElement,
  | "align"
  | "bgColor"
  | "border"
  | "cellPadding"
  | "cellSpacing"
  | "frame"
  | "rules"
  | "summary"
  | "width"
> {}
interface HTMLTableSectionElement extends Pick<
  Idl.HTMLTableSectionElement,
  "align" | "ch" | "chOff" | "vAlign"
> {}
interface HTMLTableRowElement extends Pick<
  Idl.HTMLTableRowElement,
  "align" | "bgColor" | "ch" | "chOff" | "vAlign"
> {}
interface HTMLTableCellElement extends Pick<
  Idl.HTMLTableCellElement,
  | "abbr"
  | "align"
  | "axis"
  | "bgColor"
  | "ch"
  | "chOff"
  | "colSpan"
  | "headers"
  | "height"
  | "noWrap"
  | "rowSpan"
  | "scope"
  | "vAlign"
  | "width"
> {}

// A row the table's own query matched sits inside the table, so it has a
// parent; reading through null threw this TypeError before.
function rowParent(row: Element) {
  const parent = row.parentNode;
  if (!parent) throw new TypeError("table row has no parent");
  return parent;
}
function rangeError(method: string, index: number): DOMException {
  return new DOMException(method + ": index " + index + " out of range", "IndexSizeError");
}

class HTMLTableElement extends HTMLElement implements Idl.HTMLTableElement {
  constructor(nodeId: number, info: unknown, token?: symbol) {
    super(nodeId, info);
    checkInternalConstruct(token, "HTMLTableElement");
  }
  get rows(): Idl.HTMLCollection {
    return makeHtmlCollection(() => Array.from<Element>(this.querySelectorAll("tr")));
  }
  insertRow(index?: number): HTMLTableRowElement {
    const idx = index === undefined || index === -1 ? -1 : index | 0;
    const doc = this.ownerDocument || document;
    const tr: HTMLTableRowElement = doc.createElement("tr");
    // A table with no rows puts the first row in a tbody, creating one if needed.
    // https://html.spec.whatwg.org/#dom-table-insertrow
    const rows = this.querySelectorAll("tr");
    if (rows.length === 0) {
      const tbody = this.querySelector("tbody") ?? this.appendChild(doc.createElement("tbody"));
      tbody.appendChild(tr);
    } else if (idx === -1 || idx === rows.length) {
      rowParent(rows[rows.length - 1]).appendChild(tr);
    } else {
      if (idx < 0 || idx > rows.length) throw rangeError("insertRow", idx);
      rowParent(rows[idx]).insertBefore(tr, rows[idx]);
    }
    return tr;
  }
  deleteRow(index: number): void {
    const rows = this.querySelectorAll("tr");
    const i = index === -1 ? rows.length - 1 : index | 0;
    if (i < 0 || i >= rows.length) throw rangeError("deleteRow", i);
    rowParent(rows[i]).removeChild(rows[i]);
  }
}

class HTMLTableSectionElement extends HTMLElement implements Idl.HTMLTableSectionElement {
  constructor(nodeId: number, info: unknown, token?: symbol) {
    super(nodeId, info);
    checkInternalConstruct(token, "HTMLTableSectionElement");
  }
  get rows(): Idl.HTMLCollection {
    return makeHtmlCollection(() => Array.from<Element>(this.querySelectorAll(":scope > tr")));
  }
  insertRow(index?: number): HTMLTableRowElement {
    const idx = index === undefined || index === -1 ? -1 : index | 0;
    const tr: HTMLTableRowElement = (this.ownerDocument || document).createElement("tr");
    const rows = this.querySelectorAll(":scope > tr");
    if (idx === -1 || idx === rows.length) {
      this.appendChild(tr);
    } else {
      if (idx < 0 || idx > rows.length) throw rangeError("insertRow", idx);
      this.insertBefore(tr, rows[idx]);
    }
    return tr;
  }
  deleteRow(index: number): void {
    const rows = this.querySelectorAll(":scope > tr");
    const i = index === -1 ? rows.length - 1 : index | 0;
    if (i < 0 || i >= rows.length) throw rangeError("deleteRow", i);
    this.removeChild(rows[i]);
  }
}

class HTMLTableRowElement extends HTMLElement implements Idl.HTMLTableRowElement {
  constructor(nodeId: number, info: unknown, token?: symbol) {
    super(nodeId, info);
    checkInternalConstruct(token, "HTMLTableRowElement");
  }
  get cells(): Idl.HTMLCollection {
    return makeHtmlCollection(() =>
      Array.from<Element>(this.querySelectorAll(":scope > td, :scope > th")),
    );
  }
  insertCell(index?: number): HTMLTableCellElement {
    const idx = index === undefined || index === -1 ? -1 : index | 0;
    const td: HTMLTableCellElement = (this.ownerDocument || document).createElement("td");
    const cells = this.querySelectorAll(":scope > td, :scope > th");
    if (idx === -1 || idx === cells.length) {
      this.appendChild(td);
    } else {
      if (idx < 0 || idx > cells.length) throw rangeError("insertCell", idx);
      this.insertBefore(td, cells[idx]);
    }
    return td;
  }
  deleteCell(index: number): void {
    const cells = this.querySelectorAll(":scope > td, :scope > th");
    const i = index === -1 ? cells.length - 1 : index | 0;
    if (i < 0 || i >= cells.length) throw rangeError("deleteCell", i);
    this.removeChild(cells[i]);
  }
}

class HTMLTableCellElement extends HTMLElement implements Idl.HTMLTableCellElement {
  constructor(nodeId: number, info: unknown, token?: symbol) {
    super(nodeId, info);
    checkInternalConstruct(token, "HTMLTableCellElement");
  }
  get cellIndex(): number {
    // Only cells directly owned by an HTML tr have a cell index.
    // https://html.spec.whatwg.org/#dom-tdth-cellindex
    const parent = this.parentElement;
    if (!parent) return -1;
    if (parent.tagName !== "TR") return -1;
    if (parent.namespaceURI !== HTML_NS) return -1;
    const kids = parent.children;
    let idx = 0;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (c === this) return idx;
      const t = c.tagName;
      if (t === "TD" || t === "TH") idx++;
    }
    return -1;
  }
}

const MAX_COL_SPAN = 1000;
const MAX_ROW_SPAN = 65534;

defineReflectedStringNullEmpty(HTMLTableElement.prototype, "bgColor", "bgcolor");
defineReflectedString(HTMLTableElement.prototype, "border", "border");
defineReflectedStringNullEmpty(HTMLTableElement.prototype, "cellPadding", "cellpadding");
defineReflectedStringNullEmpty(HTMLTableElement.prototype, "cellSpacing", "cellspacing");
defineReflectedString(HTMLTableElement.prototype, "frame", "frame");
defineReflectedString(HTMLTableElement.prototype, "rules", "rules");
defineReflectedString(HTMLTableElement.prototype, "summary", "summary");
defineReflectedString(HTMLTableElement.prototype, "width", "width");
defineReflectedString(HTMLTableSectionElement.prototype, "ch", "char");
defineReflectedString(HTMLTableSectionElement.prototype, "chOff", "charoff");
defineReflectedString(HTMLTableSectionElement.prototype, "vAlign", "valign");
defineReflectedStringNullEmpty(HTMLTableRowElement.prototype, "bgColor", "bgcolor");
defineReflectedString(HTMLTableRowElement.prototype, "ch", "char");
defineReflectedString(HTMLTableRowElement.prototype, "chOff", "charoff");
defineReflectedString(HTMLTableRowElement.prototype, "vAlign", "valign");
defineReflectedString(HTMLTableCellElement.prototype, "abbr", "abbr");
defineReflectedString(HTMLTableCellElement.prototype, "axis", "axis");
defineReflectedStringNullEmpty(HTMLTableCellElement.prototype, "bgColor", "bgcolor");
defineReflectedString(HTMLTableCellElement.prototype, "ch", "char");
defineReflectedString(HTMLTableCellElement.prototype, "chOff", "charoff");
defineReflectedString(HTMLTableCellElement.prototype, "headers", "headers");
defineReflectedString(HTMLTableCellElement.prototype, "height", "height");
defineReflectedEnum(HTMLTableCellElement.prototype, "scope", "scope", [
  "row",
  "col",
  "rowgroup",
  "colgroup",
]);
defineReflectedString(HTMLTableCellElement.prototype, "vAlign", "valign");
defineReflectedString(HTMLTableCellElement.prototype, "width", "width");
// HTML clamps colSpan to 1..1000 and rowSpan to 0..65534.
// https://html.spec.whatwg.org/#dom-tdth-colspan
defineClampedLong(HTMLTableCellElement.prototype, "colSpan", "colspan", 1, MAX_COL_SPAN, 1);
defineClampedLong(HTMLTableCellElement.prototype, "rowSpan", "rowspan", 0, MAX_ROW_SPAN, 1);
defineReflectedBoolean(HTMLTableCellElement.prototype, "noWrap", "nowrap");
defineReflectedString(HTMLTableCaptionElement.prototype, "align", "align");
defineReflectedString(HTMLTableColElement.prototype, "ch", "char");
defineReflectedString(HTMLTableColElement.prototype, "chOff", "charoff");
defineReflectedString(HTMLTableColElement.prototype, "vAlign", "valign");
defineReflectedString(HTMLTableColElement.prototype, "width", "width");
defineClampedLong(HTMLTableColElement.prototype, "span", "span", 1, MAX_COL_SPAN, 1);

export { HTMLTableCellElement, HTMLTableElement, HTMLTableRowElement, HTMLTableSectionElement };
