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

export function mimeEssence(contentType: string | null | undefined): string {
  if (!contentType) return "";
  const parameterStart = contentType.indexOf(";");
  const mediaType = (
    parameterStart >= 0 ? contentType.slice(0, parameterStart) : contentType
  ).trim();
  return mediaType.toLowerCase();
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
