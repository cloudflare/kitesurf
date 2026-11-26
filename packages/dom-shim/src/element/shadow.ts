// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements shadow roots and slots plus declarative shadow-root conversion.

import type { WrapperInfo } from "../node-base.js";
import type * as Idl from "../idl/types.generated.js";
import { declarativeShadowRoots, dom, nodeFor, shadowRootFor, shadowRootModes } from "../state.js";
import type { NodeBase } from "../node-base.js";
import { ELEMENT_NODE, HTML_NS } from "../constants.js";
import { recordCdpMutation } from "../record.js";
import { Element } from "./element.js";
import { defineAttribute } from "./reflect.js";
import { HTMLElement, checkInternalConstruct } from "./html-element.js";

// tag-attributes.ts installs name.
interface HTMLSlotElement extends Pick<Idl.HTMLSlotElement, "name"> {}

// Slots take their assigned nodes from the wasm DOM; there is no assign().
class HTMLSlotElement extends HTMLElement implements Idl.HTMLSlotElement {
  constructor(nodeId: number, info: WrapperInfo, token?: symbol) {
    super(nodeId, info);
    checkInternalConstruct(token, "HTMLSlotElement");
  }
  assignedNodes(_options?: Idl.AssignedNodesOptions): Idl.Node[] {
    // Limitation: flatten is accepted but nested slot flattening is not implemented.
    try {
      return Array.from(dom.assignedNodesOf(this._id))
        .map((id) => nodeFor(id))
        .filter((n): n is NodeBase => n !== null);
    } catch {
      return [];
    }
  }
  assignedElements(_options?: Idl.AssignedNodesOptions): Idl.Element[] {
    return this.assignedNodes().filter((n): n is Idl.Element => n.nodeType === ELEMENT_NODE);
  }
}
// DOM §4.9: built-in HTML elements allowed to host a shadow root.
// https://dom.spec.whatwg.org/#dom-element-attachshadow
const SHADOW_HOST_SAFELIST = new Set([
  "article",
  "aside",
  "blockquote",
  "body",
  "div",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "main",
  "nav",
  "p",
  "section",
  "span",
]);

const FORBIDDEN_CUSTOM_ELEMENT_NAMES = new Set([
  "annotation-xml",
  "color-profile",
  "font-face",
  "font-face-src",
  "font-face-uri",
  "font-face-format",
  "font-face-name",
  "missing-glyph",
]);

// HTML §4.13.3: valid custom element name (ASCII lowercase start, contains '-',
// no ASCII uppercase, ASCII whitespace, NUL, '/', '>', or forbidden names).
// https://html.spec.whatwg.org/#valid-custom-element-name
function isValidCustomElementName(localName: string): boolean {
  if (localName.length < 2 || FORBIDDEN_CUSTOM_ELEMENT_NAMES.has(localName)) return false;
  const first = localName.charCodeAt(0);
  if (first < 0x61 || first > 0x7a) return false;
  let hasHyphen = false;
  for (let i = 1; i < localName.length; i++) {
    const c = localName.charCodeAt(i);
    if (c === 0x2d) {
      hasHyphen = true;
    } else if (
      (c >= 0x41 && c <= 0x5a) ||
      c === 0x00 ||
      c === 0x09 ||
      c === 0x0a ||
      c === 0x0c ||
      c === 0x0d ||
      c === 0x20 ||
      c === 0x2f ||
      c === 0x3e
    ) {
      return false;
    }
  }
  return hasHyphen;
}

function isValidShadowHostName(localName: string): boolean {
  return SHADOW_HOST_SAFELIST.has(localName) || isValidCustomElementName(localName);
}

// Keep attachShadow on HTMLElement because DocumentFragmentImpl extends Element.
HTMLElement.prototype.attachShadow = function (this: HTMLElement, opts) {
  const mode = opts && opts.mode;
  if (mode !== "open" && mode !== "closed") {
    throw new TypeError(
      "Failed to execute 'attachShadow' on 'Element': mode must be 'open' or 'closed'",
    );
  }
  if (this.namespaceURI !== HTML_NS || !isValidShadowHostName(this.localName)) {
    throw new DOMException(
      "Failed to execute 'attachShadow' on 'Element': This element does not support attachShadow",
      "NotSupportedError",
    );
  }
  const existingId = dom.shadowRootId(this._id);
  if (existingId >= 0) {
    // DOM "attach a shadow root": a declarative root with the same mode is emptied, stops
    // being declarative, and is returned. Server-rendered web components (for example
    // NumberFlow) hydrate this way.
    if (declarativeShadowRoots.has(existingId) && shadowRootModes.get(existingId) === mode) {
      const existing = shadowRootFor(existingId);
      if (existing) {
        declarativeShadowRoots.delete(existingId);
        // replaceChildren puts the adopted-stylesheet mirrors back after emptying the root.
        existing.replaceChildren();
        return existing;
      }
    }
    throw new DOMException(
      "Shadow root cannot be created on a host which already hosts a shadow root",
      "NotSupportedError",
    );
  }
  const rootId = dom.attachShadow(this._id, mode);
  if (rootId < 0) {
    throw new DOMException("Unable to attach a shadow root here", "NotSupportedError");
  }
  shadowRootModes.set(rootId, mode);
  try {
    // Depth 0 keeps the event small whatever the root holds; clients request its children.
    const root = dom.nodeSubtree(rootId, 0, false);
    if (root) {
      recordCdpMutation({
        kind: "shadowRootPushed",
        hostId: this._id,
        root,
      });
    }
  } catch {}
  const root = shadowRootFor(rootId);
  // nodeFor wraps a new shadow root node as a ShadowRoot; returning null
  // here was a broken invariant, as mintedNode treats one.
  if (!root)
    throw new TypeError(`dom-shim: new shadow root ${rootId} did not wrap as a ShadowRoot`);
  return root;
};

defineAttribute(Element.prototype, "shadowRoot", {
  get() {
    // Query wasm state so shadow roots survive wrapper-cache eviction.
    const rootId = dom.shadowRootId(this._id);
    if (rootId < 0) return null;
    if (shadowRootModes.get(rootId) === "closed") return null;
    return shadowRootFor(rootId);
  },
});

export function applyDeclarativeShadowRoots(root: Pick<Idl.Document, "querySelectorAll">): void {
  // Blitz parses declarative shadow templates as ordinary templates.
  let tpls: Idl.NodeList | null = null;
  try {
    tpls = root.querySelectorAll("template[shadowrootmode]");
  } catch {
    return;
  }
  if (!tpls || !tpls.length) return;
  for (let i = 0; i < tpls.length; i++) {
    // The selector returns element wrappers, though NodeList types items as Node.
    const tpl = tpls[i] as Element;
    const hostNode = tpl.parentNode;
    if (!hostNode || hostNode.nodeType !== ELEMENT_NODE) continue;
    // nodeFor wraps every element node in an HTMLElement subclass, including namespace aliases.
    const host = hostNode as HTMLElement;
    const mode = tpl.getAttribute("shadowrootmode");
    if (mode !== "open" && mode !== "closed") continue;
    // A host keeps its first declared root; a later template stays an ordinary template.
    if (dom.shadowRootId(host._id) >= 0) continue;
    let shadow: Idl.ShadowRoot;
    try {
      shadow = host.attachShadow({
        mode,
        delegatesFocus: tpl.hasAttribute("shadowrootdelegatesfocus"),
      });
    } catch {
      continue;
    }
    const declaredId = dom.shadowRootId(host._id);
    if (declaredId >= 0) declarativeShadowRoots.add(declaredId);
    try {
      const content = tpl.content;
      while (content && content.firstChild) shadow.appendChild(content.firstChild);
      tpl.remove();
    } catch {}
    // Nested declarations become reachable only after the outer template content moves.
    applyDeclarativeShadowRoots(shadow);
  }
}

export { HTMLSlotElement };
