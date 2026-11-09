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

// Multi-tenant hosts from the private section of the Public Suffix List, where each tenant is
// its own site. Without them, a.github.io could set Domain=github.io cookies for b.github.io.
// Only widely used entries are listed; other hosting platforms still merge tenants.
const PRIVATE_SUFFIXES = new Set([
  "amplifyapp.com",
  "appspot.com",
  "azurestaticapps.net",
  "azurewebsites.net",
  "bitbucket.io",
  "blogspot.com",
  "cloudfront.net",
  "codeberg.page",
  "deno.dev",
  "firebaseapp.com",
  "fly.dev",
  "github.io",
  "githubusercontent.com",
  "gitlab.io",
  "herokuapp.com",
  "myshopify.com",
  "netlify.app",
  "ngrok-free.app",
  "ngrok.app",
  "ngrok.io",
  "onrender.com",
  "pages.dev",
  "pythonanywhere.com",
  "r2.dev",
  "readthedocs.io",
  "repl.co",
  "s3.amazonaws.com",
  "surge.sh",
  "trycloudflare.com",
  "vercel.app",
  "web.app",
  "wixsite.com",
  "workers.dev",
]);

const PRIVATE_SUFFIX_MAX_LABELS = Math.max(
  ...Array.from(PRIVATE_SUFFIXES, (s) => s.split(".").length),
);

// The number of trailing labels that form a listed private suffix, or 0. A page picks its request
// hosts, so check only tails as long as a listed suffix instead of every tail of the host.
function privateSuffixLength(labels: string[]): number {
  for (let n = Math.min(labels.length, PRIVATE_SUFFIX_MAX_LABELS); n >= 2; n--) {
    if (PRIVATE_SUFFIXES.has(labels.slice(-n).join("."))) return n;
  }
  return 0;
}

export function isIpHost(host: string): boolean {
  return /^[\d.]+$/.test(host) || host.includes(":");
}

export function siteKey(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (isIpHost(h)) return h;
  const labels = h.split(".");
  const privateLength = privateSuffixLength(labels);
  if (privateLength > 0) return labels.slice(-Math.min(labels.length, privateLength + 1)).join(".");
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
  if (privateSuffixLength(labels) === labels.length) return true;
  if (labels.length === 2 && MULTI_LABEL_SUFFIX_HEADS.has(labels[0] ?? "")) {
    return true;
  }
  return false;
}
