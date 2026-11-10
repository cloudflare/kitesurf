// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Classifies JavaScript and module MIME types and applies nosniff checks.

const JS_MIME_ESSENCES = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
]);

// HTTP token code points (Fetch, "HTTP token code point").
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function isHttpWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function trimHttpWhitespace(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isHttpWhitespace(value.charAt(start))) start += 1;
  while (end > start && isHttpWhitespace(value.charAt(end - 1))) end -= 1;
  return value.slice(start, end);
}

/** Splits a Content-Type header into list values; a quoted string is never split.
 * Mirrors Fetch's "get, decode, and split a header value", keeping quotes and escapes.
 */
function splitHeaderValues(header: string): string[] {
  const values: string[] = [];
  let start = 0;
  let index = 0;
  while (index < header.length) {
    const char = header[index];
    if (char === '"') {
      index += 1;
      while (index < header.length) {
        const inner = header[index];
        index += 1;
        if (inner === "\\") index += 1;
        else if (inner === '"') break;
      }
    } else if (char === ",") {
      values.push(header.slice(start, index));
      index += 1;
      start = index;
    } else {
      index += 1;
    }
  }
  values.push(header.slice(start));
  return values;
}

/** Parses one value's essence with the WHATWG MIME parsing algorithm; null on failure or a
 * `*` wildcard. Parameters never make that algorithm fail, so they are not parsed.
 */
function parseMimeEssence(input: string): string | null {
  const value = trimHttpWhitespace(input);
  const slash = value.indexOf("/");
  if (slash < 0) return null;
  const type = value.slice(0, slash);
  if (!HTTP_TOKEN.test(type)) return null;
  const semicolon = value.indexOf(";", slash + 1);
  let end = semicolon < 0 ? value.length : semicolon;
  // Only trailing whitespace is removed from the subtype; leading whitespace fails the parse.
  while (end > slash + 1 && isHttpWhitespace(value.charAt(end - 1))) end -= 1;
  const subtype = value.slice(slash + 1, end);
  if (!HTTP_TOKEN.test(subtype)) return null;

  const essence = `${type}/${subtype}`.toLowerCase();
  return essence === "*/*" ? null : essence;
}

/** Returns the essence of the last valid MIME type in a Content-Type header, as Fetch does;
 * `""` when no value parses. A wildcard `*` type is not a usable MIME type.
 */
export function mimeEssence(contentType: string | null | undefined): string {
  if (!contentType) return "";
  let essence = "";
  for (const value of splitHeaderValues(contentType)) {
    const parsed = parseMimeEssence(value);
    if (parsed !== null) essence = parsed;
  }
  return essence;
}

const NON_SCRIPT_MIME_PREFIXES = ["image/", "audio/", "video/"] as const;

/** Whether the effective MIME type is data a script destination must refuse even without
 * nosniff: images, audio, video and CSV.
 */
export function blockedScriptMime(contentType: string | null | undefined): boolean {
  const essence = mimeEssence(contentType);
  return (
    essence === "text/csv" || NON_SCRIPT_MIME_PREFIXES.some((prefix) => essence.startsWith(prefix))
  );
}

export function isJavaScriptMime(contentType: string | null | undefined): boolean {
  return JS_MIME_ESSENCES.has(mimeEssence(contentType));
}

export function isJsonMime(contentType: string | null | undefined): boolean {
  const essence = mimeEssence(contentType);
  return essence === "application/json" || essence === "text/json" || essence.endsWith("+json");
}

export type ModuleType = "javascript" | "json";

export function isModuleMime(type: ModuleType, contentType: string | null | undefined): boolean {
  return type === "json" ? isJsonMime(contentType) : isJavaScriptMime(contentType);
}

export function hasNosniff(header: string | null | undefined): boolean {
  if (!header) return false;
  return header.split(",").some((value) => value.trim().toLowerCase() === "nosniff");
}

export function blockedByNosniff(
  contentType: string | null | undefined,
  contentTypeOptions: string | null | undefined,
): boolean {
  if (!hasNosniff(contentTypeOptions)) return false;
  return !isJavaScriptMime(contentType);
}
