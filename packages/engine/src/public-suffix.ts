// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Applies host suffix rules used by cookie-domain and same-site checks.

import PUBLIC_SUFFIX_LIST from "./public-suffix-list.dat";

interface PublicSuffixRules {
  exact: Set<string>;
  wildcard: Set<string>;
  exception: Set<string>;
  maxLabels: number;
}

let cachedRules: PublicSuffixRules | undefined;

// The list ships unmodified (MPL-2.0) and is parsed once per isolate, so repeated host
// checks reuse the same sets. Every rule is stored as ASCII lowercase, as the list mixes
// punycode with Unicode IDN entries.
function publicSuffixRules(): PublicSuffixRules {
  if (cachedRules) return cachedRules;
  const exact = new Set<string>();
  const wildcard = new Set<string>();
  const exception = new Set<string>();
  let maxLabels = 0;
  for (const raw of PUBLIC_SUFFIX_LIST.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("//")) continue;
    const kind = line.startsWith("!") ? exception : line.startsWith("*.") ? wildcard : exact;
    const body = kind === exception ? line.slice(1) : kind === wildcard ? line.slice(2) : line;
    const rule = /[^\x00-\x7f]/u.test(body)
      ? new URL(`https://${body}/`).hostname
      : body.toLowerCase();
    kind.add(rule);
    maxLabels = Math.max(maxLabels, rule.split(".").length);
  }
  // A broken text module must fail loudly instead of treating every host as its own site.
  if (!exact.size || !wildcard.size || !exception.size) {
    throw new Error("public suffix list has no rules");
  }
  cachedRules = { exact, wildcard, exception, maxLabels };
  return cachedRules;
}

// The number of trailing labels that form the public suffix, from the vendored Public Suffix
// List. Every tail up to the longest stored rule is checked, so the cost is bounded by the list
// rather than by a page-chosen host.
function publicSuffixLength(labels: string[]): number {
  const { exact, wildcard, exception, maxLabels } = publicSuffixRules();
  let best = 1; // The PSL default rule is *.
  let exceptionLength = 0;
  const limit = Math.min(labels.length, maxLabels + 1);
  for (let count = 1; count <= limit; count++) {
    const suffix = labels.slice(-count).join(".");
    if (exception.has(suffix)) exceptionLength = Math.max(exceptionLength, count);
    if (exact.has(suffix)) best = Math.max(best, count);
    if (count > 1 && wildcard.has(labels.slice(-(count - 1)).join("."))) {
      best = Math.max(best, count);
    }
  }
  return exceptionLength > 0 ? exceptionLength - 1 : best;
}

export function isIpHost(host: string): boolean {
  return /^[\d.]+$/.test(host) || host.includes(":");
}

export function siteKey(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (!h || isIpHost(h)) return h;
  const labels = h.split(".");
  const suffix = publicSuffixLength(labels);
  return labels.slice(-Math.min(labels.length, suffix + 1)).join(".");
}

export function schemefulSite(raw: string | URL): string | null {
  try {
    const url = typeof raw === "string" ? new URL(raw) : raw;
    const scheme =
      url.protocol === "ws:" ? "http:" : url.protocol === "wss:" ? "https:" : url.protocol;
    if ((scheme !== "http:" && scheme !== "https:") || !url.hostname) return null;
    return `${scheme}//${siteKey(url.hostname)}`;
  } catch {
    return null;
  }
}

export function isPublicSuffix(domain: string): boolean {
  const h = domain.toLowerCase().replace(/\.$/, "").replace(/^\./, "");
  if (!h) return true;
  if (isIpHost(h)) return false;
  const labels = h.split(".");
  return publicSuffixLength(labels) === labels.length;
}
