// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Applies document encodings to URL-query and form-data serialization.

import { opts } from "./state.js";

const SPECIAL_QUERY_SET = 0;
const FORM_URLENCODED_SET = 1;

const NON_ASCII = /[^\x00-\x7f]/;
const ISO_2022_JP_ESCAPES = /[\x0e\x0f\x1b]/;

function needsEncoder(s: string, encoding: string): boolean {
  return NON_ASCII.test(s) || (encoding === "ISO-2022-JP" && ISO_2022_JP_ESCAPES.test(s));
}

const ENCODED_QUERY_PROTOCOLS = new Set(["http:", "https:", "ftp:", "file:"]);

export function documentCharacterSet(): string {
  return opts?.characterSet || "UTF-8";
}

export function encodingForLabel(label: string): string | undefined {
  return opts?.encodingName?.(label);
}

function encodesAsUtf8(encoding: string): boolean {
  return (
    encoding === "UTF-8" ||
    encoding === "UTF-16LE" ||
    encoding === "UTF-16BE" ||
    encoding === "replacement"
  );
}

export function outputEncoding(encoding: string): string {
  return encodesAsUtf8(encoding) ? "UTF-8" : encoding;
}

export function characterSetOf(node: unknown): string {
  if (typeof node !== "object" || node === null || !("ownerDocument" in node)) {
    return "UTF-8";
  }
  const doc = node.ownerDocument;
  if (typeof doc !== "object" || doc === null || !("characterSet" in doc)) {
    return "UTF-8";
  }
  const cs = doc.characterSet;
  return typeof cs === "string" && cs ? cs : "UTF-8";
}

// A scan, not `/[\x00-\x20]+$/`, which backtracks quadratically on long interior runs.
function trimC0ControlOrSpace(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) <= 0x20) start++;
  while (end > start && s.charCodeAt(end - 1) <= 0x20) end--;
  return s.slice(start, end);
}

export function encodingParseUrl(
  input: string,
  base: string | URL | undefined,
  encoding: string,
): URL {
  const url = new URL(input, base);
  if (encodesAsUtf8(encoding) || !needsEncoder(input, encoding)) return url;
  if (!ENCODED_QUERY_PROTOCOLS.has(url.protocol)) return url;
  const encode = opts?.percentEncodeAfterEncoding;
  if (!encode) return url;
  const clean = trimC0ControlOrSpace(input).replace(/[\t\n\r]/g, "");
  const q = clean.indexOf("?");
  if (q < 0) return url;
  const hash = clean.indexOf("#");
  if (hash >= 0 && hash < q) return url;
  const end = hash < 0 ? clean.length : hash;
  const query = clean.slice(q + 1, end);
  if (!needsEncoder(query, encoding)) return url;
  const encoded = encode(encoding, query, SPECIAL_QUERY_SET, false);
  return new URL(clean.slice(0, q + 1) + encoded + clean.slice(end), base);
}

export function parseUrlForNode(node: unknown, input: string, base: string | URL | undefined): URL {
  if (!NON_ASCII.test(input) && !ISO_2022_JP_ESCAPES.test(input)) {
    return new URL(input, base);
  }
  return encodingParseUrl(input, base, characterSetOf(node));
}

export function urlencodedSerialize(
  entries: ReadonlyArray<readonly [string, string]>,
  encoding: string,
): string {
  const encode = opts?.percentEncodeAfterEncoding;
  if (encodesAsUtf8(encoding) || !encode) {
    const params = new URLSearchParams();
    for (const [n, v] of entries) params.append(n, v);
    return params.toString();
  }
  let out = "";
  for (const [n, v] of entries) {
    if (out) out += "&";
    out +=
      encode(encoding, n, FORM_URLENCODED_SET, true) +
      "=" +
      encode(encoding, v, FORM_URLENCODED_SET, true);
  }
  return out;
}

export function encodeHtmlBytes(encoding: string, s: string): Uint8Array | undefined {
  if (encodesAsUtf8(encoding)) return undefined;
  return opts?.encodeHtml?.(encoding, s);
}
