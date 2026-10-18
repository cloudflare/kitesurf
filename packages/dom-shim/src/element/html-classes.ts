// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Defines HTML element interfaces whose members are installed by other element modules.

import type * as Idl from "../idl/types.generated.js";
import { defineHTMLClass } from "./html-element.js";

// LegacyExtras are members the shim reflects although the pinned IDL has
// none: area's charset and rev.
type LegacyExtras<K extends string> = Record<K, string>;
const HTMLDataListElement = defineHTMLClass<Idl.HTMLDataListElement>("HTMLDataListElement");
const HTMLAnchorElement = defineHTMLClass<Idl.HTMLAnchorElement>("HTMLAnchorElement");
const HTMLUnknownElement = defineHTMLClass<Idl.HTMLUnknownElement>("HTMLUnknownElement");
const HTMLAreaElement = defineHTMLClass<Idl.HTMLAreaElement & LegacyExtras<"charset" | "rev">>(
  "HTMLAreaElement",
);
const HTMLPictureElement = defineHTMLClass<Idl.HTMLPictureElement>("HTMLPictureElement");
const HTMLSourceElement = defineHTMLClass<Idl.HTMLSourceElement>("HTMLSourceElement");
const HTMLDivElement = defineHTMLClass<Idl.HTMLDivElement>("HTMLDivElement");
const HTMLSpanElement = defineHTMLClass<Idl.HTMLSpanElement>("HTMLSpanElement");
const HTMLParagraphElement = defineHTMLClass<Idl.HTMLParagraphElement>("HTMLParagraphElement");
const HTMLHeadingElement = defineHTMLClass<Idl.HTMLHeadingElement>("HTMLHeadingElement");
const HTMLBodyElement = defineHTMLClass<Idl.HTMLBodyElement>("HTMLBodyElement");
const HTMLHtmlElement = defineHTMLClass<Idl.HTMLHtmlElement>("HTMLHtmlElement");
const HTMLHeadElement = defineHTMLClass<Idl.HTMLHeadElement>("HTMLHeadElement");
const HTMLTitleElement = defineHTMLClass<Idl.HTMLTitleElement>("HTMLTitleElement");
const HTMLScriptElement = defineHTMLClass<Idl.HTMLScriptElement>("HTMLScriptElement");
const HTMLLinkElement = defineHTMLClass<Idl.HTMLLinkElement>("HTMLLinkElement");
const HTMLMetaElement = defineHTMLClass<Idl.HTMLMetaElement>("HTMLMetaElement");
const HTMLStyleElement = defineHTMLClass<Idl.HTMLStyleElement>("HTMLStyleElement");
const HTMLBaseElement = defineHTMLClass<Idl.HTMLBaseElement>("HTMLBaseElement");
const HTMLBRElement = defineHTMLClass<Idl.HTMLBRElement>("HTMLBRElement");
const HTMLHRElement = defineHTMLClass<Idl.HTMLHRElement>("HTMLHRElement");
const HTMLPreElement = defineHTMLClass<Idl.HTMLPreElement>("HTMLPreElement");
const HTMLQuoteElement = defineHTMLClass<Idl.HTMLQuoteElement>("HTMLQuoteElement");
const HTMLUListElement = defineHTMLClass<Idl.HTMLUListElement>("HTMLUListElement");
const HTMLOListElement = defineHTMLClass<Idl.HTMLOListElement>("HTMLOListElement");
const HTMLLIElement = defineHTMLClass<Idl.HTMLLIElement>("HTMLLIElement");
const HTMLDListElement = defineHTMLClass<Idl.HTMLDListElement>("HTMLDListElement");
const HTMLMenuElement = defineHTMLClass<Idl.HTMLMenuElement>("HTMLMenuElement");
const HTMLTableCaptionElement =
  defineHTMLClass<Idl.HTMLTableCaptionElement>("HTMLTableCaptionElement");
const HTMLTableColElement = defineHTMLClass<Idl.HTMLTableColElement>("HTMLTableColElement");
const HTMLTemplateElement = defineHTMLClass<Idl.HTMLTemplateElement>("HTMLTemplateElement");
const HTMLTimeElement = defineHTMLClass<Idl.HTMLTimeElement>("HTMLTimeElement");
const HTMLDetailsElement = defineHTMLClass<Idl.HTMLDetailsElement>("HTMLDetailsElement");
const HTMLDialogElement = defineHTMLClass<Idl.HTMLDialogElement>("HTMLDialogElement");
const HTMLModElement = defineHTMLClass<Idl.HTMLModElement>("HTMLModElement"); // <ins>, <del>
const HTMLDataElement = defineHTMLClass<Idl.HTMLDataElement>("HTMLDataElement");
const HTMLMapElement = defineHTMLClass<Idl.HTMLMapElement>("HTMLMapElement");
const HTMLTrackElement = defineHTMLClass<Idl.HTMLTrackElement>("HTMLTrackElement");
const HTMLParamElement = defineHTMLClass<Idl.HTMLParamElement>("HTMLParamElement");
const HTMLDirectoryElement = defineHTMLClass<Idl.HTMLDirectoryElement>("HTMLDirectoryElement");
const HTMLFontElement = defineHTMLClass<Idl.HTMLFontElement>("HTMLFontElement");
const HTMLFrameElement = defineHTMLClass<Idl.HTMLFrameElement>("HTMLFrameElement");
const HTMLFrameSetElement = defineHTMLClass<Idl.HTMLFrameSetElement>("HTMLFrameSetElement");
const HTMLMarqueeElement = defineHTMLClass<Idl.HTMLMarqueeElement>("HTMLMarqueeElement");

export {
  HTMLAnchorElement,
  HTMLAreaElement,
  HTMLBRElement,
  HTMLBaseElement,
  HTMLBodyElement,
  HTMLDListElement,
  HTMLDataElement,
  HTMLDataListElement,
  HTMLDetailsElement,
  HTMLDialogElement,
  HTMLDirectoryElement,
  HTMLDivElement,
  HTMLFontElement,
  HTMLFrameElement,
  HTMLFrameSetElement,
  HTMLHRElement,
  HTMLHeadElement,
  HTMLHeadingElement,
  HTMLHtmlElement,
  HTMLLIElement,
  HTMLLinkElement,
  HTMLMapElement,
  HTMLMarqueeElement,
  HTMLMenuElement,
  HTMLMetaElement,
  HTMLModElement,
  HTMLOListElement,
  HTMLParagraphElement,
  HTMLParamElement,
  HTMLPictureElement,
  HTMLPreElement,
  HTMLQuoteElement,
  HTMLScriptElement,
  HTMLSourceElement,
  HTMLSpanElement,
  HTMLStyleElement,
  HTMLTableCaptionElement,
  HTMLTableColElement,
  HTMLTemplateElement,
  HTMLTimeElement,
  HTMLTitleElement,
  HTMLTrackElement,
  HTMLUListElement,
  HTMLUnknownElement,
};
