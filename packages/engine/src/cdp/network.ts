// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements CDP Network commands for cookies, headers, and request tracking.

import type { CdpRequest, TargetState } from "./types.ts";
import type { DispatchCtx } from "./dispatch.ts";
import { entryToCdp, setCdpCookie } from "../cookies.ts";
import { jarForContextId, jarForTarget } from "./target.ts";

export async function handleNetwork(ctx: DispatchCtx, req: CdpRequest): Promise<unknown> {
  switch (req.method) {
    case "Network.enable":
      return enableNetwork(ctx, req);

    case "Network.disable":
      return disableNetwork(ctx, req.sessionId);

    case "Network.setCacheDisabled":
    case "Network.setBypassServiceWorker":
      return {};

    case "Network.setUserAgentOverride": {
      return setUserAgentOverride(ctx, req);
    }

    case "Network.setExtraHTTPHeaders": {
      return setExtraHttpHeaders(ctx, req);
    }

    case "Network.getAllCookies": {
      return getAllCookies(ctx, req.sessionId);
    }

    case "Network.getCookies": {
      return getCookies(ctx, req);
    }

    case "Network.setCookie": {
      return setCookie(ctx, req);
    }

    case "Network.setCookies": {
      return setCookies(ctx, req);
    }

    case "Network.deleteCookies": {
      return deleteCookies(ctx, req);
    }

    case "Network.clearBrowserCookies": {
      return clearBrowserCookies(ctx, req.sessionId);
    }

    case "Storage.getCookies": {
      return getStorageCookies(ctx, req);
    }

    case "Storage.setCookies": {
      return setStorageCookies(ctx, req);
    }

    case "Storage.clearCookies": {
      return clearStorageCookies(ctx, req);
    }

    case "Network.clearBrowserCache":
      return {};

    case "Network.emulateNetworkConditionsByRule":
      return { ruleIds: [] };

    case "Network.getResponseBody": {
      return getResponseBody(ctx, req);
    }

    default:
      return {};
  }
}

function enableNetwork(
  ctx: DispatchCtx,
  req: Extract<CdpRequest, { method: "Network.enable" }>,
): Record<string, never> {
  ctx.browser.networkEvents.setEnabled(req.sessionId, true, {
    maxTotalBufferSize: req.params?.maxTotalBufferSize,
    maxResourceBufferSize: req.params?.maxResourceBufferSize,
  });
  return {};
}

function disableNetwork(ctx: DispatchCtx, sessionId: string | undefined): Record<string, never> {
  ctx.browser.networkEvents.setEnabled(sessionId, false);
  return {};
}

function setUserAgentOverride(
  ctx: DispatchCtx,
  req: Extract<CdpRequest, { method: "Network.setUserAgentOverride" }>,
): Record<string, never> {
  const ua = typeof req.params?.userAgent === "string" ? req.params.userAgent : "";
  const resolved = resolveNetworkTarget(ctx, req.sessionId);
  if (resolved) resolved.userAgentOverride = ua;
  return {};
}

function setExtraHttpHeaders(
  ctx: DispatchCtx,
  req: Extract<CdpRequest, { method: "Network.setExtraHTTPHeaders" }>,
): Record<string, never> {
  const sanitized = sanitizeExtraHttpHeaders(req.params?.headers ?? {});
  const resolved = resolveNetworkTarget(ctx, req.sessionId);
  if (resolved) resolved.extraHttpHeaders = sanitized;
  return {};
}

function sanitizeExtraHttpHeaders(headers: Record<string, unknown>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof key !== "string" || typeof value !== "string") continue;
    if (key.toLowerCase().startsWith("x-kitesurf-")) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

function getAllCookies(
  ctx: DispatchCtx,
  sessionId: string | undefined,
): { cookies: ReturnType<typeof entryToCdp>[] } {
  const jar = jarForTarget(ctx, resolveNetworkTarget(ctx, sessionId));
  return { cookies: jar.getAll().map(entryToCdp) };
}

function getCookies(
  ctx: DispatchCtx,
  req: Extract<CdpRequest, { method: "Network.getCookies" }>,
): { cookies: ReturnType<typeof entryToCdp>[] } {
  const jar = jarForTarget(ctx, resolveNetworkTarget(ctx, req.sessionId));
  const urls = req.params?.urls;
  if (!urls || urls.length === 0) return { cookies: jar.getAll().map(entryToCdp) };
  return { cookies: cookiesForUrls(jar, urls) };
}

function cookiesForUrls(jar: ReturnType<typeof jarForTarget>, urls: string[]) {
  const seen = new Set<string>();
  const out = [];
  for (const url of urls) {
    for (const cookie of jar.getForUrl(url)) {
      const key = cookie.host + "\\u0000" + cookie.path + "\\u0000" + cookie.name;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entryToCdp(cookie));
    }
  }
  return out;
}

function setCookie(
  ctx: DispatchCtx,
  req: Extract<CdpRequest, { method: "Network.setCookie" }>,
): { success: boolean } {
  const jar = jarForTarget(ctx, resolveNetworkTarget(ctx, req.sessionId));
  return { success: setCdpCookie(jar, req.params) !== null };
}

function setCookies(
  ctx: DispatchCtx,
  req: Extract<CdpRequest, { method: "Network.setCookies" }>,
): Record<string, never> {
  applyCookies(jarForTarget(ctx, resolveNetworkTarget(ctx, req.sessionId)), req.params?.cookies);
  return {};
}

function applyCookies(jar: ReturnType<typeof jarForTarget>, list: unknown): void {
  if (Array.isArray(list)) for (const cookie of list) setCdpCookie(jar, cookie);
}

function deleteCookies(
  ctx: DispatchCtx,
  req: Extract<CdpRequest, { method: "Network.deleteCookies" }>,
): Record<string, never> {
  const params = req.params!;
  if (!params.name) return {};
  const jar = jarForTarget(ctx, resolveNetworkTarget(ctx, req.sessionId));
  jar.remove({
    name: params.name,
    url: params.url,
    domain: params.domain,
    path: params.path,
  });
  return {};
}

function clearBrowserCookies(
  ctx: DispatchCtx,
  sessionId: string | undefined,
): Record<string, never> {
  jarForTarget(ctx, resolveNetworkTarget(ctx, sessionId)).clear();
  return {};
}

function getStorageCookies(
  ctx: DispatchCtx,
  req: Extract<CdpRequest, { method: "Storage.getCookies" }>,
): { cookies: ReturnType<typeof entryToCdp>[] } {
  const jar = jarForContextId(ctx, req.params?.browserContextId);
  return { cookies: jar.getAll().map(entryToCdp) };
}

function setStorageCookies(
  ctx: DispatchCtx,
  req: Extract<CdpRequest, { method: "Storage.setCookies" }>,
): Record<string, never> {
  applyCookies(jarForContextId(ctx, req.params?.browserContextId), req.params?.cookies);
  return {};
}

function clearStorageCookies(
  ctx: DispatchCtx,
  req: Extract<CdpRequest, { method: "Storage.clearCookies" }>,
): Record<string, never> {
  jarForContextId(ctx, req.params?.browserContextId).clear();
  return {};
}

function getResponseBody(
  ctx: DispatchCtx,
  req: Extract<CdpRequest, { method: "Network.getResponseBody" }>,
): NonNullable<ReturnType<DispatchCtx["browser"]["networkEvents"]["getResponseBody"]>> {
  const requestId = req.params!.requestId;
  if (!requestId) return { body: "", base64Encoded: false };
  const found = ctx.browser.networkEvents.getResponseBody(requestId);
  if (!found) return { body: "", base64Encoded: false };
  return found;
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

function resolveNetworkTarget(
  ctx: DispatchCtx,
  sessionId: string | undefined,
): TargetState | undefined {
  if (sessionId) {
    const target = targetForSession(ctx, sessionId);
    if (target) return target;
  }
  return firstPageTarget(ctx);
}

function targetForSession(ctx: DispatchCtx, sessionId: string): TargetState | undefined {
  for (const target of ctx.browser.targets.values()) {
    if (target.sessions.has(sessionId)) return target;
  }
  return undefined;
}

function firstPageTarget(ctx: DispatchCtx): TargetState | undefined {
  for (const t of ctx.browser.targets.values()) {
    if (t.type === "page") return t;
  }
  return undefined;
}
