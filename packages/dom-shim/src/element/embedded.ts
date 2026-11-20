// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements embedded-content element interfaces and their tag-specific behavior.

import type { WrapperInfo } from "../node-base.js";
import type * as Idl from "../idl/types.generated.js";
import {
  defineReflectedString,
  defineReflectedUrl,
  defineReflectedStringNullEmpty,
  defineReflectedEnumWithDefaults,
  defineReflectedBoolean,
  defineReflectedUnsignedLong,
} from "./reflect.js";
import type { Element } from "./element.js";
import { HTMLElement, checkInternalConstruct } from "./html-element.js";
import { HTMLParamElement } from "./html-classes.js";

// Cross-origin frames already expose null through contentDocument.
// https://html.spec.whatwg.org/#dom-media-getsvgdocument
function svgDocumentOf(
  el: Element & { readonly contentDocument?: Idl.Document | null },
): Idl.Document | null {
  const d = el.contentDocument ?? null;
  if (!d) return null;
  try {
    const ct = String(d.contentType ?? "");
    if (ct.includes("svg")) return d;
    const root = d.documentElement;
    return root && String(root.localName ?? "").toLowerCase() === "svg" ? d : null;
  } catch {
    return null;
  }
}

// The reflections below the class install these, and tag-attributes.ts
// installs align, referrerPolicy and fetchPriority, which the IDL no longer
// has for iframes.
interface HTMLIFrameElement extends Pick<
  Idl.HTMLIFrameElement,
  | "name"
  | "longDesc"
  | "frameBorder"
  | "scrolling"
  | "width"
  | "height"
  | "marginWidth"
  | "marginHeight"
  | "loading"
  | "srcdoc"
  | "allowFullscreen"
  | "align"
  | "referrerPolicy"
> {
  get sandbox(): Idl.HTMLIFrameElement["sandbox"];
  fetchPriority: string;
}

class HTMLIFrameElement extends HTMLElement implements Idl.HTMLIFrameElement {
  // PageScript sets these on the element once the child document loads.
  declare __ks_iframeContentDocument?: Idl.Document | null;
  declare __ks_iframeContentWindow?: unknown;
  constructor(nodeId: number, info: WrapperInfo, token?: symbol) {
    super(nodeId, info);
    checkInternalConstruct(token, "HTMLIFrameElement");
  }
  get contentDocument(): Idl.Document | null {
    return this.__ks_iframeContentDocument ?? null;
  }
  get contentWindow(): unknown {
    return this.__ks_iframeContentWindow ?? null;
  }
  getSVGDocument(): Idl.Document | null {
    return svgDocumentOf(this);
  }
}

// The reflections below the class install these, and tag-attributes.ts
// installs align.
interface HTMLEmbedElement extends Pick<
  Idl.HTMLEmbedElement,
  "name" | "type" | "width" | "height" | "align"
> {}
class HTMLEmbedElement extends HTMLElement implements Idl.HTMLEmbedElement {
  constructor(nodeId: number, info: WrapperInfo, token?: symbol) {
    super(nodeId, info);
    checkInternalConstruct(token, "HTMLEmbedElement");
  }
  getSVGDocument(): Idl.Document | null {
    return svgDocumentOf(this);
  }
}

// The reflections below the class install these, and tag-attributes.ts
// installs align. data is missing from the list because NodeBase declares it,
// as an untyped getter for character data, so neither its reflection nor the
// implements clause checks it.
interface HTMLObjectElement extends Pick<
  Idl.HTMLObjectElement,
  | "border"
  | "code"
  | "codeBase"
  | "codeType"
  | "name"
  | "standby"
  | "type"
  | "useMap"
  | "width"
  | "height"
  | "archive"
  | "declare"
  | "hspace"
  | "vspace"
  | "align"
> {}

// There is no nested document, so getSVGDocument() always returns null.
class HTMLObjectElement extends HTMLElement implements Idl.HTMLObjectElement {
  constructor(nodeId: number, info: WrapperInfo, token?: symbol) {
    super(nodeId, info);
    checkInternalConstruct(token, "HTMLObjectElement");
  }
  getSVGDocument(): Idl.Document | null {
    return svgDocumentOf(this);
  }
}

defineReflectedString(HTMLIFrameElement.prototype, "name", "name");
defineReflectedUrl(HTMLIFrameElement.prototype, "longDesc", "longdesc");
defineReflectedString(HTMLIFrameElement.prototype, "frameBorder", "frameborder");
defineReflectedString(HTMLIFrameElement.prototype, "scrolling", "scrolling");
defineReflectedString(HTMLIFrameElement.prototype, "width", "width");
defineReflectedString(HTMLIFrameElement.prototype, "height", "height");
defineReflectedStringNullEmpty(HTMLIFrameElement.prototype, "marginWidth", "marginwidth");
defineReflectedStringNullEmpty(HTMLIFrameElement.prototype, "marginHeight", "marginheight");
defineReflectedEnumWithDefaults(
  HTMLIFrameElement.prototype,
  "loading",
  "loading",
  ["eager", "lazy"],
  "eager",
  "eager",
);
defineReflectedString(HTMLIFrameElement.prototype, "srcdoc", "srcdoc");
defineReflectedBoolean(HTMLIFrameElement.prototype, "allowFullscreen", "allowfullscreen");

defineReflectedString(HTMLEmbedElement.prototype, "name", "name");
defineReflectedString(HTMLEmbedElement.prototype, "type", "type");
defineReflectedString(HTMLEmbedElement.prototype, "width", "width");
defineReflectedString(HTMLEmbedElement.prototype, "height", "height");
defineReflectedStringNullEmpty(HTMLObjectElement.prototype, "border", "border");
defineReflectedString(HTMLObjectElement.prototype, "code", "code");
defineReflectedUrl(HTMLObjectElement.prototype, "codeBase", "codebase");
defineReflectedString(HTMLObjectElement.prototype, "codeType", "codetype");
defineReflectedUrl(HTMLObjectElement.prototype, "data", "data");
defineReflectedString(HTMLObjectElement.prototype, "name", "name");
defineReflectedString(HTMLObjectElement.prototype, "standby", "standby");
defineReflectedString(HTMLObjectElement.prototype, "type", "type");
defineReflectedString(HTMLObjectElement.prototype, "useMap", "usemap");
defineReflectedString(HTMLObjectElement.prototype, "width", "width");
defineReflectedString(HTMLObjectElement.prototype, "height", "height");
defineReflectedString(HTMLObjectElement.prototype, "archive", "archive");
defineReflectedBoolean(HTMLObjectElement.prototype, "declare", "declare");
defineReflectedUnsignedLong(HTMLObjectElement.prototype, "hspace", "hspace", 0);
defineReflectedUnsignedLong(HTMLObjectElement.prototype, "vspace", "vspace", 0);
defineReflectedString(HTMLParamElement.prototype, "name", "name");
defineReflectedString(HTMLParamElement.prototype, "type", "type");
defineReflectedString(HTMLParamElement.prototype, "value", "value");
defineReflectedString(HTMLParamElement.prototype, "valueType", "valuetype");

export { HTMLEmbedElement, HTMLIFrameElement, HTMLObjectElement };
