// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Defines HTMLElement and installs its shared attributes and helper behavior.

import type { WrapperInfo } from "../node-base.js";
import type * as Idl from "../idl/types.generated.js";
import { elementDocument } from "../state.js";
import { MATHML_NS, SVG_NS, TEXT_NODE } from "../constants.js";
import {
  defineReflectedString,
  defineReflectedEnum,
  defineReflectedBoolean,
  defineReflectedLong,
  defineReflectedEnumWithDefaults,
  asciiLowercaseFast,
} from "./reflect.js";
import { Element, renderedTextFragmentNodes } from "./element.js";
import type { NodeBase } from "../node-base.js";

type InstalledHTMLElementMembers = Pick<
  Idl.HTMLElement,
  | "title"
  | "lang"
  | "translate"
  | "dir"
  | "hidden"
  | "inert"
  | "autocapitalize"
  | "autocorrect"
  | "autofocus"
  | "tabIndex"
  | "inputMode"
  | "enterKeyHint"
  | "draggable"
  | "spellcheck"
  | "headingOffset"
  | "headingReset"
  | "popover"
  | "showPopover"
  | "hidePopover"
  | "togglePopover"
>;
// The DOM puts slot and attachShadow on Element (idl-gaps.json lists them
// missing there); the shim installs them on HTMLElement only.
interface HTMLElement extends InstalledHTMLElementMembers {
  slot: string;
  attachShadow(init: Idl.ShadowRootInit): Idl.ShadowRoot;
}

const nonceSlots = new WeakMap<object, string>();

class HTMLElement extends Element implements Idl.HTMLElement {
  declare attachInternals: () => object;
  static [Symbol.hasInstance](v: unknown): boolean {
    return v != null && this.prototype.isPrototypeOf(v);
  }
  get accessKey() {
    return this.getAttribute("accesskey") || "";
  }
  set accessKey(v) {
    this.setAttribute("accesskey", String(v));
  }
  get accessKeyLabel() {
    const raw = this.getAttribute("accesskey");
    if (!raw) return "";
    const tokens = String(raw).trim().split(/\s+/).filter(Boolean);
    if (tokens.length !== 1) return "";
    const t = tokens[0];
    if (t.length !== 1) return "";
    return "Alt+" + t.toUpperCase();
  }
  // A DOMString, not a boolean. A missing attribute defers to the parent;
  // "false" turns suggestions off and any other value turns them on.
  // https://html.spec.whatwg.org/#computed-writing-suggestions-value
  get writingSuggestions(): string {
    for (let el: Element | null = this; el; el = el.parentElement) {
      const v = el.getAttribute("writingsuggestions");
      if (v != null) return asciiLowercaseFast(v) === "false" ? "false" : "true";
    }
    return "true";
  }
  set writingSuggestions(v: string) {
    this.setAttribute("writingsuggestions", String(v));
  }
  // Nonce reflects an internal slot rather than its content attribute.
  // https://html.spec.whatwg.org/#dom-noncedelement-nonce
  get nonce() {
    if (nonceSlots.has(this)) return nonceSlots.get(this) || "";
    const v = this.getAttribute("nonce");
    return v == null ? "" : v;
  }
  set nonce(value: string) {
    nonceSlots.set(this, String(value));
  }
  get contentEditable() {
    const v = this.getAttribute("contenteditable");
    if (v == null) return "inherit";
    const lc = String(v).toLowerCase();
    if (lc === "" || lc === "true") return "true";
    if (lc === "false") return "false";
    if (lc === "plaintext-only") return "plaintext-only";
    if (lc === "inherit") return "inherit";
    return "inherit";
  }
  set contentEditable(v: string) {
    this.setAttribute("contenteditable", String(v));
  }
  // The nearest element that sets a state decides. Hotkey code checks
  // this to tell typing from single-key shortcuts.
  // designMode is always off.
  get isContentEditable() {
    for (let el: Element | null = this; el; el = el.parentElement) {
      const ce = Reflect.get(el, "contentEditable");
      if (ce === "true" || ce === "plaintext-only") return true;
      if (ce === "false") return false;
    }
    return false;
  }
  get outerText(): string | undefined {
    return this.innerText;
  }
  set outerText(v: string) {
    // Non-HTML elements have no outerText IDL attribute and receive an expando.
    // https://html.spec.whatwg.org/#dom-outertext
    const ns = this.namespaceURI;
    if (ns === SVG_NS || ns === MATHML_NS) {
      Object.defineProperty(this, "outerText", {
        value: v === null ? "" : String(v),
        writable: true,
        enumerable: true,
        configurable: true,
      });
      return;
    }
    if (!this.parentNode) {
      throw new DOMException("The element has no parent.", "NoModificationAllowedError");
    }
    const value = v === null ? "" : String(v);
    const doc = elementDocument(this);
    const next = this.nextSibling;
    const previous = this.previousSibling;
    const nodes = renderedTextFragmentNodes(value, doc);
    if (nodes.length === 0) nodes.push(doc.createTextNode(""));
    this.replaceWith(...nodes);
    if (next && next.previousSibling && next.previousSibling.nodeType === TEXT_NODE) {
      mergeWithNextTextNode(next.previousSibling);
    }
    if (previous && previous.nodeType === TEXT_NODE) {
      mergeWithNextTextNode(previous);
    }
  }
}
const HTMLElementProto = HTMLElement.prototype;
defineReflectedString(HTMLElementProto, "title", "title");
defineReflectedString(HTMLElementProto, "lang", "lang");
defineReflectedString(HTMLElementProto, "slot", "slot");
defineReflectedString(HTMLElementProto, "autocapitalize", "autocapitalize");
defineReflectedEnum(HTMLElementProto, "dir", "dir", ["ltr", "rtl", "auto"]);
defineReflectedEnum(HTMLElementProto, "inputMode", "inputmode", [
  "none",
  "text",
  "decimal",
  "numeric",
  "tel",
  "search",
  "email",
  "url",
]);
defineReflectedEnum(HTMLElementProto, "enterKeyHint", "enterkeyhint", [
  "enter",
  "done",
  "go",
  "next",
  "previous",
  "search",
  "send",
]);
defineReflectedBoolean(HTMLElementProto, "hidden", "hidden");
defineReflectedBoolean(HTMLElementProto, "inert", "inert");
defineReflectedBoolean(HTMLElementProto, "autofocus", "autofocus");
defineReflectedLong(HTMLElementProto, "tabIndex", "tabindex", -1);

const InternalElementCtorToken = Symbol("kitesurfInternalElementCtor");

// HTML element interface constructors are not user-constructable: only nodeFor
// holds the token. A hand-written subclass calls this after super().
// https://html.spec.whatwg.org/#htmlconstructor
function checkInternalConstruct(token: unknown, name: string): void {
  if (token !== InternalElementCtorToken) {
    throw new TypeError("Illegal constructor: " + name + " is not user-constructable");
  }
}

// The members an HTML interface adds to HTMLElement.
type IdlOwnMembers<I> = Omit<I, keyof Idl.HTMLElement>;

// The class defineHTMLClass returns: HTMLElement's statics, with a constructor
// and prototype typed as the instance I.
type HTMLElementClass<I extends HTMLElement> = Omit<typeof HTMLElement, "prototype"> & {
  new (nodeId: number, info: WrapperInfo, token: typeof InternalElementCtorToken): I;
  readonly prototype: I;
};

// Use for interfaces whose IDL members callers install later through reflection or
// Object.defineProperty. Classes with their own behavior use a real subclass.
function defineHTMLClass<I extends Idl.HTMLElement>(
  name: string,
): HTMLElementClass<HTMLElement & IdlOwnMembers<I>> {
  const cls = {
    [name]: class extends HTMLElement {
      constructor(nodeId: number, info: WrapperInfo, token?: symbol) {
        super(nodeId, info);
        checkInternalConstruct(token, name);
      }
    },
  }[name];
  // codex-ignore: RFC-009. Callers install these members on the prototype.
  // TypeScript cannot check the cast; idl-conformance verifies installed IDL
  // members and rejects gaps recorded in idl-gaps.json.
  return cls as HTMLElementClass<HTMLElement & IdlOwnMembers<I>>;
}

defineReflectedLong(HTMLElement.prototype, "headingOffset", "headingoffset", 0);
defineReflectedBoolean(HTMLElement.prototype, "headingReset", "headingreset");

defineReflectedBoolean(HTMLElement.prototype, "draggable", "draggable");
defineReflectedBoolean(HTMLElement.prototype, "spellcheck", "spellcheck");
defineReflectedBoolean(HTMLElement.prototype, "translate", "translate");
defineReflectedBoolean(HTMLElement.prototype, "autocorrect", "autocorrect");

function mergeWithNextTextNode(node: NodeBase | null) {
  if (!node || node.nodeType !== TEXT_NODE) return;
  const next = node.nextSibling;
  if (!next || next.nodeType !== TEXT_NODE) return;
  node.data = String(node.data) + String(next.data);
  next.remove();
}

HTMLElement.prototype.attachInternals = function () {
  return {
    shadowRoot: null,
    form: null,
    states: new Set(),
    willValidate: false,
    validity: { valid: true },
    validationMessage: "",
    labels: [],
    setFormValue() {},
    setValidity() {},
    checkValidity() {
      return true;
    },
    reportValidity() {
      return true;
    },
  };
};
HTMLElement.prototype.showPopover = function () {};
HTMLElement.prototype.hidePopover = function () {};
HTMLElement.prototype.togglePopover = function (_force) {
  return false;
};

defineReflectedEnumWithDefaults(
  HTMLElement.prototype,
  "popover",
  "popover",
  ["auto", "manual", "hint"],
  "",
  "manual",
);

export { HTMLElement, InternalElementCtorToken, checkInternalConstruct, defineHTMLClass };
