// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Parses the HTML iframe `sandbox` attribute into the capabilities this engine enforces.
// https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox

import type { SandboxRestrictions } from "@kitesurf/jsrpc-types/sandbox";

export type { SandboxRestrictions };

// A missing attribute imposes no restrictions; an empty one imposes every restriction.
export const SANDBOX_ALLOW_ALL: SandboxRestrictions = Object.freeze({
  scripts: true,
  sameOrigin: true,
  forms: true,
  topNavigation: true,
});

// allow-popups, allow-top-navigation-by-user-activation and the other unmodeled tokens grant
// nothing: this engine has no popup or user-activation path, so leaving them blocked fails closed.
const TOKEN_FIELDS = new Map<string, keyof SandboxRestrictions>([
  ["allow-scripts", "scripts"],
  ["allow-same-origin", "sameOrigin"],
  ["allow-forms", "forms"],
  ["allow-top-navigation", "topNavigation"],
]);

// A page controls this attribute, so bound the work: no modeled token is longer than 20 characters
// and 64 tokens cover every capability, while an unknown token grants nothing either way.
const MAX_SANDBOX_TOKEN_CHARS = 32;
const MAX_SANDBOX_TOKENS = 64;

function isAsciiWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;
}

// HTML compares tokens ASCII case-insensitively; String#toLowerCase would also fold non-ASCII
// (U+212A KELVIN SIGN lowercases to "k"), so a token outside ASCII never matches.
function asciiLower(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    out += code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 0x20) : ch;
  }
  return out;
}

/** The capabilities an iframe `sandbox` attribute grants. Unknown tokens grant nothing. */
export function parseSandboxAttribute(raw: string | null | undefined): SandboxRestrictions {
  if (raw === null || raw === undefined) return SANDBOX_ALLOW_ALL;
  const allowed = new Set<keyof SandboxRestrictions>();
  let tokens = 0;
  let i = 0;
  while (i < raw.length && tokens < MAX_SANDBOX_TOKENS) {
    while (i < raw.length && isAsciiWhitespace(raw.charCodeAt(i))) i++;
    const start = i;
    while (i < raw.length && !isAsciiWhitespace(raw.charCodeAt(i))) i++;
    const length = i - start;
    if (length === 0 || length > MAX_SANDBOX_TOKEN_CHARS) continue;
    tokens += 1;
    const field = TOKEN_FIELDS.get(asciiLower(raw.slice(start, i)));
    if (field) allowed.add(field);
  }
  return {
    scripts: allowed.has("scripts"),
    sameOrigin: allowed.has("sameOrigin"),
    forms: allowed.has("forms"),
    topNavigation: allowed.has("topNavigation"),
  };
}

/** A frame keeps only the capabilities both it and its ancestors allow. */
export function intersectSandbox(
  parent: SandboxRestrictions,
  child: SandboxRestrictions,
): SandboxRestrictions {
  return {
    scripts: parent.scripts && child.scripts,
    sameOrigin: parent.sameOrigin && child.sameOrigin,
    forms: parent.forms && child.forms,
    topNavigation: parent.topNavigation && child.topNavigation,
  };
}
