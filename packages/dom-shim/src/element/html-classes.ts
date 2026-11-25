// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Defines HTML element interfaces whose members are installed by other element modules.

import { defineHTMLClass } from "./html-element.js";

// LegacyExtras are members the shim reflects although the pinned IDL has
// none: area's charset and rev.
type LegacyExtras<K extends string> = Record<K, string>;
const HTMLDataListElement = defineHTMLClass("HTMLDataListElement");
const HTMLAnchorElement = defineHTMLClass("HTMLAnchorElement");
const HTMLUnknownElement = defineHTMLClass("HTMLUnknownElement");
const HTMLAreaElement = defineHTMLClass<"HTMLAreaElement", LegacyExtras<"charset" | "rev">>(
  "HTMLAreaElement",
);
const HTMLPictureElement = defineHTMLClass("HTMLPictureElement");
const HTMLSourceElement = defineHTMLClass("HTMLSourceElement");
const HTMLDivElement = defineHTMLClass("HTMLDivElement");
const HTMLSpanElement = defineHTMLClass("HTMLSpanElement");
const HTMLParagraphElement = defineHTMLClass("HTMLParagraphElement");
const HTMLHeadingElement = defineHTMLClass("HTMLHeadingElement");
const HTMLBodyElement = defineHTMLClass("HTMLBodyElement");
const HTMLHtmlElement = defineHTMLClass("HTMLHtmlElement");
const HTMLHeadElement = defineHTMLClass("HTMLHeadElement");
const HTMLTitleElement = defineHTMLClass("HTMLTitleElement");
const HTMLScriptElement = defineHTMLClass("HTMLScriptElement");
const HTMLLinkElement = defineHTMLClass("HTMLLinkElement");
const HTMLMetaElement = defineHTMLClass("HTMLMetaElement");
const HTMLStyleElement = defineHTMLClass("HTMLStyleElement");
const HTMLBaseElement = defineHTMLClass("HTMLBaseElement");
const HTMLBRElement = defineHTMLClass("HTMLBRElement");
const HTMLHRElement = defineHTMLClass("HTMLHRElement");
const HTMLPreElement = defineHTMLClass("HTMLPreElement");
const HTMLQuoteElement = defineHTMLClass("HTMLQuoteElement");
const HTMLUListElement = defineHTMLClass("HTMLUListElement");
const HTMLOListElement = defineHTMLClass("HTMLOListElement");
const HTMLLIElement = defineHTMLClass("HTMLLIElement");
const HTMLDListElement = defineHTMLClass("HTMLDListElement");
const HTMLMenuElement = defineHTMLClass("HTMLMenuElement");
const HTMLTableCaptionElement = defineHTMLClass("HTMLTableCaptionElement");
const HTMLTableColElement = defineHTMLClass("HTMLTableColElement");
const HTMLTemplateElement = defineHTMLClass("HTMLTemplateElement");
const HTMLTimeElement = defineHTMLClass("HTMLTimeElement");
const HTMLDetailsElement = defineHTMLClass("HTMLDetailsElement");
const HTMLDialogElement = defineHTMLClass("HTMLDialogElement");
const HTMLModElement = defineHTMLClass("HTMLModElement"); // <ins>, <del>
const HTMLDataElement = defineHTMLClass("HTMLDataElement");
const HTMLMapElement = defineHTMLClass("HTMLMapElement");
const HTMLTrackElement = defineHTMLClass("HTMLTrackElement");
const HTMLParamElement = defineHTMLClass("HTMLParamElement");
const HTMLDirectoryElement = defineHTMLClass("HTMLDirectoryElement");
const HTMLFontElement = defineHTMLClass("HTMLFontElement");
const HTMLFrameElement = defineHTMLClass("HTMLFrameElement");
const HTMLFrameSetElement = defineHTMLClass("HTMLFrameSetElement");
const HTMLMarqueeElement = defineHTMLClass("HTMLMarqueeElement");

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
