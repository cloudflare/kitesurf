// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Classifies navigation responses into document types supported by the renderer.

import { sniffImageDims } from "../eval/image-dims.ts";

export type DocumentKind = "html" | "json" | "svg" | "image" | "text" | "blocked";

const RASTER_MIMES = new Set([
  "image/png",
  "image/apng",
  "image/jpeg",
  "image/jpg",
  "image/pjpeg",
  "image/gif",
  "image/webp",
]);

const TEXT_APPLICATION_MIMES = new Set([
  "application/javascript",
  "application/x-javascript",
  "application/ecmascript",
]);

function mimeEssence(contentType: string): string {
  return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}

function isAttachment(contentDisposition: string | null): boolean {
  if (contentDisposition === null) return false;
  const type = (contentDisposition.split(";")[0] ?? "").trim().toLowerCase();
  return type !== "" && type !== "inline" && !type.includes("=");
}

export function documentKind(headers: Headers): DocumentKind {
  if (isAttachment(headers.get("content-disposition"))) return "blocked";
  // No sniffing yet: a missing type keeps the historical HTML default.
  const mime = mimeEssence(headers.get("content-type") ?? "");
  return kindForMime(mime);
}

const EXACT_MIME_KINDS = new Map<string, DocumentKind>([
  ["", "html"],
  ["text/html", "html"],
  ["application/xhtml+xml", "html"],
  ["application/json", "json"],
  ["image/svg+xml", "svg"],
]);

function kindForMime(mime: string): DocumentKind {
  const exact = EXACT_MIME_KINDS.get(mime);
  if (exact) return exact;
  if (mime.endsWith("+json")) return "json";
  if (RASTER_MIMES.has(mime)) return "image";
  if (isTextMime(mime)) return "text";
  return "blocked";
}

function isTextMime(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    TEXT_APPLICATION_MIMES.has(mime) ||
    mime === "application/xml" ||
    mime.endsWith("+xml")
  );
}

function escapeText(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function imageDocumentTitle(url: string, bytes: Uint8Array): string {
  const name = imageDocumentName(url);
  const dims = sniffImageDims(bytes);
  const size = dims ? `${dims.width}\u00d7${dims.height}` : "";
  if (name && size) return `${name} (${size})`;
  return name || size;
}

function imageDocumentName(url: string): string {
  try {
    return imageDocumentNameFromUrl(new URL(url));
  } catch {
    return "";
  }
}

function imageDocumentNameFromUrl(url: URL): string {
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  const last = url.pathname.split("/").filter(Boolean).pop() ?? "";
  return decodeImageName(last) || url.hostname;
}

function decodeImageName(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

export function imageDocumentHtml(
  bytes: Uint8Array,
  base64: string,
  contentType: string,
  url: string,
): string {
  const src = `data:${mimeEssence(contentType)};base64,${base64}`;
  return (
    "<!doctype html><html><head>" +
    '<meta name="viewport" content="width=device-width, minimum-scale=0.1">' +
    `<title>${escapeText(imageDocumentTitle(url, bytes))}</title>` +
    "<style>" +
    "html,body{height:100%}" +
    "body{margin:0;background-color:rgb(14,14,14);display:flex;align-items:center;justify-content:center}" +
    "img{display:block;max-width:100%;max-height:100%;min-width:0;min-height:0;user-select:none;background-color:hsl(0,0%,90%)}" +
    "</style></head><body>" +
    `<img src="${src}">` +
    "</body></html>"
  );
}
