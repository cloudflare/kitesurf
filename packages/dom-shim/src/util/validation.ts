// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Validates XML names and qualified names and defines the XML namespace constants.

export const XML_NS = "http://www.w3.org/XML/1998/namespace";
export const XMLNS_NS = "http://www.w3.org/2000/xmlns/";

export const XML_NAME_RE =
  /^[:A-Z_a-z\u00C0-\uD7FF\uE000-\uFFFF][-:A-Z_a-z\u00C0-\uD7FF\uE000-\uFFFF.0-9\u00B7<{}|^!@#$%&*()'"=?,;\/\\`~+\[\]]*$/;

export const XML_NCNAME_START_RE = /^[:A-Z_a-z\u00C0-\uD7FF\uE000-\uFFFF]/;

export function validateAttrName(name: string): void {
  if (name.length === 0 || /[\u0000-\u001f\s\/<>]/.test(name)) {
    throw new DOMException("'" + name + "' is not a valid attribute name", "InvalidCharacterError");
  }
}

export function isValidXmlName(s: unknown): boolean {
  if (typeof s !== "string" || s.length === 0) return false;
  const c0 = s.charCodeAt(0);
  if (
    (c0 >= 0x30 && c0 <= 0x39) ||
    c0 === 0x2d ||
    c0 === 0x2e ||
    c0 === 0x3c ||
    c0 === 0x3e ||
    c0 === 0x7d
  ) {
    return false;
  }
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (
      c === 0x00 ||
      c === 0x09 ||
      c === 0x0a ||
      c === 0x0c ||
      c === 0x0d ||
      c === 0x20 ||
      c === 0x2f ||
      c === 0x3e
    ) {
      return false;
    }
  }
  return true;
}

export function validatePIArgs(target: unknown, data: unknown): void {
  const t = String(target ?? "");
  const d = String(data ?? "");
  if (t.length === 0) {
    throw new DOMException("createProcessingInstruction: target is empty", "InvalidCharacterError");
  }
  function isNameStart(cp: number): boolean {
    if (cp >= 0x41 && cp <= 0x5a) return true;
    if (cp >= 0x61 && cp <= 0x7a) return true;
    if (cp === 0x5f) return true;
    if (cp === 0x3a) return true;
    if (cp >= 0xc0 && cp <= 0xd6) return true;
    if (cp >= 0xd8 && cp <= 0xf6) return true;
    if (cp >= 0xf8 && cp <= 0x2ff) return true;
    if (cp >= 0x370 && cp <= 0x37d) return true;
    if (cp >= 0x37f && cp <= 0x1fff) return true;
    if (cp >= 0x200c && cp <= 0x200d) return true;
    if (cp >= 0x2070 && cp <= 0x218f) return true;
    if (cp >= 0x2c00 && cp <= 0x2fef) return true;
    if (cp >= 0x3001 && cp <= 0xd7ff) return true;
    if (cp >= 0xf900 && cp <= 0xfdcf) return true;
    if (cp >= 0xfdf0 && cp <= 0xfffd) return true;
    return false;
  }
  function isNameChar(cp: number): boolean {
    if (isNameStart(cp)) return true;
    if (cp >= 0x30 && cp <= 0x39) return true;
    if (cp === 0x2d || cp === 0x2e) return true;
    if (cp === 0xb7) return true;
    if (cp >= 0x300 && cp <= 0x36f) return true;
    if (cp >= 0x203f && cp <= 0x2040) return true;
    return false;
  }
  const first = t.codePointAt(0)!;
  if (!isNameStart(first) || first === 0xb7) {
    throw new DOMException(
      "createProcessingInstruction: '" + t + "' is not a valid PI target",
      "InvalidCharacterError",
    );
  }
  let i = first > 0xffff ? 2 : 1;
  while (i < t.length) {
    const cp = t.codePointAt(i)!;
    if (!isNameChar(cp)) {
      throw new DOMException(
        "createProcessingInstruction: '" + t + "' is not a valid PI target",
        "InvalidCharacterError",
      );
    }
    i += cp > 0xffff ? 2 : 1;
  }
  if (d.indexOf("?>") >= 0) {
    throw new DOMException(
      "createProcessingInstruction: data must not contain '?>'",
      "InvalidCharacterError",
    );
  }
}

export function validateXMLName(qualifiedName: string): void {
  if (!XML_NAME_RE.test(qualifiedName)) {
    throw new DOMException(
      "Invalid qualified name '" + qualifiedName + "'",
      "InvalidCharacterError",
    );
  }
}

export function validateAndExtract(
  namespace: string | null,
  qualifiedName: string,
): [string | null, string | null, string] {
  if (namespace === "") namespace = null;
  validateXMLName(qualifiedName);
  let prefix: string | null = null;
  let localName = qualifiedName;
  const colonIdx = qualifiedName.indexOf(":");
  if (colonIdx >= 0) {
    prefix = qualifiedName.substring(0, colonIdx);
    localName = qualifiedName.substring(colonIdx + 1);
    if (prefix.length === 0 || localName.length === 0) {
      throw new DOMException(
        "Invalid qualified name '" + qualifiedName + "'",
        "InvalidCharacterError",
      );
    }
    if (!XML_NCNAME_START_RE.test(localName)) {
      throw new DOMException(
        "Invalid local name in '" + qualifiedName + "'",
        "InvalidCharacterError",
      );
    }
  }
  if (prefix !== null && namespace === null) {
    throw new DOMException("Cannot have a prefix with a null namespace", "NamespaceError");
  }
  if (prefix === "xml" && namespace !== XML_NS) {
    throw new DOMException("xml prefix requires the XML namespace", "NamespaceError");
  }
  if ((qualifiedName === "xmlns" || prefix === "xmlns") && namespace !== XMLNS_NS) {
    throw new DOMException("xmlns prefix / name requires the XMLNS namespace", "NamespaceError");
  }
  if (namespace === XMLNS_NS && qualifiedName !== "xmlns" && prefix !== "xmlns") {
    throw new DOMException("XMLNS namespace requires xmlns prefix or name", "NamespaceError");
  }
  return [namespace, prefix, localName];
}
