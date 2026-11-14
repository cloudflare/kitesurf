// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Provides shared string conversions for CSS, HTML, and DOM name handling.

export function asciiLowercase(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 0x41 && c <= 0x5a ? String.fromCharCode(c + 0x20) : s[i];
  }
  return out;
}

export function camelToDash(s: unknown): string {
  return String(s).replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
}

const VENDOR_PREFIXES = ["webkit", "moz", "ms", "o"];

export function cssPropCamelToKebab(s: unknown): string {
  const str = String(s);
  if (str.length === 0) return str;
  if (str.startsWith("--")) return str;
  let kebab = str.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
  for (const p of VENDOR_PREFIXES) {
    if (kebab.startsWith(p + "-")) {
      kebab = "-" + kebab;
      break;
    }
  }
  return kebab;
}

export function styleDeclKey(prop: string | symbol): string | symbol {
  if (typeof prop !== "string") return prop;
  if (prop === "cssFloat") return "float";
  return prop.indexOf("-") >= 0 ? cssPropToCamel(prop) : prop;
}

export function cssPropToCamel(s: unknown): string {
  const str = String(s);
  if (str.startsWith("--")) return str;
  const body = str.startsWith("-") ? str.slice(1) : str;
  return body.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

export function parseCssTextInto(cssText: unknown, out: Record<string, string>): void {
  const decls = String(cssText).split(";");
  for (const decl of decls) {
    const trimmed = decl.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) continue;
    const name = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!name) continue;
    out[cssPropToCamel(name)] = value;
  }
}

export function serializeStyleData(data: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const k of Object.keys(data)) {
    const v = data[k];
    if (v == null || v === "") continue;
    if (typeof k === "string" && k.startsWith("__")) continue;
    parts.push(cssPropCamelToKebab(k) + ": " + v + ";");
  }
  return parts.join(" ");
}

export function escapeHtmlText(s: unknown): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeHtmlAttr(s: unknown): string {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function cssEscape(s: unknown): string {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (ch) => "\\" + ch);
}

// CSSOM "serialize a string", quotes included. Escaping per code point keeps astral characters
// whole, and hex escapes keep controls such as a newline from reading as a line continuation.
export function cssString(s: unknown): string {
  let out = '"';
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0) out += "\uFFFD";
    else if (cp < 0x20 || cp === 0x7f) out += "\\" + cp.toString(16) + " ";
    else if (ch === '"' || ch === "\\") out += "\\" + ch;
    else out += ch;
  }
  return out + '"';
}

// A thrown value's message, else the value as a string. Reads `message`
// the way `(e as { message?: unknown })?.message` would, primitives
// included.
export function errorMessage(e: unknown): string {
  if (e == null) return String(e);
  const message: unknown = Reflect.get(Object(e), "message");
  return message != null ? String(message) : String(e);
}
