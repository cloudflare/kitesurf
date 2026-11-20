// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements CDP Network commands for cookies, headers, and request tracking.

import type { CdpRequest, TargetState } from "./types.ts";
import type { DispatchCtx } from "./dispatch.ts";
import { entryToCdp, setCdpCookie, type CookieJar } from "../cookies.ts";
import { jarForContextId, jarForTarget, localStorageForTarget } from "./target.ts";
import { localStorageOrigin } from "../state/local-storage.ts";

export async function handleNetwork(ctx: DispatchCtx, req: CdpRequest): Promise<unknown> {
  switch (req.method) {
    case "Network.enable":
      ctx.browser.networkEvents.setEnabled(req.sessionId, true, {
        maxTotalBufferSize: req.params?.maxTotalBufferSize,
        maxResourceBufferSize: req.params?.maxResourceBufferSize,
      });
      return {};

    case "Network.disable":
      ctx.browser.networkEvents.setEnabled(req.sessionId, false);
      return {};

    case "Network.setCacheDisabled":
    case "Network.setBypassServiceWorker":
      return {};

    case "Network.setUserAgentOverride": {
      const ua = typeof req.params?.userAgent === "string" ? req.params.userAgent : "";
      const resolved = resolveNetworkTarget(ctx, req.sessionId);
      if (resolved) resolved.userAgentOverride = ua;
      return {};
    }

    case "Network.setExtraHTTPHeaders": {
      const headers = req.params?.headers ?? {};
      const sanitized: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers)) {
        if (typeof k !== "string" || typeof v !== "string") continue;
        if (k.toLowerCase().startsWith("x-kitesurf-")) continue;
        sanitized[k] = v;
      }
      const resolved = resolveNetworkTarget(ctx, req.sessionId);
      if (resolved) resolved.extraHttpHeaders = sanitized;
      return {};
    }

    case "Network.getAllCookies": {
      const jar = jarForTarget(ctx, resolveNetworkTarget(ctx, req.sessionId));
      return { cookies: jar.getAll().map(entryToCdp) };
    }

    case "Network.getCookies": {
      const jar = jarForTarget(ctx, resolveNetworkTarget(ctx, req.sessionId));
      const urls = req.params?.urls;
      if (!urls || urls.length === 0) {
        return { cookies: jar.getAll().map(entryToCdp) };
      }
      const seen = new Set<string>();
      const out = [];
      for (const u of urls) {
        for (const c of jar.getForUrl(u)) {
          const key = c.host + "\\u0000" + c.path + "\\u0000" + c.name;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(entryToCdp(c));
        }
      }
      return { cookies: out };
    }

    case "Network.setCookie": {
      const jar = jarForTarget(ctx, resolveNetworkTarget(ctx, req.sessionId));
      return { success: setCdpCookie(jar, req.params) !== null };
    }

    case "Network.setCookies": {
      const jar = jarForTarget(ctx, resolveNetworkTarget(ctx, req.sessionId));
      const list: unknown = req.params?.cookies;
      if (Array.isArray(list)) for (const c of list) setCdpCookie(jar, c);
      return {};
    }

    case "Network.deleteCookies": {
      const p = req.params!;
      if (!p.name) return {};
      const jar = jarForTarget(ctx, resolveNetworkTarget(ctx, req.sessionId));
      jar.remove({
        name: p.name,
        url: p.url,
        domain: p.domain,
        path: p.path,
      });
      return {};
    }

    case "Network.clearBrowserCookies": {
      const jar = jarForTarget(ctx, resolveNetworkTarget(ctx, req.sessionId));
      jar.clear();
      return {};
    }

    case "Storage.getCookies": {
      const sjar = jarForContextId(ctx, req.params?.browserContextId);
      return { cookies: sjar.getAll().map(entryToCdp) };
    }

    case "Storage.setCookies": {
      const sjar = jarForContextId(ctx, req.params?.browserContextId);
      const list: unknown = req.params?.cookies;
      if (Array.isArray(list)) for (const c of list) setCdpCookie(sjar, c);
      return {};
    }

    case "Storage.clearCookies": {
      jarForContextId(ctx, req.params?.browserContextId).clear();
      return {};
    }

    case "Storage.clearDataForOrigin": {
      const origin = req.params?.origin;
      const url = typeof origin === "string" ? parseUrl(origin) : null;
      if (!url) throw new Error(`${String(origin)} is not a valid URL`);
      clearOriginData(ctx, req.sessionId, url, req.params?.storageTypes);
      return {};
    }

    case "Storage.clearDataForStorageKey": {
      const key = req.params?.storageKey;
      // A partitioned key ("https://a.test/^0https://b.test") names data Kitesurf never keeps.
      const partitioned = typeof key === "string" && key.includes("^");
      const url = typeof key === "string" ? parseUrl(key.split("^", 1)[0] ?? "") : null;
      if (!url) throw new Error("Invalid Storage Key given.");
      clearOriginData(ctx, req.sessionId, partitioned ? null : url, req.params?.storageTypes);
      return {};
    }

    case "Network.clearBrowserCache":
      return {};

    case "Network.emulateNetworkConditionsByRule":
      return { ruleIds: [] };

    case "Network.getResponseBody": {
      const requestId = req.params!.requestId;
      const tracker = ctx.browser.networkEvents;
      // Chrome rejects an id it never issued. Kitesurf keeps fewer bodies than Chrome, so a known
      // request whose body it dropped answers empty rather than failing a read Chrome would serve.
      if (!requestId || !tracker.knowsRequest(requestId)) {
        throw new Error("No resource with given identifier found");
      }
      return tracker.getResponseBody(requestId) ?? { body: "", base64Encoded: false };
    }

    default:
      return {};
  }
}

export function effectiveExtraHeaders(t: TargetState): Record<string, string> {
  if (!t.userAgentOverride) return t.extraHttpHeaders;
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(t.extraHttpHeaders)) {
    if (k.toLowerCase() === "user-agent") continue;
    merged[k] = v;
  }
  merged["user-agent"] = t.userAgentOverride;
  return merged;
}

// Protocol.Storage.StorageType. Chromium ignores names it does not know and fails only when no
// name is valid. Kitesurf keeps only cookies and localStorage, so the other types clear nothing.
const STORAGE_TYPES = new Set([
  "cookies",
  "file_systems",
  "indexeddb",
  "local_storage",
  "shader_cache",
  "websql",
  "service_workers",
  "cache_storage",
  "interest_groups",
  "shared_storage",
  "storage_buckets",
  "all",
  "other",
]);

// Storage.clearDataFor*: the browser session clears the default context, a page or frame session
// its own context. A null `url` validates the request and clears nothing. Open pages see a
// localStorage clear from their next navigation on.
function clearOriginData(
  ctx: DispatchCtx,
  sessionId: string | undefined,
  url: URL | null,
  storageTypes: unknown,
): void {
  const target = storageSessionTarget(ctx, sessionId);
  const types = new Set(
    typeof storageTypes === "string"
      ? storageTypes
          .split(",")
          .map((t) => t.trim())
          .filter((t) => STORAGE_TYPES.has(t))
      : [],
  );
  if (types.size === 0) throw new Error("No valid storage type specified");
  if (!url) return;
  const all = types.has("all");
  if (all || types.has("cookies")) clearCookiesForHost(jarForTarget(ctx, target), url.hostname);
  const origin = localStorageOrigin(url.href);
  if (origin && (all || types.has("local_storage"))) {
    localStorageForTarget(ctx, target).apply(origin, [{ op: "clear" }]);
  }
}

// The target whose browser context a session names. An unknown session fails rather than fall
// back to the default context, as jarForContextId does for an unknown context id.
function storageSessionTarget(
  ctx: DispatchCtx,
  sessionId: string | undefined,
): TargetState | undefined {
  if (!sessionId) return undefined;
  for (const t of ctx.browser.targets.values()) {
    if (t.sessions.has(sessionId)) return t;
    for (const f of t.frames.values()) if (f.sessions.has(sessionId)) return t;
  }
  throw new Error("Session with given id not found.");
}

// Every cookie a request to `host` would carry: host-only cookies of the host and domain cookies
// of the host or a parent domain.
function clearCookiesForHost(jar: CookieJar, host: string): void {
  if (!host) return;
  for (const c of jar.getAll()) {
    const matches = c.hostOnly ? c.host === host : c.host === host || host.endsWith(`.${c.host}`);
    if (matches) jar.remove({ name: c.name, domain: c.host, path: c.path });
  }
}

function parseUrl(s: string): URL | null {
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

function resolveNetworkTarget(
  ctx: DispatchCtx,
  sessionId: string | undefined,
): TargetState | undefined {
  if (sessionId) {
    for (const t of ctx.browser.targets.values()) {
      if (t.sessions.has(sessionId)) return t;
    }
  }
  for (const t of ctx.browser.targets.values()) {
    if (t.type === "page") return t;
  }
  return undefined;
}
