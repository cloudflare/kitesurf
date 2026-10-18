
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

export function mapProbe(m) {
  m.set("k", 42);
  return { get: m.get("k"), size: m.size, isMap: m instanceof Map, spread: Array.from(m).length };
}
export function setProbe(s) {
  s.add("x");
  return { has: s.has("x"), size: s.size, isSet: s instanceof Set, spread: Array.from(s).length };
}
export function dateProbe(d) {
  return { time: d.getTime(), isDate: d instanceof Date };
}
export function reProbe(re, str) {
  return { test: re.test(str), isRe: re instanceof RegExp, source: re.source };
}
export function makeMap() { const m = new Map(); m.set("a", 1); return m; }
export function makeDate() { return new Date(1000); }
export function tagProbe(x) { return Object.prototype.toString.call(x); }
