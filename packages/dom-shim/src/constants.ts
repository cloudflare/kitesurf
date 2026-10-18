// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Shared DOM node, namespace, viewport, and traversal constants used by the shim.

export const ELEMENT_NODE = 1;
export const ATTRIBUTE_NODE = 2;
export const TEXT_NODE = 3;
export const CDATA_SECTION_NODE = 4;
export const ENTITY_REFERENCE_NODE = 5;
export const ENTITY_NODE = 6;
export const PROCESSING_INSTRUCTION_NODE = 7;
export const COMMENT_NODE = 8;
export const DOCUMENT_NODE = 9;
export const DOCTYPE_NODE = 10;
export const DOCUMENT_FRAGMENT_NODE = 11;
export const NOTATION_NODE = 12;

export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const MS_PER_DAY = 24 * MS_PER_HOUR;
export const MS_PER_WEEK = 7 * MS_PER_DAY;
export const STEP_ALIGNMENT_EPSILON = 1e-9;

export const HTML_NS = "http://www.w3.org/1999/xhtml";
export const SVG_NS = "http://www.w3.org/2000/svg";
export const MATHML_NS = "http://www.w3.org/1998/Math/MathML";

export const DEFAULT_VIEWPORT_WIDTH_CSS_PX = 1280;
export const DEFAULT_VIEWPORT_HEIGHT_CSS_PX = 720;

export const MAX_NODE_ANCESTOR_HOPS = 4096;
export const MAX_SHADOW_ROOT_HOPS = 64;
export const MAX_SCROLL_CHAIN_HOPS = 64;

export const DOCUMENT_POSITION_DISCONNECTED = 0x01;
export const DOCUMENT_POSITION_PRECEDING = 0x02;
export const DOCUMENT_POSITION_FOLLOWING = 0x04;
export const DOCUMENT_POSITION_CONTAINS = 0x08;
export const DOCUMENT_POSITION_CONTAINED_BY = 0x10;
export const DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC = 0x20;

export const REL_SUPPORTED = new Set([
  "noreferrer",
  "noopener",
  "opener",
  "alternate",
  "author",
  "canonical",
  "dns-prefetch",
  "expect",
  "help",
  "icon",
  "license",
  "manifest",
  "modulepreload",
  "next",
  "pingback",
  "preconnect",
  "prefetch",
  "preload",
  "prerender",
  "prev",
  "search",
  "stylesheet",
  "tag",
  "bookmark",
  "nofollow",
  "external",
  "privacy-policy",
  "terms-of-service",
]);
export const SANDBOX_SUPPORTED = new Set([
  "allow-downloads",
  "allow-forms",
  "allow-modals",
  "allow-orientation-lock",
  "allow-pointer-lock",
  "allow-popups",
  "allow-popups-to-escape-sandbox",
  "allow-presentation",
  "allow-same-origin",
  "allow-scripts",
  "allow-storage-access-by-user-activation",
  "allow-top-navigation",
  "allow-top-navigation-by-user-activation",
  "allow-top-navigation-to-custom-protocols",
]);

export const NS_MSG = "kitesurf: not yet supported in this sandbox (Day 6)";

export const GET_COMPUTED_STYLE_INTERNAL = Symbol("kitesurf.getComputedStyleInternal");

export function notSupported(prop: string): TypeError {
  return new TypeError(NS_MSG + " (tried to set/call '" + prop + "')");
}
