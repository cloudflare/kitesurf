// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Validates XML names and qualified names and defines the XML namespace constants.

export const XML_NS = "http://www.w3.org/XML/1998/namespace";
export const XMLNS_NS = "http://www.w3.org/2000/xmlns/";

export const XML_NAME_RE =
  /^[:A-Z_a-z\u00C0-\uD7FF\uE000-\uFFFF][-:A-Z_a-z\u00C0-\uD7FF\uE000-\uFFFF.0-9\u00B7<{}|^!@#$%&*()'"=?,;\/\\`~+\[\]]*$/;

export const XML_NCNAME_START_RE = /^[:A-Z_a-z\u00C0-\uD7FF\uE000-\uFFFF]/;

const XML_NAME_START_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x41, 0x5a],
  [0x61, 0x7a],
  [0xc0, 0xd6],
  [0xd8, 0xf6],
  [0xf8, 0x2ff],
  [0x370, 0x37d],
  [0x37f, 0x1fff],
  [0x200c, 0x200d],
  [0x2070, 0x218f],
  [0x2c00, 0x2fef],
  [0x3001, 0xd7ff],
  [0xf900, 0xfdcf],
  [0xfdf0, 0xfffd],
];
const XML_NAME_CHAR_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x30, 0x39],
  [0x300, 0x36f],
  [0x203f, 0x2040],
];
const XML_NAME_START_POINTS = new Set([0x5f, 0x3a]);
const XML_NAME_CHAR_POINTS = new Set([0x2d, 0x2e, 0xb7]);
const XML_NAME_INVALID_STARTS = new Set([0x2d, 0x2e, 0x3c, 0x3e, 0x7d]);
const XML_NAME_INVALID_CHARS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20, 0x2f, 0x3e]);

function inCodePointRange(cp: number, [start, end]: readonly [number, number]): boolean {
  return cp >= start && cp <= end;
}

function isNameStart(cp: number): boolean {
  return (
    XML_NAME_START_POINTS.has(cp) ||
    XML_NAME_START_RANGES.some((range) => inCodePointRange(cp, range))
  );
}

function isNameChar(cp: number): boolean {
  return (
    isNameStart(cp) ||
    XML_NAME_CHAR_POINTS.has(cp) ||
    XML_NAME_CHAR_RANGES.some((range) => inCodePointRange(cp, range))
  );
}

export function validateAttrName(name: string): void {
  if (name.length === 0 || /[\u0000-\u001f\s\/<>]/.test(name)) {
    throw new DOMException("'" + name + "' is not a valid attribute name", "InvalidCharacterError");
  }
}

export function isValidXmlName(s: unknown): boolean {
  if (typeof s !== "string") return false;
  if (s.length === 0 || invalidNameStart(s.charCodeAt(0))) return false;
  return !containsInvalidNameChar(s);
}

function invalidNameStart(cp: number): boolean {
  return (cp >= 0x30 && cp <= 0x39) || XML_NAME_INVALID_STARTS.has(cp);
}

function containsInvalidNameChar(name: string): boolean {
  for (let i = 0; i < name.length; i++) {
    if (XML_NAME_INVALID_CHARS.has(name.charCodeAt(i))) return true;
  }
  return false;
}

export function validatePIArgs(target: unknown, data: unknown): void {
  const t = String(target ?? "");
  const d = String(data ?? "");
  if (t.length === 0) {
    throw new DOMException("createProcessingInstruction: target is empty", "InvalidCharacterError");
  }
  validateProcessingInstructionTarget(t);
  validateProcessingInstructionData(d);
}

function validateProcessingInstructionTarget(target: string): void {
  const first = target.codePointAt(0)!;
  if (!isNameStart(first) || first === 0xb7) throwInvalidPiTarget(target);
  validateRemainingPiTarget(target, first > 0xffff ? 2 : 1);
}

function validateRemainingPiTarget(target: string, start: number): void {
  let i = start;
  while (i < target.length) {
    const cp = target.codePointAt(i)!;
    if (!isNameChar(cp)) throwInvalidPiTarget(target);
    i += cp > 0xffff ? 2 : 1;
  }
}

function throwInvalidPiTarget(target: string): never {
  throw new DOMException(
    "createProcessingInstruction: '" + target + "' is not a valid PI target",
    "InvalidCharacterError",
  );
}

function validateProcessingInstructionData(data: string): void {
  if (data.indexOf("?>") >= 0) {
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

function splitQualifiedName(qualifiedName: string): [string | null, string] {
  const colonIdx = qualifiedName.indexOf(":");
  if (colonIdx < 0) return [null, qualifiedName];
  const prefix = qualifiedName.substring(0, colonIdx);
  const localName = qualifiedName.substring(colonIdx + 1);
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
  return [prefix, localName];
}

function validatePrefixNamespace(prefix: string | null, namespace: string | null): void {
  if (prefix !== null && namespace === null) {
    throw new DOMException("Cannot have a prefix with a null namespace", "NamespaceError");
  }
}

function validateXmlPrefixNamespace(prefix: string | null, namespace: string | null): void {
  if (prefix === "xml" && namespace !== XML_NS) {
    throw new DOMException("xml prefix requires the XML namespace", "NamespaceError");
  }
}

function validateXmlnsNameNamespace(
  prefix: string | null,
  qualifiedName: string,
  namespace: string | null,
): void {
  if ((qualifiedName === "xmlns" || prefix === "xmlns") && namespace !== XMLNS_NS) {
    throw new DOMException("xmlns prefix / name requires the XMLNS namespace", "NamespaceError");
  }
}

function validateXmlnsNamespaceName(
  prefix: string | null,
  qualifiedName: string,
  namespace: string | null,
): void {
  if (namespace === XMLNS_NS && qualifiedName !== "xmlns" && prefix !== "xmlns") {
    throw new DOMException("XMLNS namespace requires xmlns prefix or name", "NamespaceError");
  }
}

function validateNamespaceRules(
  namespace: string | null,
  prefix: string | null,
  qualifiedName: string,
): void {
  validatePrefixNamespace(prefix, namespace);
  validateXmlPrefixNamespace(prefix, namespace);
  validateXmlnsNameNamespace(prefix, qualifiedName, namespace);
  validateXmlnsNamespaceName(prefix, qualifiedName, namespace);
}

export function validateAndExtract(
  namespace: string | null,
  qualifiedName: string,
): [string | null, string | null, string] {
  if (namespace === "") namespace = null;
  validateXMLName(qualifiedName);
  const [prefix, localName] = splitQualifiedName(qualifiedName);
  validateNamespaceRules(namespace, prefix, qualifiedName);
  return [namespace, prefix, localName];
}
