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

export function encodingParseUrl(
  input: string,
  base: string | URL | undefined,
  encoding: string,
): URL {
  const url = new URL(input, base);
  const encode = queryEncoder(url, input, encoding);
  if (!encode) return url;
  const clean = input.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, "").replace(/[\t\n\r]/g, "");
  const queryRange = queryRangeOf(clean);
  if (!queryRange) return url;
  const query = encodableQuery(clean, queryRange, encoding);
  if (query === null) return url;
  const encoded = encode(encoding, query, SPECIAL_QUERY_SET, false);
  return new URL(
    clean.slice(0, queryRange.start + 1) + encoded + clean.slice(queryRange.end),
    base,
  );
}

function canEncodeUrlQuery(url: URL, input: string, encoding: string): boolean {
  if (encodesAsUtf8(encoding) || !needsEncoder(input, encoding)) return false;
  return ENCODED_QUERY_PROTOCOLS.has(url.protocol);
}

function queryEncoder(
  url: URL,
  input: string,
  encoding: string,
): NonNullable<NonNullable<typeof opts>["percentEncodeAfterEncoding"]> | null {
  if (!canEncodeUrlQuery(url, input, encoding)) return null;
  return opts?.percentEncodeAfterEncoding ?? null;
}

function queryRangeOf(clean: string): { start: number; end: number } | null {
  const start = clean.indexOf("?");
  if (start < 0) return null;
  const hash = clean.indexOf("#");
  if (hash >= 0 && hash < start) return null;
  return { start, end: hash < 0 ? clean.length : hash };
}

function encodableQuery(
  clean: string,
  range: { start: number; end: number },
  encoding: string,
): string | null {
  const query = clean.slice(range.start + 1, range.end);
  if (!needsEncoder(query, encoding)) return null;
  return query;
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
    return serializeWithUrlSearchParams(entries);
  }
  return serializeWithEncoding(entries, encoding, encode);
}

function serializeWithUrlSearchParams(entries: ReadonlyArray<readonly [string, string]>): string {
  const params = new URLSearchParams();
  for (const [n, v] of entries) params.append(n, v);
  return params.toString();
}

function serializeWithEncoding(
  entries: ReadonlyArray<readonly [string, string]>,
  encoding: string,
  encode: NonNullable<NonNullable<typeof opts>["percentEncodeAfterEncoding"]>,
): string {
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
