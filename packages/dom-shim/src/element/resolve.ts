// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Selects an element wrapper class from its HTML tag and namespace.

import { HTMLElement } from "./html-element.js";
import { htmlInterfaceTag } from "./html-tag.js";
import { HTMLInputElement } from "./forms/input.js";
import { HTMLTextAreaElement } from "./forms/textarea.js";
import { HTMLSelectElement, HTMLOptionElement, HTMLOptGroupElement } from "./forms/select.js";
import { HTMLButtonElement } from "./forms/button.js";
import { HTMLLabelElement } from "./forms/label.js";
import { HTMLFieldSetElement, HTMLLegendElement } from "./forms/fieldset.js";
import { HTMLOutputElement } from "./forms/output.js";
import { HTMLFormElement } from "./forms/form.js";
import { HTMLProgressElement, HTMLMeterElement } from "./forms/meter.js";
import { HTMLImageElement } from "./image.js";
import {
  HTMLDataListElement,
  HTMLAnchorElement,
  HTMLAreaElement,
  HTMLPictureElement,
  HTMLSourceElement,
  HTMLTrackElement,
  HTMLParamElement,
  HTMLMapElement,
  HTMLDirectoryElement,
  HTMLFontElement,
  HTMLFrameElement,
  HTMLFrameSetElement,
  HTMLMarqueeElement,
  HTMLDivElement,
  HTMLSpanElement,
  HTMLParagraphElement,
  HTMLHeadingElement,
  HTMLBodyElement,
  HTMLHtmlElement,
  HTMLHeadElement,
  HTMLTitleElement,
  HTMLScriptElement,
  HTMLLinkElement,
  HTMLMetaElement,
  HTMLStyleElement,
  HTMLBaseElement,
  HTMLBRElement,
  HTMLHRElement,
  HTMLPreElement,
  HTMLQuoteElement,
  HTMLUListElement,
  HTMLOListElement,
  HTMLLIElement,
  HTMLDListElement,
  HTMLMenuElement,
  HTMLTableCaptionElement,
  HTMLTableColElement,
  HTMLTemplateElement,
  HTMLTimeElement,
  HTMLDetailsElement,
  HTMLDialogElement,
  HTMLModElement,
  HTMLDataElement,
  HTMLUnknownElement,
} from "./html-classes.js";
import { HTMLSlotElement } from "./shadow.js";
import { HTMLCanvasElement } from "./canvas.js";
import { HTMLIFrameElement, HTMLEmbedElement, HTMLObjectElement } from "./embedded.js";
import { HTMLAudioElement, HTMLVideoElement } from "./media.js";
import {
  HTMLTableElement,
  HTMLTableSectionElement,
  HTMLTableRowElement,
  HTMLTableCellElement,
} from "./table.js";

type ElementClass = new (
  nodeId: number,
  info: unknown,
  token: typeof import("./html-element.js").InternalElementCtorToken,
) => HTMLElement;

const TAG_TO_CLASS: Record<string, ElementClass> = Object.create(null);
TAG_TO_CLASS["input"] = HTMLInputElement;
TAG_TO_CLASS["textarea"] = HTMLTextAreaElement;
TAG_TO_CLASS["select"] = HTMLSelectElement;
TAG_TO_CLASS["option"] = HTMLOptionElement;
TAG_TO_CLASS["optgroup"] = HTMLOptGroupElement;
TAG_TO_CLASS["button"] = HTMLButtonElement;
TAG_TO_CLASS["form"] = HTMLFormElement;
TAG_TO_CLASS["label"] = HTMLLabelElement;
TAG_TO_CLASS["fieldset"] = HTMLFieldSetElement;
TAG_TO_CLASS["legend"] = HTMLLegendElement;
TAG_TO_CLASS["output"] = HTMLOutputElement;
TAG_TO_CLASS["datalist"] = HTMLDataListElement;
TAG_TO_CLASS["progress"] = HTMLProgressElement;
TAG_TO_CLASS["meter"] = HTMLMeterElement;
TAG_TO_CLASS["a"] = HTMLAnchorElement;
TAG_TO_CLASS["area"] = HTMLAreaElement;
TAG_TO_CLASS["img"] = HTMLImageElement;
TAG_TO_CLASS["picture"] = HTMLPictureElement;
TAG_TO_CLASS["source"] = HTMLSourceElement;
TAG_TO_CLASS["video"] = HTMLVideoElement;
TAG_TO_CLASS["audio"] = HTMLAudioElement;
TAG_TO_CLASS["track"] = HTMLTrackElement;
TAG_TO_CLASS["canvas"] = HTMLCanvasElement;
TAG_TO_CLASS["embed"] = HTMLEmbedElement;
TAG_TO_CLASS["object"] = HTMLObjectElement;
TAG_TO_CLASS["param"] = HTMLParamElement;
TAG_TO_CLASS["map"] = HTMLMapElement;
TAG_TO_CLASS["dir"] = HTMLDirectoryElement;
TAG_TO_CLASS["font"] = HTMLFontElement;
TAG_TO_CLASS["frame"] = HTMLFrameElement;
TAG_TO_CLASS["frameset"] = HTMLFrameSetElement;
TAG_TO_CLASS["marquee"] = HTMLMarqueeElement;
TAG_TO_CLASS["div"] = HTMLDivElement;
TAG_TO_CLASS["span"] = HTMLSpanElement;
TAG_TO_CLASS["p"] = HTMLParagraphElement;
TAG_TO_CLASS["h1"] = HTMLHeadingElement;
TAG_TO_CLASS["h2"] = HTMLHeadingElement;
TAG_TO_CLASS["h3"] = HTMLHeadingElement;
TAG_TO_CLASS["h4"] = HTMLHeadingElement;
TAG_TO_CLASS["h5"] = HTMLHeadingElement;
TAG_TO_CLASS["h6"] = HTMLHeadingElement;
TAG_TO_CLASS["body"] = HTMLBodyElement;
TAG_TO_CLASS["html"] = HTMLHtmlElement;
TAG_TO_CLASS["head"] = HTMLHeadElement;
TAG_TO_CLASS["title"] = HTMLTitleElement;
TAG_TO_CLASS["script"] = HTMLScriptElement;
TAG_TO_CLASS["link"] = HTMLLinkElement;
TAG_TO_CLASS["meta"] = HTMLMetaElement;
TAG_TO_CLASS["style"] = HTMLStyleElement;
TAG_TO_CLASS["base"] = HTMLBaseElement;
TAG_TO_CLASS["br"] = HTMLBRElement;
TAG_TO_CLASS["hr"] = HTMLHRElement;
TAG_TO_CLASS["pre"] = HTMLPreElement;
TAG_TO_CLASS["listing"] = HTMLPreElement;
TAG_TO_CLASS["xmp"] = HTMLPreElement;
TAG_TO_CLASS["blockquote"] = HTMLQuoteElement;
TAG_TO_CLASS["q"] = HTMLQuoteElement;
TAG_TO_CLASS["ul"] = HTMLUListElement;
TAG_TO_CLASS["ol"] = HTMLOListElement;
TAG_TO_CLASS["li"] = HTMLLIElement;
TAG_TO_CLASS["dl"] = HTMLDListElement;
TAG_TO_CLASS["menu"] = HTMLMenuElement;
TAG_TO_CLASS["table"] = HTMLTableElement;
TAG_TO_CLASS["tr"] = HTMLTableRowElement;
TAG_TO_CLASS["td"] = HTMLTableCellElement;
TAG_TO_CLASS["th"] = HTMLTableCellElement;
TAG_TO_CLASS["thead"] = HTMLTableSectionElement;
TAG_TO_CLASS["tbody"] = HTMLTableSectionElement;
TAG_TO_CLASS["tfoot"] = HTMLTableSectionElement;
TAG_TO_CLASS["caption"] = HTMLTableCaptionElement;
TAG_TO_CLASS["col"] = HTMLTableColElement;
TAG_TO_CLASS["colgroup"] = HTMLTableColElement;
TAG_TO_CLASS["iframe"] = HTMLIFrameElement;
TAG_TO_CLASS["template"] = HTMLTemplateElement;
TAG_TO_CLASS["slot"] = HTMLSlotElement;
TAG_TO_CLASS["time"] = HTMLTimeElement;
TAG_TO_CLASS["details"] = HTMLDetailsElement;
TAG_TO_CLASS["dialog"] = HTMLDialogElement;
TAG_TO_CLASS["ins"] = HTMLModElement;
TAG_TO_CLASS["del"] = HTMLModElement;
TAG_TO_CLASS["data"] = HTMLDataElement;

const KNOWN_PLAIN_TAGS = new Set([
  "abbr",
  "acronym",
  "address",
  "article",
  "aside",
  "b",
  "basefont",
  "bdi",
  "bdo",
  "big",
  "center",
  "cite",
  "code",
  "dd",
  "dfn",
  "dt",
  "em",
  "figcaption",
  "figure",
  "footer",
  "header",
  "hgroup",
  "i",
  "kbd",
  "main",
  "mark",
  "nav",
  "nobr",
  "noembed",
  "noframes",
  "noscript",
  "plaintext",
  "rb",
  "rp",
  "rt",
  "rtc",
  "ruby",
  "s",
  "samp",
  "section",
  "small",
  "strike",
  "strong",
  "sub",
  "summary",
  "sup",
  "tt",
  "u",
  "var",
  "wbr",
  "search",
]);
const VALID_CUSTOM_NAME_RE = /^[a-z][a-z0-9._-]*-[a-z0-9._-]*$/;
function resolveElementClass(localName: string, namespaceURI: string | null): ElementClass {
  const tag = htmlInterfaceTag(localName, namespaceURI);
  if (tag === null) return HTMLElement;
  return resolveHtmlElementClass(tag, localName);
}

function resolveHtmlElementClass(tag: string, localName: string): ElementClass {
  const raw = String(localName || "");
  const mapped = TAG_TO_CLASS[tag];
  if (mapped) return mapped;
  if (KNOWN_PLAIN_TAGS.has(tag)) return HTMLElement;
  if (VALID_CUSTOM_NAME_RE.test(raw)) return HTMLElement;
  return HTMLUnknownElement;
}

export { resolveElementClass };
