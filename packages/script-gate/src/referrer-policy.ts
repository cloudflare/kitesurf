// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Request and document.referrer decisions use the same Referrer Policy algorithm.
// https://www.w3.org/TR/referrer-policy/#determine-requests-referrer

const POLICIES = new Set([
  "no-referrer",
  "no-referrer-when-downgrade",
  "same-origin",
  "origin",
  "strict-origin",
  "origin-when-cross-origin",
  "strict-origin-when-cross-origin",
  "unsafe-url",
]);

// A Referrer-Policy header may list several tokens; the last one the UA
// recognises wins, and an empty or unknown list means the default.
export function parseReferrerPolicy(header: string | null | undefined): string {
  let policy = "";
  for (const token of String(header ?? "").split(",")) {
    const t = token.trim().toLowerCase();
    if (POLICIES.has(t)) policy = t;
  }
  return policy;
}

// Secure Contexts §potentially-trustworthy-url, reduced to the schemes
// and hosts a frame can navigate to here.
function isPotentiallyTrustworthy(url: URL): boolean {
  if (url.href === "about:blank" || url.href === "about:srcdoc") return true;
  if (url.protocol === "data:" || url.protocol === "file:") return true;
  if (url.protocol === "https:" || url.protocol === "wss:") return true;
  const host = url.hostname;
  return (
    host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]"
  );
}

/** Returns the policy-selected referrer, or an empty string when none is sent. */
export function determineReferrer(sourceUrl: string, targetUrl: string, policy: string): string {
  let source: URL;
  let target: URL;
  try {
    source = new URL(sourceUrl);
    target = new URL(targetUrl);
  } catch {
    return "";
  }
  // A local-scheme source (about:, data:, blob:) has no URL to send.
  if (source.protocol !== "http:" && source.protocol !== "https:") return "";
  source.hash = "";
  source.username = "";
  source.password = "";
  const full = source.href;
  const originOnly = source.origin + "/";
  const sameOrigin = target.origin !== "null" && target.origin === source.origin;
  const downgrade = source.protocol === "https:" && !isPotentiallyTrustworthy(target);
  switch (policy) {
    case "no-referrer":
      return "";
    case "no-referrer-when-downgrade":
      return downgrade ? "" : full;
    case "same-origin":
      return sameOrigin ? full : "";
    case "origin":
      return originOnly;
    case "strict-origin":
      return downgrade ? "" : originOnly;
    case "origin-when-cross-origin":
      return sameOrigin ? full : originOnly;
    case "unsafe-url":
      return full;
    default:
      if (sameOrigin) return full;
      return downgrade ? "" : originOnly;
  }
}
