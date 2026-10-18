// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Decodes HTML bytes using a BOM, response charset, and meta charset sniffing.

const NativeTextDecoder = TextDecoder;
const META_CHARSET_SNIFF_BYTES = 1024;
const REPLACEMENT_LABELS = new Set([
  "csiso2022kr",
  "hz-gb-2312",
  "iso-2022-cn",
  "iso-2022-cn-ext",
  "iso-2022-kr",
  "replacement",
]);

/** Uses a BOM, valid response charset, then a meta declaration; defaults to UTF-8. */
export function decodeHtmlBytes(
  bytes: Uint8Array,
  contentType: string,
): { html: string; charset: string } {
  const decode = (label: string, body: Uint8Array) => {
    const decoder = new NativeTextDecoder(label);
    return { html: decoder.decode(body), charset: decoder.encoding };
  };

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return decode("utf-8", bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return decode("utf-16le", bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return decode("utf-16be", bytes.subarray(2));
  }

  const headerLabel = parseCharsetFromContentType(contentType);
  const encoding =
    (headerLabel === null ? null : getEncoding(headerLabel)) ?? sniffMetaEncoding(bytes) ?? "utf-8";
  if (encoding === "replacement") {
    return { html: bytes.length === 0 ? "" : "\uFFFD", charset: encoding };
  }
  return decode(encoding, bytes);
}

function getEncoding(label: string): string | null {
  const trimmed = label.trim().toLowerCase();
  if (REPLACEMENT_LABELS.has(trimmed)) return "replacement";
  try {
    return new NativeTextDecoder(trimmed).encoding;
  } catch {
    return null;
  }
}

function parseCharsetFromContentType(contentType: string): string | null {
  const match = contentType.match(/charset\s*=\s*"?([^\s;"]+)"?/i);
  return match?.[1] ?? null;
}

function sniffMetaEncoding(bytes: Uint8Array): string | null {
  const prefix = new NativeTextDecoder("latin1").decode(
    bytes.subarray(0, META_CHARSET_SNIFF_BYTES),
  );
  for (const tag of prefix.matchAll(/<meta(?=[\s/])([^>]*)/gi)) {
    const label = metaCharsetLabel(tag[1] ?? "");
    const encoding = label === null ? null : getEncoding(label);
    if (encoding === null) continue;
    if (encoding === "utf-16le" || encoding === "utf-16be") return "utf-8";
    if (encoding === "x-user-defined") return "windows-1252";
    return encoding;
  }
  return null;
}

function metaCharsetLabel(attributes: string): string | null {
  const attrs = new Map<string, string>();
  for (const m of attributes.matchAll(
    /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g,
  )) {
    const name = (m[1] ?? "").toLowerCase();
    if (!attrs.has(name)) attrs.set(name, m[2] ?? m[3] ?? m[4] ?? "");
  }
  const charset = attrs.get("charset");
  if (charset !== undefined) return charset;
  if (attrs.get("http-equiv")?.toLowerCase() !== "content-type") return null;
  const pragma = attrs.get("content")?.match(/charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s;"']+))/i);
  return pragma ? (pragma[1] ?? pragma[2] ?? pragma[3] ?? null) : null;
}
