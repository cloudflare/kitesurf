// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Fetch Metadata request headers (Sec-Fetch-*) for the top-level navigations the engine makes.

import { siteKey } from "./public-suffix.ts";

export type NavigationStarter = "input" | "script";

// Sec-Fetch-Site for a request to `url` that a document at `initiatorOrigin` made. An initiator
// with no tuple origin, such as a data: page, is cross-site to everything, itself included.
export function fetchSite(
  initiatorOrigin: string | null,
  url: string,
): "same-origin" | "same-site" | "cross-site" {
  let from: URL;
  let to: URL;
  try {
    from = new URL(initiatorOrigin ?? "");
    to = new URL(url);
  } catch {
    return "cross-site";
  }
  if (from.origin === "null" || to.origin === "null") return "cross-site";
  if (from.origin === to.origin) return "same-origin";
  const sameSite = from.protocol === to.protocol && siteKey(from.hostname) === siteKey(to.hostname);
  return sameSite ? "same-site" : "cross-site";
}

// Fetch Metadata goes only to a potentially trustworthy URL: one over TLS, or on this machine.
// A plain-http hop of a redirect chain loses the headers and a later https hop has them again.
export function takesFetchMetadata(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:" || parsed.protocol === "wss:") return true;
  const host = parsed.hostname;
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

// What a browser adds to a top-level navigation: where it goes, who asked for it, and whether a
// person did. Servers read a navigation without these as a script's request, not a visit.
export function navigationFetchMetadata(
  startedBy: NavigationStarter | undefined,
  initiatorOrigin: string | null,
  url: string,
): Record<string, string> {
  return {
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": startedBy === undefined ? "none" : fetchSite(initiatorOrigin, url),
    ...(startedBy === "script" ? {} : { "sec-fetch-user": "?1" }),
    "upgrade-insecure-requests": "1",
  };
}
