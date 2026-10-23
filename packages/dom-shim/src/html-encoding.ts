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

  const bom = decodeBom(bytes, decode);
  if (bom) return bom;

  const encoding = preferredEncoding(contentType, bytes);
  if (encoding === "replacement") {
    return { html: bytes.length === 0 ? "" : "\uFFFD", charset: encoding };
  }
  return decode(encoding, bytes);
}

function decodeBom(
  bytes: Uint8Array,
  decode: (label: string, body: Uint8Array) => { html: string; charset: string },
): { html: string; charset: string } | null {
  if (hasUtf8Bom(bytes)) {
    return decode("utf-8", bytes.subarray(3));
  }
  if (hasUtf16LeBom(bytes)) {
    return decode("utf-16le", bytes.subarray(2));
  }
  if (hasUtf16BeBom(bytes)) {
    return decode("utf-16be", bytes.subarray(2));
  }
  return null;
}

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

function hasUtf16LeBom(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe;
}

function hasUtf16BeBom(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff;
}

function preferredEncoding(contentType: string, bytes: Uint8Array): string {
  const headerLabel = parseCharsetFromContentType(contentType);
  return (
    (headerLabel === null ? null : getEncoding(headerLabel)) ?? sniffMetaEncoding(bytes) ?? "utf-8"
  );
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
    const encoding = normalizeMetaEncoding(label);
    if (encoding === null) continue;
    return encoding;
  }
  return null;
}

function normalizeMetaEncoding(label: string | null): string | null {
  const encoding = getMetaEncoding(label);
  if (encoding === null) return null;
  if (isUtf16Encoding(encoding)) return "utf-8";
  if (encoding === "x-user-defined") return "windows-1252";
  return encoding;
}

function getMetaEncoding(label: string | null): string | null {
  if (label === null) return null;
  return getEncoding(label);
}

function isUtf16Encoding(encoding: string): boolean {
  return encoding === "utf-16le" || encoding === "utf-16be";
}

function metaCharsetLabel(attributes: string): string | null {
  return charsetFromMetaAttributes(parseMetaAttributes(attributes));
}

function parseMetaAttributes(attributes: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const m of attributes.matchAll(
    /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g,
  )) {
    addFirstMetaAttribute(attrs, m);
  }
  return attrs;
}

function addFirstMetaAttribute(attrs: Map<string, string>, match: RegExpMatchArray): void {
  const name = metaAttributeName(match);
  if (attrs.has(name)) return;
  attrs.set(name, metaAttributeValue(match));
}

function metaAttributeName(match: RegExpMatchArray): string {
  return (match[1] ?? "").toLowerCase();
}

function metaAttributeValue(match: RegExpMatchArray): string {
  return match[2] ?? match[3] ?? match[4] ?? "";
}

function charsetFromMetaAttributes(attrs: Map<string, string>): string | null {
  const charset = attrs.get("charset");
  if (charset !== undefined) return charset;
  if (!hasContentTypePragma(attrs)) return null;
  return charsetFromPragma(attrs.get("content"));
}

function hasContentTypePragma(attrs: Map<string, string>): boolean {
  return attrs.get("http-equiv")?.toLowerCase() === "content-type";
}

function charsetFromPragma(content: string | undefined): string | null {
  const pragma = content?.match(/charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s;"']+))/i);
  return charsetFromMatch(pragma);
}

function charsetFromMatch(pragma: RegExpMatchArray | null | undefined): string | null {
  if (!pragma) return null;
  return pragma[1] ?? pragma[2] ?? pragma[3] ?? null;
}
