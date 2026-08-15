// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Installs per-tag reflected attributes and event-handler properties on HTML prototypes.

import { parseUrlForNode } from "../text-encoding.js";
import { WINDOW_EVENT_HANDLERS } from "../event-handler-names.js";
import {
  defineAttribute,
  defineReflectedEnum,
  defineReflectedCrossOrigin,
  defineReflectedString,
  defineReflectedUrl,
  defineReflectedBoolean,
  defineReflectedStringNullEmpty,
  defineReflectedEnumWithDefaults,
  defineReflectedLong,
  defineReflectedUnsignedLong,
  REFERRER_POLICY_KEYWORDS,
} from "./reflect.js";
import { installIdlHandlersOn } from "./event-handlers.js";
import { HTMLInputElement } from "./forms/input.js";
import { HTMLLegendElement } from "./forms/fieldset.js";
import {
  HTMLDetailsElement,
  HTMLAnchorElement,
  HTMLAreaElement,
  HTMLLinkElement,
  HTMLScriptElement,
  HTMLTableCaptionElement,
  HTMLTableColElement,
  HTMLDivElement,
  HTMLHeadingElement,
  HTMLHRElement,
  HTMLParagraphElement,
  HTMLQuoteElement,
  HTMLModElement,
  HTMLTimeElement,
  HTMLDListElement,
  HTMLDirectoryElement,
  HTMLMenuElement,
  HTMLOListElement,
  HTMLUListElement,
  HTMLDialogElement,
  HTMLMetaElement,
  HTMLStyleElement,
  HTMLBaseElement,
  HTMLHtmlElement,
  HTMLBodyElement,
  HTMLMapElement,
  HTMLLIElement,
  HTMLPreElement,
  HTMLMarqueeElement,
  HTMLFontElement,
  HTMLBRElement,
  HTMLFrameElement,
  HTMLFrameSetElement,
  HTMLDataElement,
  HTMLTitleElement,
} from "./html-classes.js";
import { HTMLSlotElement } from "./shadow.js";
import { HTMLIFrameElement, HTMLEmbedElement, HTMLObjectElement } from "./embedded.js";
import { HTMLMediaElement, HTMLAudioElement, HTMLVideoElement } from "./media.js";
import {
  HTMLTableElement,
  HTMLTableSectionElement,
  HTMLTableRowElement,
  HTMLTableCellElement,
} from "./table.js";

defineReflectedString(HTMLDetailsElement.prototype, "name", "name");

// Image uses the same shared policy keyword set in image.ts.
for (const cls of [
  HTMLAnchorElement,
  HTMLAreaElement,
  HTMLIFrameElement,
  HTMLLinkElement,
  HTMLScriptElement,
]) {
  defineReflectedEnum(cls.prototype, "referrerPolicy", "referrerpolicy", REFERRER_POLICY_KEYWORDS);
}
for (const cls of [
  HTMLScriptElement,
  HTMLLinkElement,
  HTMLMediaElement,
  HTMLAudioElement,
  HTMLVideoElement,
]) {
  defineReflectedCrossOrigin(cls.prototype);
}

for (const cls of [
  HTMLTableCaptionElement,
  HTMLTableColElement,
  HTMLDivElement,
  HTMLEmbedElement,
  HTMLHeadingElement,
  HTMLHRElement,
  HTMLIFrameElement,
  HTMLInputElement,
  HTMLLegendElement,
  HTMLObjectElement,
  HTMLParagraphElement,
  HTMLTableElement,
  HTMLTableSectionElement,
  HTMLTableRowElement,
  HTMLTableCellElement,
]) {
  defineReflectedString(cls.prototype, "align", "align");
}

defineReflectedUrl(HTMLQuoteElement.prototype, "cite", "cite");
defineReflectedUrl(HTMLModElement.prototype, "cite", "cite");
defineReflectedString(HTMLModElement.prototype, "dateTime", "datetime");
defineReflectedString(HTMLTimeElement.prototype, "dateTime", "datetime");

for (const cls of [
  HTMLDListElement,
  HTMLDirectoryElement,
  HTMLMenuElement,
  HTMLOListElement,
  HTMLUListElement,
]) {
  defineReflectedBoolean(cls.prototype, "compact", "compact");
}

defineReflectedBoolean(HTMLHRElement.prototype, "noShade", "noshade");

defineReflectedBoolean(HTMLDetailsElement.prototype, "open", "open");
defineReflectedBoolean(HTMLDialogElement.prototype, "open", "open");

defineReflectedBoolean(HTMLScriptElement.prototype, "defer", "defer");
defineReflectedBoolean(HTMLScriptElement.prototype, "noModule", "nomodule");
defineReflectedString(HTMLScriptElement.prototype, "integrity", "integrity");
defineReflectedString(HTMLScriptElement.prototype, "charset", "charset");
defineReflectedString(HTMLScriptElement.prototype, "event", "event");
defineReflectedString(HTMLScriptElement.prototype, "htmlFor", "for");

Object.defineProperty(HTMLScriptElement, "supports", {
  configurable: true,
  writable: true,
  enumerable: true,
  value: function supports(type: unknown) {
    const t = String(type);
    return t === "classic" || t === "module" || t === "importmap";
  },
});

// Pre-ES6 loaders build inline scripts with `el.text = code`. Without `text`
// the script inserted with no source and never ran. Unlike textContent, the
// setter takes a plain DOMString, so null sets the text "null".
defineAttribute(HTMLScriptElement.prototype, "text", {
  get() {
    return this.textContent ?? "";
  },
  set(v) {
    this.textContent = String(v);
  },
});

defineReflectedEnum(HTMLLinkElement.prototype, "as", "as", [
  "fetch",
  "audio",
  "audioworklet",
  "document",
  "embed",
  "font",
  "frame",
  "iframe",
  "image",
  "json",
  "manifest",
  "object",
  "paintworklet",
  "report",
  "script",
  "serviceworker",
  "sharedworker",
  "style",
  "track",
  "video",
  "webidentity",
  "worker",
  "xslt",
]);
defineReflectedString(HTMLLinkElement.prototype, "integrity", "integrity");
defineReflectedString(HTMLLinkElement.prototype, "type", "type");
defineReflectedString(HTMLLinkElement.prototype, "media", "media");
defineReflectedString(HTMLLinkElement.prototype, "hreflang", "hreflang");
defineReflectedString(HTMLLinkElement.prototype, "charset", "charset");
defineReflectedString(HTMLLinkElement.prototype, "rev", "rev");
defineReflectedString(HTMLLinkElement.prototype, "target", "target");
defineReflectedString(HTMLLinkElement.prototype, "rel", "rel");

defineReflectedString(HTMLMetaElement.prototype, "name", "name");
defineReflectedString(HTMLMetaElement.prototype, "content", "content");
defineReflectedString(HTMLMetaElement.prototype, "httpEquiv", "http-equiv");
defineReflectedString(HTMLMetaElement.prototype, "scheme", "scheme");
defineReflectedString(HTMLMetaElement.prototype, "media", "media");

defineReflectedString(HTMLStyleElement.prototype, "media", "media");
defineReflectedString(HTMLStyleElement.prototype, "type", "type");

defineReflectedString(HTMLBaseElement.prototype, "target", "target");

defineReflectedString(HTMLHtmlElement.prototype, "version", "version");

defineReflectedStringNullEmpty(HTMLBodyElement.prototype, "aLink", "alink");
defineReflectedStringNullEmpty(HTMLBodyElement.prototype, "bgColor", "bgcolor");
defineReflectedString(HTMLBodyElement.prototype, "background", "background");
defineReflectedStringNullEmpty(HTMLBodyElement.prototype, "link", "link");
defineReflectedStringNullEmpty(HTMLBodyElement.prototype, "text", "text");
defineReflectedStringNullEmpty(HTMLBodyElement.prototype, "vLink", "vlink");

for (const cls of [HTMLAnchorElement, HTMLAreaElement]) {
  defineReflectedString(cls.prototype, "target", "target");
  defineReflectedString(cls.prototype, "rel", "rel");
  defineReflectedString(cls.prototype, "ping", "ping");
  defineReflectedString(cls.prototype, "hreflang", "hreflang");
  defineReflectedString(cls.prototype, "type", "type");
  defineReflectedString(cls.prototype, "coords", "coords");
  defineReflectedString(cls.prototype, "shape", "shape");
  defineReflectedString(cls.prototype, "charset", "charset");
  defineReflectedString(cls.prototype, "rev", "rev");
}
defineReflectedString(HTMLAnchorElement.prototype, "name", "name");
defineReflectedString(HTMLAnchorElement.prototype, "download", "download");
defineReflectedString(HTMLAreaElement.prototype, "download", "download");
defineReflectedString(HTMLAreaElement.prototype, "alt", "alt");
defineReflectedBoolean(HTMLAreaElement.prototype, "noHref", "nohref");

for (const cls of [HTMLLinkElement, HTMLScriptElement, HTMLIFrameElement]) {
  defineReflectedEnumWithDefaults(
    cls.prototype,
    "fetchPriority",
    "fetchpriority",
    ["high", "low", "auto"],
    "auto",
    "auto",
  );
}

defineReflectedString(HTMLMapElement.prototype, "name", "name");

defineReflectedString(HTMLHRElement.prototype, "color", "color");
defineReflectedString(HTMLHRElement.prototype, "size", "size");
defineReflectedString(HTMLHRElement.prototype, "width", "width");

defineReflectedLong(HTMLLIElement.prototype, "value", "value", 0);
defineReflectedString(HTMLLIElement.prototype, "type", "type");

defineReflectedBoolean(HTMLOListElement.prototype, "reversed", "reversed");
defineReflectedLong(HTMLOListElement.prototype, "start", "start", 1);
defineReflectedString(HTMLOListElement.prototype, "type", "type");

defineReflectedString(HTMLUListElement.prototype, "type", "type");

defineReflectedLong(HTMLPreElement.prototype, "width", "width", 0);

defineReflectedUnsignedLong(HTMLMarqueeElement.prototype, "scrollDelay", "scrolldelay", 85);
defineReflectedUnsignedLong(HTMLMarqueeElement.prototype, "scrollAmount", "scrollamount", 6);
defineReflectedLong(HTMLMarqueeElement.prototype, "loop", "loop", -1);

defineReflectedStringNullEmpty(HTMLFontElement.prototype, "color", "color");
defineReflectedString(HTMLFontElement.prototype, "face", "face");
defineReflectedString(HTMLFontElement.prototype, "size", "size");

defineReflectedString(HTMLBRElement.prototype, "clear", "clear");

defineReflectedString(HTMLMarqueeElement.prototype, "behavior", "behavior");
defineReflectedString(HTMLMarqueeElement.prototype, "bgColor", "bgcolor");
defineReflectedString(HTMLMarqueeElement.prototype, "direction", "direction");
defineReflectedString(HTMLMarqueeElement.prototype, "height", "height");
defineReflectedUnsignedLong(HTMLMarqueeElement.prototype, "hspace", "hspace", 0);
defineReflectedUnsignedLong(HTMLMarqueeElement.prototype, "vspace", "vspace", 0);
defineReflectedString(HTMLMarqueeElement.prototype, "width", "width");
defineReflectedBoolean(HTMLMarqueeElement.prototype, "trueSpeed", "truespeed");

defineReflectedString(HTMLFrameElement.prototype, "frameBorder", "frameborder");
defineReflectedUrl(HTMLFrameElement.prototype, "longDesc", "longdesc");
defineReflectedStringNullEmpty(HTMLFrameElement.prototype, "marginHeight", "marginheight");
defineReflectedStringNullEmpty(HTMLFrameElement.prototype, "marginWidth", "marginwidth");
defineReflectedString(HTMLFrameElement.prototype, "name", "name");
defineReflectedString(HTMLFrameElement.prototype, "scrolling", "scrolling");
defineReflectedBoolean(HTMLFrameElement.prototype, "noResize", "noresize");
defineReflectedString(HTMLFrameSetElement.prototype, "cols", "cols");
defineReflectedString(HTMLFrameSetElement.prototype, "rows", "rows");

defineReflectedString(HTMLDataElement.prototype, "value", "value");

defineReflectedString(HTMLSlotElement.prototype, "name", "name");

defineAttribute(HTMLTitleElement.prototype, "text", {
  get() {
    return this.textContent || "";
  },
  set(v) {
    this.textContent = String(v);
  },
});

defineReflectedString(HTMLLinkElement.prototype, "imageSrcset", "imagesrcset");
defineReflectedString(HTMLLinkElement.prototype, "imageSizes", "imagesizes");
// blocking returns an array-like stub, not a DOMTokenList. That makes it a
// type gap (idl/type-gaps.json), so the generated types have no blocking
// member for defineAttribute to check against.
type BlockingStub = string[] & {
  value: string;
  contains(token: string): boolean;
  add(...tokens: string[]): void;
  remove(...tokens: string[]): void;
  replace(token: string, newToken: string): undefined;
  supports(token: string): boolean;
  toggle(token: string, force?: boolean): boolean;
};

function blockingStub(): BlockingStub {
  const arr: string[] = [];
  return Object.assign(arr, {
    value: "",
    contains: (_token: string) => false,
    add: (..._tokens: string[]) => {},
    remove: (..._tokens: string[]) => {},
    replace: () => undefined,
    supports: (_token: string) => false,
    toggle: () => false,
  });
}
for (const proto of [
  HTMLLinkElement.prototype,
  HTMLStyleElement.prototype,
  HTMLScriptElement.prototype,
]) {
  Object.defineProperty(proto, "blocking", {
    configurable: true,
    enumerable: true,
    get() {
      return blockingStub();
    },
  });
}

installIdlHandlersOn(HTMLBodyElement.prototype, WINDOW_EVENT_HANDLERS);
installIdlHandlersOn(HTMLFrameSetElement.prototype, WINDOW_EVENT_HANDLERS);

// URL components on anchors and areas resolve href against baseURI.
// Setters update the resolved URL and write it back to the href attribute.
// https://html.spec.whatwg.org/#htmlhyperlinkelementutils
type UrlPart =
  | "protocol"
  | "username"
  | "password"
  | "host"
  | "hostname"
  | "port"
  | "pathname"
  | "search"
  | "hash";
const URL_PARTS: readonly UrlPart[] = [
  "protocol",
  "username",
  "password",
  "host",
  "hostname",
  "port",
  "pathname",
  "search",
  "hash",
];
function installUrlDecomposition(
  proto: InstanceType<typeof HTMLAnchorElement> | InstanceType<typeof HTMLAreaElement>,
): void {
  for (const propName of URL_PARTS) {
    defineAttribute(proto, propName, {
      get() {
        const raw = this.getAttribute("href");
        if (raw == null) return "";
        try {
          return parseUrlForNode(this, raw, this.baseURI || undefined)[propName];
        } catch {
          return propName === "protocol" ? ":" : "";
        }
      },
      set(value) {
        const raw = this.getAttribute("href");
        if (raw == null) return; // spec: no-op when href absent
        try {
          const u = parseUrlForNode(this, raw, this.baseURI || undefined);
          u[propName] = String(value);
          this.setAttribute("href", u.toString());
        } catch {
          // Invalid initial URL — silently no-op. Pages that rely
          // on these setters for canonicalisation expect lenient
          // behaviour here.
        }
      },
    });
  }
  // origin is readonly per spec.
  defineAttribute(proto, "origin", {
    get() {
      const raw = this.getAttribute("href");
      if (raw == null) return "";
      try {
        return parseUrlForNode(this, raw, this.baseURI || undefined).origin;
      } catch {
        return "";
      }
    },
  });
}
installUrlDecomposition(HTMLAnchorElement.prototype);
installUrlDecomposition(HTMLAreaElement.prototype);
