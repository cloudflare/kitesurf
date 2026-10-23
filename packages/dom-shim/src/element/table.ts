// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements table-related HTML element classes and their row, cell, and caption helpers.

import type * as Idl from "../idl/types.generated.js";
import type { Element } from "./element.js";
import type { scopedQuerySelectorAll } from "../collections.js";
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
    const idx = normalizeTableIndex(index);
    const doc = this.ownerDocument || document;
    const tr: HTMLTableRowElement = doc.createElement("tr");
    // A table with no rows puts the first row in a tbody, creating one if needed.
    // https://html.spec.whatwg.org/#dom-table-insertrow
    const rows = this.querySelectorAll("tr");
    if (rows.length === 0) {
      appendFirstTableRow(this, doc, tr);
      return tr;
    }
    if (idx === -1 || idx === rows.length) appendAfterLastTableRow(rows, tr);
    else insertTableRowAt(rows, tr, idx);
    return tr;
  }
  deleteRow(index: number): void {
    const rows = this.querySelectorAll("tr");
    const i = index === -1 ? rows.length - 1 : index | 0;
    if (i < 0 || i >= rows.length) throw rangeError("deleteRow", i);
    rows[i].parentNode.removeChild(rows[i]);
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
    const idx = normalizeTableIndex(index);
    const tr: HTMLTableRowElement = (this.ownerDocument || document).createElement("tr");
    const rows = this.querySelectorAll(":scope > tr");
    insertRowInSection(this, tr, rows, idx);
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
    const idx = normalizeTableIndex(index);
    const td: HTMLTableCellElement = (this.ownerDocument || document).createElement("td");
    const cells = this.querySelectorAll(":scope > td, :scope > th");
    insertCellInRow(this, td, cells, idx);
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
    if (!isCellIndexParent(parent)) return -1;
    return tableCellIndex(parent, this);
  }
}

function normalizeTableIndex(index: number | undefined): number {
  return index === undefined || index === -1 ? -1 : index | 0;
}

function appendFirstTableRow(
  table: HTMLTableElement,
  doc: Idl.Document,
  row: HTMLTableRowElement,
): void {
  let body = table.querySelector("tbody");
  if (!body) {
    body = doc.createElement("tbody");
    table.appendChild(body);
  }
  body.appendChild(row);
}

function tableRowParent(row: Idl.Node, method: "appendChild" | "insertBefore"): Idl.Node {
  const parent = row.parentNode;
  if (parent === null) {
    throw new TypeError(`Cannot read properties of null (reading '${method}')`);
  }
  return parent;
}

function appendAfterLastTableRow(
  rows: ReturnType<typeof scopedQuerySelectorAll>,
  row: HTMLTableRowElement,
): void {
  tableRowParent(rows[rows.length - 1], "appendChild").appendChild(row);
}

function insertTableRowAt(
  rows: ReturnType<typeof scopedQuerySelectorAll>,
  row: HTMLTableRowElement,
  index: number,
): void {
  if (index < 0 || index > rows.length) throw rangeError("insertRow", index);
  tableRowParent(rows[index], "insertBefore").insertBefore(row, rows[index]);
}

function insertRowInSection(
  section: Idl.HTMLTableSectionElement,
  row: HTMLTableRowElement,
  rows: ReturnType<typeof scopedQuerySelectorAll>,
  index: number,
): void {
  if (index === -1 || index === rows.length) {
    section.appendChild(row);
    return;
  }
  if (index < 0 || index > rows.length) throw rangeError("insertRow", index);
  section.insertBefore(row, rows[index]);
}

function insertCellInRow(
  row: Idl.HTMLTableRowElement,
  cell: HTMLTableCellElement,
  cells: ReturnType<typeof scopedQuerySelectorAll>,
  index: number,
): void {
  if (index === -1 || index === cells.length) {
    row.appendChild(cell);
    return;
  }
  if (index < 0 || index > cells.length) throw rangeError("insertCell", index);
  row.insertBefore(cell, cells[index]);
}

function isCellIndexParent(parent: Element | null): parent is Element {
  return Boolean(parent && parent.tagName === "TR" && parent.namespaceURI === HTML_NS);
}

function tableCellIndex(parent: Element, cell: HTMLTableCellElement): number {
  const kids = parent.children;
  let index = 0;
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i];
    if (child === cell) return index;
    const tag = child.tagName;
    if (tag === "TD" || tag === "TH") index++;
  }
  return -1;
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
