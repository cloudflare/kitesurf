// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements CDP Network commands for cookies, headers, and request tracking.

import type { CdpRequest, TargetState } from "./types.ts";
import type { DispatchCtx } from "./dispatch.ts";
import { entryToCdp, setCdpCookie } from "../cookies.ts";
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

    case "Storage.clearDataForOrigin":
      clearLocalStorageData(ctx, req.sessionId, req.params?.origin, req.params?.storageTypes);
      return {};

    case "Storage.clearDataForStorageKey":
      clearLocalStorageData(ctx, req.sessionId, req.params?.storageKey, req.params?.storageTypes);
      return {};

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

// Only `local_storage` (or `all`) clears anything; the other storage types stay no-ops. The browser
// session clears the default context. Open pages see the clear from their next navigation on.
function clearLocalStorageData(
  ctx: DispatchCtx,
  sessionId: string | undefined,
  originOrKey: unknown,
  storageTypes: unknown,
): void {
  // A partitioned storage key ("https://a.test/^0https://b.test") names an area Kitesurf lacks.
  if (typeof originOrKey !== "string" || originOrKey.includes("^")) return;
  const types =
    typeof storageTypes === "string" ? storageTypes.split(",").map((t) => t.trim()) : [];
  if (!types.includes("local_storage") && !types.includes("all")) return;
  const origin = localStorageOrigin(originOrKey);
  if (!origin) return;
  let target: TargetState | undefined;
  for (const t of ctx.browser.targets.values())
    if (sessionId && t.sessions.has(sessionId)) target = t;
  localStorageForTarget(ctx, target).apply(origin, [{ op: "clear" }]);
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
