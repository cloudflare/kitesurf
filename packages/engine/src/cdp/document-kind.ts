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
  if (mime === "" || mime === "text/html" || mime === "application/xhtml+xml") {
    return "html";
  }
  if (mime === "application/json" || mime.endsWith("+json")) return "json";
  if (mime === "image/svg+xml") return "svg";
  if (RASTER_MIMES.has(mime)) return "image";
  if (mime.startsWith("text/") || TEXT_APPLICATION_MIMES.has(mime)) return "text";
  if (mime === "application/xml" || mime.endsWith("+xml")) return "text";
  return "blocked";
}

function escapeText(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function imageDocumentTitle(url: string, bytes: Uint8Array): string {
  let name = "";
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:") {
      const last = u.pathname.split("/").filter(Boolean).pop() ?? "";
      try {
        name = decodeURIComponent(last);
      } catch {
        name = last;
      }
      if (!name) name = u.hostname;
    }
  } catch {}
  const dims = sniffImageDims(bytes);
  const size = dims ? `${dims.width}\u00d7${dims.height}` : "";
  if (name && size) return `${name} (${size})`;
  return name || size;
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
