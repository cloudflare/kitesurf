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
const TRUSTWORTHY_SCHEMES = new Set(["data:", "file:", "https:", "wss:"]);

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
  if (TRUSTWORTHY_SCHEMES.has(url.protocol)) return true;
  return isLocalHost(url.hostname);
}

function isLocalHost(host: string): boolean {
  return (
    host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]"
  );
}

interface ReferrerUrls {
  source: URL;
  target: URL;
}

function parseReferrerUrls(sourceUrl: string, targetUrl: string): ReferrerUrls | null {
  try {
    return { source: new URL(sourceUrl), target: new URL(targetUrl) };
  } catch {
    return null;
  }
}

function referrerForDowngrade(downgrade: boolean, value: string): string {
  return downgrade ? "" : value;
}

function defaultReferrer(
  sameOrigin: boolean,
  downgrade: boolean,
  full: string,
  originOnly: string,
): string {
  if (sameOrigin) return full;
  return referrerForDowngrade(downgrade, originOnly);
}

function referrerForPolicy(
  policy: string,
  sameOrigin: boolean,
  downgrade: boolean,
  full: string,
  originOnly: string,
): string {
  switch (policy) {
    case "no-referrer":
      return "";
    case "no-referrer-when-downgrade":
      return referrerForDowngrade(downgrade, full);
    case "same-origin":
      return sameOrigin ? full : "";
    case "origin":
      return originOnly;
    case "strict-origin":
      return referrerForDowngrade(downgrade, originOnly);
    case "origin-when-cross-origin":
      return sameOrigin ? full : originOnly;
    case "unsafe-url":
      return full;
    default:
      return defaultReferrer(sameOrigin, downgrade, full, originOnly);
  }
}

function hasHttpSource(source: URL): boolean {
  return source.protocol === "http:" || source.protocol === "https:";
}

function sameOrigin(source: URL, target: URL): boolean {
  return target.origin !== "null" && target.origin === source.origin;
}

function isDowngrade(source: URL, target: URL): boolean {
  return source.protocol === "https:" && !isPotentiallyTrustworthy(target);
}

/** Returns the policy-selected referrer, or an empty string when none is sent. */
export function determineReferrer(sourceUrl: string, targetUrl: string, policy: string): string {
  const urls = parseReferrerUrls(sourceUrl, targetUrl);
  if (urls === null) return "";
  const { source, target } = urls;
  // A local-scheme source (about:, data:, blob:) has no URL to send.
  if (!hasHttpSource(source)) return "";
  source.hash = "";
  source.username = "";
  source.password = "";
  const full = source.href;
  const originOnly = source.origin + "/";
  return referrerForPolicy(
    policy,
    sameOrigin(source, target),
    isDowngrade(source, target),
    full,
    originOnly,
  );
}
