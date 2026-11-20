// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Fetch §2.2.2 forbidden request-headers: names page script cannot set,
// because the user agent owns them.

const FORBIDDEN_NAMES = new Set([
  "accept-charset",
  "accept-encoding",
  "access-control-request-headers",
  "access-control-request-method",
  "connection",
  "content-length",
  "cookie",
  "cookie2",
  "date",
  "dnt",
  "expect",
  "host",
  "keep-alive",
  "origin",
  "referer",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
]);

const METHOD_OVERRIDE_NAMES = new Set([
  "x-http-method",
  "x-http-method-override",
  "x-method-override",
]);
const FORBIDDEN_METHODS = new Set(["CONNECT", "TRACE", "TRACK"]);

/** Whether page script may not set this header on a request. */
export function isForbiddenRequestHeader(name: string, value: string): boolean {
  const lower = name.toLowerCase();
  if (FORBIDDEN_NAMES.has(lower) || lower.startsWith("proxy-") || lower.startsWith("sec-")) {
    return true;
  }
  if (!METHOD_OVERRIDE_NAMES.has(lower)) return false;
  return value.split(",").some((method) => FORBIDDEN_METHODS.has(method.trim().toUpperCase()));
}
