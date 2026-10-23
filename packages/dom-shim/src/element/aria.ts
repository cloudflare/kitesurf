// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Installs Element's ARIA and role attribute reflections.

import { Element } from "./element.js";
import { defineAttribute } from "./reflect.js";

// The ARIA reflections Element declares.
type AriaAttribute = Extract<keyof Element, `aria${string}` | "role">;

interface AriaSpec {
  attr: string;
  keywords?: string[];
  invalidVal?: string | null;
  defaultVal?: string | null;
  nonCanon?: Record<string, string | null>;
}
// ARIA 1.3 reflects aria-* as nullable DOMStrings without enum defaults. The
// keyword defaults here follow the tentative w3c/aria#2484 proposal instead.
// https://www.w3.org/TR/wai-aria-1.3/#x6-3-2-idl-reflection-of-aria-attributes
const ariaSpecs: Array<[AriaAttribute, AriaSpec]> = [
  ["role", { attr: "role" }],
  ["ariaBrailleLabel", { attr: "aria-braillelabel" }],
  ["ariaBrailleRoleDescription", { attr: "aria-brailleroledescription" }],
  ["ariaColCount", { attr: "aria-colcount" }],
  ["ariaColIndex", { attr: "aria-colindex" }],
  ["ariaColIndexText", { attr: "aria-colindextext" }],
  ["ariaColSpan", { attr: "aria-colspan" }],
  ["ariaDescription", { attr: "aria-description" }],
  ["ariaKeyShortcuts", { attr: "aria-keyshortcuts" }],
  ["ariaLabel", { attr: "aria-label" }],
  ["ariaLevel", { attr: "aria-level" }],
  ["ariaPlaceholder", { attr: "aria-placeholder" }],
  ["ariaPosInSet", { attr: "aria-posinset" }],
  ["ariaRelevant", { attr: "aria-relevant" }],
  ["ariaRoleDescription", { attr: "aria-roledescription" }],
  ["ariaRowCount", { attr: "aria-rowcount" }],
  ["ariaRowIndex", { attr: "aria-rowindex" }],
  ["ariaRowIndexText", { attr: "aria-rowindextext" }],
  ["ariaRowSpan", { attr: "aria-rowspan" }],
  ["ariaSetSize", { attr: "aria-setsize" }],
  ["ariaValueMax", { attr: "aria-valuemax" }],
  ["ariaValueMin", { attr: "aria-valuemin" }],
  ["ariaValueNow", { attr: "aria-valuenow" }],
  ["ariaValueText", { attr: "aria-valuetext" }],
  [
    "ariaAtomic",
    {
      attr: "aria-atomic",
      keywords: ["true", "false"],
      nonCanon: { "": "false" },
      invalidVal: "false",
      defaultVal: null,
    },
  ],
  [
    "ariaAutoComplete",
    {
      attr: "aria-autocomplete",
      keywords: ["inline", "list", "both", "none"],
      invalidVal: "none",
      defaultVal: "none",
    },
  ],
  [
    "ariaBusy",
    {
      attr: "aria-busy",
      keywords: ["true", "false"],
      nonCanon: { "": "false" },
      invalidVal: "false",
      defaultVal: "false",
    },
  ],
  [
    "ariaChecked",
    {
      attr: "aria-checked",
      keywords: ["true", "false", "mixed"],
      nonCanon: { "": null },
      invalidVal: null,
      defaultVal: null,
    },
  ],
  [
    "ariaCurrent",
    {
      attr: "aria-current",
      keywords: ["page", "step", "location", "date", "time", "true", "false"],
      nonCanon: { "": "false" },
      invalidVal: "true",
      defaultVal: "false",
    },
  ],
  [
    "ariaDisabled",
    {
      attr: "aria-disabled",
      keywords: ["true", "false"],
      nonCanon: { "": "false" },
      invalidVal: "false",
      defaultVal: "false",
    },
  ],
  [
    "ariaExpanded",
    {
      attr: "aria-expanded",
      keywords: ["true", "false"],
      nonCanon: { "": null },
      invalidVal: null,
      defaultVal: null,
    },
  ],
  [
    "ariaHasPopup",
    {
      attr: "aria-haspopup",
      keywords: ["true", "false", "menu", "dialog", "listbox", "tree", "grid"],
      invalidVal: "false",
      defaultVal: null,
    },
  ],
  [
    "ariaHidden",
    {
      attr: "aria-hidden",
      keywords: ["true", "false"],
      nonCanon: { "": "false" },
      invalidVal: "false",
      defaultVal: "false",
    },
  ],
  [
    "ariaInvalid",
    {
      attr: "aria-invalid",
      keywords: ["true", "false", "spelling", "grammar"],
      nonCanon: { "": "false" },
      invalidVal: "true",
      defaultVal: "false",
    },
  ],
  [
    "ariaLive",
    {
      attr: "aria-live",
      keywords: ["polite", "assertive", "off"],
      invalidVal: "off",
      defaultVal: "off",
    },
  ],
  [
    "ariaModal",
    {
      attr: "aria-modal",
      keywords: ["true", "false"],
      nonCanon: { "": "false" },
      invalidVal: "false",
      defaultVal: "false",
    },
  ],
  [
    "ariaMultiLine",
    {
      attr: "aria-multiline",
      keywords: ["true", "false"],
      nonCanon: { "": "false" },
      invalidVal: "false",
      defaultVal: "false",
    },
  ],
  [
    "ariaMultiSelectable",
    {
      attr: "aria-multiselectable",
      keywords: ["true", "false"],
      nonCanon: { "": "false" },
      invalidVal: "false",
      defaultVal: "false",
    },
  ],
  [
    "ariaOrientation",
    {
      attr: "aria-orientation",
      keywords: ["horizontal", "vertical"],
      nonCanon: { "": null },
      invalidVal: null,
      defaultVal: null,
    },
  ],
  [
    "ariaPressed",
    {
      attr: "aria-pressed",
      keywords: ["true", "false", "mixed"],
      nonCanon: { "": null },
      invalidVal: null,
      defaultVal: null,
    },
  ],
  [
    "ariaReadOnly",
    {
      attr: "aria-readonly",
      keywords: ["true", "false"],
      nonCanon: { "": "false" },
      invalidVal: "false",
      defaultVal: "false",
    },
  ],
  [
    "ariaRequired",
    {
      attr: "aria-required",
      keywords: ["true", "false"],
      nonCanon: { "": "false" },
      invalidVal: "false",
      defaultVal: "false",
    },
  ],
  [
    "ariaSelected",
    {
      attr: "aria-selected",
      keywords: ["true", "false"],
      nonCanon: { "": null },
      invalidVal: null,
      defaultVal: null,
    },
  ],
  [
    "ariaSort",
    {
      attr: "aria-sort",
      keywords: ["ascending", "descending", "other", "none"],
      invalidVal: "none",
      defaultVal: "none",
    },
  ],
];
function reflectAriaEnum(this: Element, spec: AriaSpec): string | null {
  if (!spec.keywords) {
    return reflectAriaString.call(this, spec);
  }
  if (!this.hasAttribute(spec.attr)) return spec.defaultVal ?? null;
  const raw = String(this.getAttribute(spec.attr) ?? "");
  return reflectAriaKeyword(spec, raw, spec.keywords);
}

function reflectAriaString(this: Element, spec: AriaSpec): string | null {
  return this.hasAttribute(spec.attr) ? this.getAttribute(spec.attr) : null;
}

function reflectAriaKeyword(spec: AriaSpec, raw: string, keywords: string[]): string | null {
  const nonCanonical = ariaNonCanonicalValue(spec, raw);
  if (nonCanonical !== undefined) return nonCanonical;
  const lower = raw.toLowerCase();
  const match = matchingAriaKeyword(keywords, lower);
  return match ?? spec.invalidVal ?? null;
}

function matchingAriaKeyword(keywords: string[], value: string): string | undefined {
  for (const keyword of keywords) {
    if (keyword === value) return keyword;
  }
  return undefined;
}

function ariaNonCanonicalValue(spec: AriaSpec, raw: string): string | null | undefined {
  if (!spec.nonCanon || !Object.prototype.hasOwnProperty.call(spec.nonCanon, raw)) {
    return undefined;
  }
  return spec.nonCanon[raw];
}
for (const [idl, spec] of ariaSpecs) {
  defineAttribute(Element.prototype, idl, {
    get() {
      return reflectAriaEnum.call(this, spec);
    },
    set(value) {
      if (value === null || value === undefined) {
        this.removeAttribute(spec.attr);
      } else {
        this.setAttribute(spec.attr, String(value));
      }
    },
  });
}
