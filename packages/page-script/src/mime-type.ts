// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Tracks Blob MIME labels and serializes normalized MIME type strings.

const blobMimeTypes = new WeakMap<object, string>();

export function getBlobMimeType(blob: object): string | undefined {
  return blobMimeTypes.get(blob);
}

export function setBlobMimeType(blob: object, mimeType: string): void {
  blobMimeTypes.set(blob, mimeType);
}

export function normalizeBlobType(input: string): string {
  for (let index = 0; index < input.length; index++) {
    const codePoint = input.charCodeAt(index);
    if (codePoint < 0x20 || codePoint > 0x7e) return "";
  }
  return input.toLowerCase();
}

function isHttpWhitespace(codePoint: number): boolean {
  return codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d || codePoint === 0x20;
}

function isAsciiDigit(codePoint: number): boolean {
  return codePoint >= 0x30 && codePoint <= 0x39;
}

function isAsciiUppercase(codePoint: number): boolean {
  return codePoint >= 0x41 && codePoint <= 0x5a;
}

function isAsciiLowercase(codePoint: number): boolean {
  return codePoint >= 0x61 && codePoint <= 0x7a;
}

function isFirstTokenPunctuation(codePoint: number): boolean {
  return (
    codePoint === 0x21 ||
    (codePoint >= 0x23 && codePoint <= 0x27) ||
    (codePoint >= 0x2a && codePoint <= 0x2b)
  );
}

function isTokenPunctuationRanges(codePoint: number): boolean {
  return (codePoint >= 0x2d && codePoint <= 0x2e) || (codePoint >= 0x5e && codePoint <= 0x60);
}

function isSecondTokenPunctuation(codePoint: number): boolean {
  return isTokenPunctuationRanges(codePoint) || codePoint === 0x7c || codePoint === 0x7e;
}

function isHttpTokenCodePoint(codePoint: number): boolean {
  return (
    isAsciiDigit(codePoint) ||
    isAsciiUppercase(codePoint) ||
    isAsciiLowercase(codePoint) ||
    isFirstTokenPunctuation(codePoint) ||
    isSecondTokenPunctuation(codePoint)
  );
}

function codePointLength(codePoint: number): number {
  return codePoint > 0xffff ? 2 : 1;
}

function codePointAt(value: string, position: number): number {
  const codePoint = value.codePointAt(position);
  if (codePoint === undefined) {
    throw new RangeError("Code point position is out of bounds");
  }
  return codePoint;
}

function hasOnlyCodePoints(value: string, predicate: (codePoint: number) => boolean): boolean {
  for (let position = 0; position < value.length;) {
    const codePoint = codePointAt(value, position);
    if (!predicate(codePoint)) return false;
    position += codePointLength(codePoint);
  }
  return true;
}

function trimHttpWhitespace(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isHttpWhitespace(value.charCodeAt(start))) start++;
  while (end > start && isHttpWhitespace(value.charCodeAt(end - 1))) end--;
  return value.slice(start, end);
}

function trimTrailingHttpWhitespace(value: string): string {
  let end = value.length;
  while (end > 0 && isHttpWhitespace(value.charCodeAt(end - 1))) end--;
  return value.slice(0, end);
}

function isHttpQuotedString(value: string): boolean {
  return hasOnlyCodePoints(
    value,
    (codePoint) =>
      codePoint === 0x09 ||
      (codePoint >= 0x20 && codePoint <= 0x7e) ||
      (codePoint >= 0x80 && codePoint <= 0xff),
  );
}

function serializeParameterValue(value: string): string {
  if (value !== "" && hasOnlyCodePoints(value, isHttpTokenCodePoint)) {
    return value;
  }
  return `"${value.replace(/["\\]/g, "\\$&")}"`;
}

function readQuotedParameterValue(
  input: string,
  start: number,
): { value: string; position: number } {
  let position = start + 1;
  let value = "";
  while (position < input.length) {
    if (input[position] === '"') {
      position++;
      break;
    }
    if (input[position] === "\\") {
      position++;
      if (position >= input.length) {
        value += "\\";
        break;
      }
    }
    const codePoint = codePointAt(input, position);
    value += String.fromCodePoint(codePoint);
    position += codePointLength(codePoint);
  }
  return { value, position };
}

interface MimeHeader {
  value: string;
  type: string;
  subtype: string;
  position: number;
}

function isValidMimeSubtype(subtype: string): boolean {
  return subtype !== "" && hasOnlyCodePoints(subtype, isHttpTokenCodePoint);
}

function parseMimeHeader(input: string): MimeHeader | null {
  const value = trimHttpWhitespace(input);
  const slash = value.indexOf("/");
  if (slash <= 0) return null;
  const type = value.slice(0, slash);
  if (!hasOnlyCodePoints(type, isHttpTokenCodePoint)) return null;
  const subtype = parseMimeSubtype(value, slash + 1);
  if (!subtype) return null;
  return { value, type, ...subtype };
}

function parseMimeSubtype(
  value: string,
  position: number,
): { subtype: string; position: number } | null {
  const semicolon = value.indexOf(";", position);
  const subtypeEnd = semicolon < 0 ? value.length : semicolon;
  const subtype = trimTrailingHttpWhitespace(value.slice(position, subtypeEnd));
  if (!isValidMimeSubtype(subtype)) return null;
  return { subtype, position: semicolon < 0 ? value.length : semicolon };
}

function skipParameterWhitespace(value: string, position: number): number {
  while (position < value.length && isHttpWhitespace(codePointAt(value, position))) {
    position += codePointLength(codePointAt(value, position));
  }
  return position;
}

function readParameterName(value: string, position: number): { name: string; position: number } {
  const nameStart = position;
  while (position < value.length && value[position] !== ";" && value[position] !== "=") {
    position += codePointLength(codePointAt(value, position));
  }
  return { name: value.slice(nameStart, position).toLowerCase(), position };
}

function isParameterTerminator(value: string, position: number): boolean {
  return position < value.length && value[position] === ";";
}

function readQuotedParameterValueWithTrailing(
  value: string,
  position: number,
): {
  parameterValue: string;
  position: number;
  quoted: boolean;
} {
  const quotedValue = readQuotedParameterValue(value, position);
  position = quotedValue.position;
  while (position < value.length && value[position] !== ";") {
    position += codePointLength(codePointAt(value, position));
  }
  return { parameterValue: quotedValue.value, position, quoted: true };
}

function readUnquotedParameterValue(
  value: string,
  position: number,
): {
  parameterValue: string;
  position: number;
  quoted: boolean;
} {
  const valueStart = position;
  while (position < value.length && value[position] !== ";") {
    position += codePointLength(codePointAt(value, position));
  }
  return {
    parameterValue: trimTrailingHttpWhitespace(value.slice(valueStart, position)),
    position,
    quoted: false,
  };
}

function readParameterValue(
  value: string,
  position: number,
): { parameterValue: string; position: number; quoted: boolean } {
  if (value[position] === '"') return readQuotedParameterValueWithTrailing(value, position);
  return readUnquotedParameterValue(value, position);
}

function isValidMimeParameter(
  name: string,
  value: string,
  parameters: Map<string, string>,
): boolean {
  return (
    name !== "" &&
    hasOnlyCodePoints(name, isHttpTokenCodePoint) &&
    isHttpQuotedString(value) &&
    !parameters.has(name)
  );
}

function storeParameterValue(
  value: string,
  position: number,
  name: string,
  parameters: Map<string, string>,
): number | null {
  if (position >= value.length) return null;
  const parsed = readParameterValue(value, position);
  if (!parsed.quoted && parsed.parameterValue === "") return parsed.position;
  if (isValidMimeParameter(name, parsed.parameterValue, parameters)) {
    parameters.set(name, parsed.parameterValue);
  }
  return parsed.position;
}

function consumeMimeParameter(
  value: string,
  position: number,
  parameters: Map<string, string>,
): number | null {
  position++;
  position = skipParameterWhitespace(value, position);
  const parsedName = readParameterName(value, position);
  position = parsedName.position;
  if (isParameterTerminator(value, position)) return position;
  if (position < value.length) position++;
  return storeParameterValue(value, position, parsedName.name, parameters);
}

function parseMimeParameters(value: string, position: number): Map<string, string> {
  const parameters = new Map<string, string>();
  while (position < value.length) {
    const nextPosition = consumeMimeParameter(value, position, parameters);
    if (nextPosition === null) break;
    position = nextPosition;
  }
  return parameters;
}

export function serializeMimeType(input: string): string {
  const header = parseMimeHeader(input);
  if (!header) return "";
  const parameters = parseMimeParameters(header.value, header.position);
  let serialized = `${header.type.toLowerCase()}/${header.subtype.toLowerCase()}`;
  for (const [name, parameterValue] of parameters) {
    serialized += `;${name}=${serializeParameterValue(parameterValue)}`;
  }
  return serialized;
}
