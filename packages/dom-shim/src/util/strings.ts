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
    if (!shouldSerializeStyleValue(k, v)) continue;
    parts.push(cssPropCamelToKebab(k) + ": " + v + ";");
  }
  return parts.join(" ");
}

function shouldSerializeStyleValue(key: string, value: unknown): boolean {
  if (value == null || value === "") return false;
  if (typeof key === "string" && key.startsWith("__")) return false;
  return true;
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

export function isReservedGlobalName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(globalThis, name);
}
