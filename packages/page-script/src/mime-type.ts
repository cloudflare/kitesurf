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

function isHttpTokenCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x30 && codePoint <= 0x39) ||
    (codePoint >= 0x41 && codePoint <= 0x5a) ||
    (codePoint >= 0x61 && codePoint <= 0x7a) ||
    codePoint === 0x21 ||
    (codePoint >= 0x23 && codePoint <= 0x27) ||
    (codePoint >= 0x2a && codePoint <= 0x2b) ||
    (codePoint >= 0x2d && codePoint <= 0x2e) ||
    (codePoint >= 0x5e && codePoint <= 0x60) ||
    codePoint === 0x7c ||
    codePoint === 0x7e
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

export function serializeMimeType(input: string): string {
  const value = trimHttpWhitespace(input);
  const slash = value.indexOf("/");
  if (slash <= 0) return "";

  const type = value.slice(0, slash);
  if (!hasOnlyCodePoints(type, isHttpTokenCodePoint)) return "";

  let position = slash + 1;
  const semicolon = value.indexOf(";", position);
  const subtypeEnd = semicolon < 0 ? value.length : semicolon;
  const subtype = trimTrailingHttpWhitespace(value.slice(position, subtypeEnd));
  if (subtype === "" || !hasOnlyCodePoints(subtype, isHttpTokenCodePoint)) {
    return "";
  }

  const parameters = new Map<string, string>();
  position = semicolon < 0 ? value.length : semicolon;
  while (position < value.length) {
    position++;
    while (position < value.length && isHttpWhitespace(codePointAt(value, position))) {
      position += codePointLength(codePointAt(value, position));
    }

    const nameStart = position;
    while (position < value.length && value[position] !== ";" && value[position] !== "=") {
      position += codePointLength(codePointAt(value, position));
    }
    const name = value.slice(nameStart, position).toLowerCase();
    if (position < value.length && value[position] === ";") continue;
    if (position < value.length) position++;
    if (position >= value.length) break;

    let parameterValue = "";
    if (value[position] === '"') {
      const quotedValue = readQuotedParameterValue(value, position);
      parameterValue = quotedValue.value;
      position = quotedValue.position;
      while (position < value.length && value[position] !== ";") {
        position += codePointLength(codePointAt(value, position));
      }
    } else {
      const valueStart = position;
      while (position < value.length && value[position] !== ";") {
        position += codePointLength(codePointAt(value, position));
      }
      parameterValue = trimTrailingHttpWhitespace(value.slice(valueStart, position));
      if (parameterValue === "") continue;
    }

    if (
      name !== "" &&
      hasOnlyCodePoints(name, isHttpTokenCodePoint) &&
      isHttpQuotedString(parameterValue) &&
      !parameters.has(name)
    ) {
      parameters.set(name, parameterValue);
    }
  }

  let serialized = `${type.toLowerCase()}/${subtype.toLowerCase()}`;
  for (const [name, parameterValue] of parameters) {
    serialized += `;${name}=${serializeParameterValue(parameterValue)}`;
  }
  return serialized;
}
