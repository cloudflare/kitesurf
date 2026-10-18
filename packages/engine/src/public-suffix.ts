// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Applies host suffix rules used by cookie-domain and same-site checks.

const MULTI_LABEL_SUFFIX_HEADS = new Set([
  "co",
  "com",
  "net",
  "org",
  "gov",
  "edu",
  "ac",
  "mil",
  "or",
  "ne",
  "go",
]);

export function isIpHost(host: string): boolean {
  return /^[\d.]+$/.test(host) || host.includes(":");
}

export function siteKey(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (isIpHost(h)) return h;
  const labels = h.split(".");
  if (labels.length <= 2) return h;
  const suffixHead = labels[labels.length - 2] ?? "";
  const take = MULTI_LABEL_SUFFIX_HEADS.has(suffixHead) ? 3 : 2;
  return labels.slice(-take).join(".");
}

export function isPublicSuffix(domain: string): boolean {
  const h = domain.toLowerCase().replace(/\.$/, "").replace(/^\./, "");
  if (!h) return true;
  if (isIpHost(h)) return false;
  const labels = h.split(".");
  if (labels.length === 1) return true;
  if (labels.length === 2 && MULTI_LABEL_SUFFIX_HEADS.has(labels[0] ?? "")) {
    return true;
  }
  return false;
}
