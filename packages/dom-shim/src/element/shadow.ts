// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements shadow roots and slots plus declarative shadow-root conversion.

import type * as Idl from "../idl/types.generated.js";
import { dom, nodeFor, shadowRootModes } from "../state.js";
import { ELEMENT_NODE, HTML_NS } from "../constants.js";
import { recordCdpMutation } from "../record.js";
import { Element } from "./element.js";
import { defineAttribute } from "./reflect.js";
import { HTMLElement, checkInternalConstruct } from "./html-element.js";

// tag-attributes.ts installs name.
interface HTMLSlotElement extends Pick<Idl.HTMLSlotElement, "name"> {}

// Slots take their assigned nodes from the wasm DOM; there is no assign().
class HTMLSlotElement extends HTMLElement implements Idl.HTMLSlotElement {
  constructor(nodeId: number, info: unknown, token?: symbol) {
    super(nodeId, info);
    checkInternalConstruct(token, "HTMLSlotElement");
  }
  assignedNodes(_options?: Idl.AssignedNodesOptions): Idl.Node[] {
    // Limitation: flatten is accepted but nested slot flattening is not implemented.
    try {
      return Array.from(dom.assignedNodesOf(this._id))
        .map((id) => nodeFor(id))
        .filter(Boolean);
    } catch {
      return [];
    }
  }
  assignedElements(_options?: Idl.AssignedNodesOptions): Idl.Element[] {
    return this.assignedNodes().filter((n): n is Idl.Element => n.nodeType === ELEMENT_NODE);
  }
}
// Keep attachShadow on HTMLElement because DocumentFragmentImpl extends Element.
HTMLElement.prototype.attachShadow = function (this: HTMLElement, opts) {
  const mode = opts && opts.mode;
  assertShadowRootMode(mode);
  assertHtmlShadowHost(this);
  assertNoExistingShadowRoot(this._id);
  const rootId = dom.attachShadow(this._id, mode);
  assertShadowRootCreated(rootId);
  shadowRootModes.set(rootId, mode);
  recordShadowRootPushed(this, rootId);
  return nodeFor(rootId);
};

function assertShadowRootMode(mode: unknown): asserts mode is "open" | "closed" {
  if (mode !== "open" && mode !== "closed") {
    throw new TypeError(
      "Failed to execute 'attachShadow' on 'Element': mode must be 'open' or 'closed'",
    );
  }
}

function assertHtmlShadowHost(host: HTMLElement): void {
  if (host.namespaceURI !== HTML_NS) {
    throw new DOMException(
      "attachShadow: host element must be in the HTML namespace",
      "NotSupportedError",
    );
  }
}

function assertNoExistingShadowRoot(hostId: number): void {
  if (dom.shadowRootId(hostId) >= 0) {
    throw new DOMException(
      "Shadow root cannot be created on a host which already hosts a shadow root",
      "NotSupportedError",
    );
  }
}

function assertShadowRootCreated(rootId: number): void {
  if (rootId < 0) {
    throw new DOMException("Unable to attach a shadow root here", "NotSupportedError");
  }
}

function recordShadowRootPushed(host: HTMLElement, rootId: number): void {
  try {
    const root = dom.nodeSubtree(rootId);
    if (root) {
      recordCdpMutation({
        kind: "shadowRootPushed",
        hostId: host._id,
        root,
      });
    }
  } catch {}
}

defineAttribute(Element.prototype, "shadowRoot", {
  get() {
    // Query wasm state so shadow roots survive wrapper-cache eviction.
    const rootId = dom.shadowRootId(this._id);
    if (rootId < 0) return null;
    if (shadowRootModes.get(rootId) === "closed") return null;
    return nodeFor(rootId);
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
    // SAFETY: the selector returns elements; IDL NodeList cannot express that invariant.
    // Verified by: test/e2e/template-content-parse.e2e.test.ts.
    applyDeclarativeShadowRootTemplate(tpls[i] as Element);
  }
}

function applyDeclarativeShadowRootTemplate(template: Element): void {
  const host = shadowHostForTemplate(template);
  if (!host) return;
  const mode = template.getAttribute("shadowrootmode");
  if (mode !== "open" && mode !== "closed") return;
  const shadow = createDeclarativeShadowRoot(host, template, mode);
  if (!shadow) return;
  moveDeclarativeShadowContent(template, shadow);
  // Nested declarations become reachable only after the outer template content moves.
  applyDeclarativeShadowRoots(shadow);
}

function shadowHostForTemplate(template: Element): HTMLElement | null {
  const hostNode = template.parentNode;
  if (!hostNode || hostNode.nodeType !== ELEMENT_NODE) return null;
  // nodeFor wraps every element node in an HTMLElement subclass, including namespace aliases.
  return hostNode as HTMLElement;
}

function createDeclarativeShadowRoot(
  host: HTMLElement,
  template: Element,
  mode: "open" | "closed",
): Idl.ShadowRoot | null {
  try {
    return host.attachShadow({
      mode,
      delegatesFocus: template.hasAttribute("shadowrootdelegatesfocus"),
    });
  } catch {
    return null;
  }
}

function moveDeclarativeShadowContent(template: Element, shadow: Idl.ShadowRoot): void {
  try {
    const content = template.content;
    while (content && content.firstChild) shadow.appendChild(content.firstChild);
    template.remove();
  } catch {}
}

export { HTMLSlotElement };
