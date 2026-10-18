// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements HTMLImageElement attributes and connects images to load-state handling.

import type * as Idl from "../idl/types.generated.js";
import { nodeScrollInfoSafe } from "../layout/scroll.js";
import {
  defineReflectedBoolean,
  defineReflectedCrossOrigin,
  defineReflectedEnum,
  defineReflectedEnumWithDefaults,
  defineReflectedString,
  defineReflectedStringNullEmpty,
  defineReflectedUnsignedLong,
  defineReflectedUrl,
  htmlParseInteger,
  REFERRER_POLICY_KEYWORDS,
} from "./reflect.js";
import {
  imageNaturalSizeFor,
  invalidateImageLoadStateFor,
  pendingImageReloads,
  imageLoadResults,
} from "./load-events.js";
import { attributeChangeSteps } from "./element.js";
import { HTMLElement, checkInternalConstruct } from "./html-element.js";

// The reflections below the class install these.
type ReflectedImageMember =
  | "alt"
  | "srcset"
  | "crossOrigin"
  | "useMap"
  | "isMap"
  | "referrerPolicy"
  | "decoding"
  | "loading"
  | "fetchPriority"
  | "name"
  | "lowsrc"
  | "align"
  | "hspace"
  | "vspace"
  | "longDesc"
  | "border";
interface HTMLImageElement extends Pick<Idl.HTMLImageElement, ReflectedImageMember> {
  get sizes(): Idl.HTMLImageElement["sizes"];
  set sizes(value: Idl.HTMLImageElement["sizes"]);
}

// src comes from Element, so it is inherited rather than an own member of
// this prototype. The image sizes reflection replaces Element's shared <link>
// accessor at runtime, but the installer cannot narrow the inherited type.
class HTMLImageElement extends HTMLElement implements Idl.HTMLImageElement {
  constructor(nodeId: number, info: unknown, token?: symbol) {
    super(nodeId, info);
    checkInternalConstruct(token, "HTMLImageElement");
  }
  get width() {
    return imageDimension(this, "width", 0);
  }
  set width(v) {
    setImageDimension(this, "width", v);
  }
  get height() {
    return imageDimension(this, "height", 1);
  }
  set height(v) {
    setImageDimension(this, "height", v);
  }
  get naturalWidth() {
    return imageNaturalSizeFor(this)?.[0] ?? 0;
  }
  get naturalHeight() {
    return imageNaturalSizeFor(this)?.[1] ?? 0;
  }
  get complete() {
    // Broken and decoded requests are complete; pending reloads are not.
    // https://html.spec.whatwg.org/#dom-img-complete
    if (!hasImageSource(this)) return true;
    if (pendingImageReloads.has(this._id)) return false;
    if (imageNaturalSizeFor(this)) return true;
    return imageLoadResults.has(this._id);
  }
  get currentSrc() {
    // Limitation: Blitz does not expose the selected srcset candidate.
    try {
      return this.src || "";
    } catch {
      return "";
    }
  }
  decode(): Promise<void> {
    // Reuse the synthetic load result because the shim has no decoder promise.
    const reloading = pendingImageReloads.has(this._id);
    if (!reloading && imageNaturalSizeFor(this)) return Promise.resolve();
    if (!reloading && imageLoadResults.get(this._id) === false) {
      return Promise.reject(decodeError());
    }
    if (!hasImageSource(this)) return Promise.reject(decodeError());
    return new Promise((resolve, reject) => {
      const onLoad = () => {
        this.removeEventListener("error", onError);
        resolve();
      };
      const onError = () => {
        this.removeEventListener("load", onLoad);
        reject(decodeError());
      };
      this.addEventListener("load", onLoad, { once: true });
      this.addEventListener("error", onError, { once: true });
    });
  }
  [attributeChangeSteps](localName: string, value: string | null): void {
    super[attributeChangeSteps](localName, value);
    // Limitation: only src and srcset reset img load state here.
    // https://html.spec.whatwg.org/#relevant-mutations
    if (localName === "src" || localName === "srcset") invalidateImageLoadStateFor(this);
  }
}

function hasImageSource(el: HTMLImageElement): boolean {
  let src: string | null = null;
  let srcset: string | null = null;
  try {
    src = el.getAttribute("src");
  } catch {}
  try {
    srcset = el.getAttribute("srcset");
  } catch {}
  return (src !== null && src !== "") || (srcset !== null && srcset !== "");
}

function decodeError(): Error {
  try {
    return new DOMException("The source image cannot be decoded.", "EncodingError");
  } catch {
    return new Error("The source image cannot be decoded.");
  }
}

// Rendered images report their layout size; unrendered ones use attributes.
// https://html.spec.whatwg.org/#dom-img-width
function imageDimension(el: HTMLImageElement, attrName: "width" | "height", axis: 0 | 1): number {
  const info = nodeScrollInfoSafe(el._id);
  if (info && info.hasBox) {
    return Math.round(axis === 0 ? info.contentWidth : info.contentHeight);
  }
  const raw = el.getAttribute(attrName);
  if (raw != null) {
    const n = htmlParseInteger(raw);
    if (n != null && n >= 0) return n;
  }
  return imageNaturalSizeFor(el)?.[axis] ?? 0;
}
function setImageDimension(
  el: HTMLImageElement,
  attrName: "width" | "height",
  value: number,
): void {
  const u = value >>> 0;
  el.setAttribute(attrName, String(u > 2147483647 ? 0 : u));
}

defineReflectedString(HTMLImageElement.prototype, "alt", "alt");
defineReflectedStringNullEmpty(HTMLImageElement.prototype, "border", "border");
defineReflectedUrl(HTMLImageElement.prototype, "longDesc", "longdesc");
defineReflectedString(HTMLImageElement.prototype, "name", "name");
defineReflectedString(HTMLImageElement.prototype, "sizes", "sizes");
defineReflectedString(HTMLImageElement.prototype, "srcset", "srcset");
defineReflectedString(HTMLImageElement.prototype, "useMap", "usemap");
defineReflectedEnumWithDefaults(
  HTMLImageElement.prototype,
  "decoding",
  "decoding",
  ["sync", "async", "auto"],
  "auto",
  "auto",
);
defineReflectedEnumWithDefaults(
  HTMLImageElement.prototype,
  "loading",
  "loading",
  ["eager", "lazy"],
  "eager",
  "eager",
);
defineReflectedBoolean(HTMLImageElement.prototype, "isMap", "ismap");
defineReflectedUnsignedLong(HTMLImageElement.prototype, "hspace", "hspace", 0);
defineReflectedUnsignedLong(HTMLImageElement.prototype, "vspace", "vspace", 0);
defineReflectedUrl(HTMLImageElement.prototype, "lowsrc", "lowsrc");
defineReflectedEnum(
  HTMLImageElement.prototype,
  "referrerPolicy",
  "referrerpolicy",
  REFERRER_POLICY_KEYWORDS,
);
defineReflectedCrossOrigin(HTMLImageElement.prototype);
defineReflectedString(HTMLImageElement.prototype, "align", "align");
defineReflectedEnumWithDefaults(
  HTMLImageElement.prototype,
  "fetchPriority",
  "fetchpriority",
  ["high", "low", "auto"],
  "auto",
  "auto",
);

export { HTMLImageElement };
