// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { Hono } from "hono";

const htmlCache = new Map<string, string>();
const assetCache = new Map<string, { body: ArrayBuffer; type: string }>();

const ALLOWED_HOSTS = new Set(["radar.cloudflare.com"]);

const proxyAssetUrls = (text: string, host: string) =>
  text.replaceAll("/assets/", `/__fixtures/snapshot/${host}/assets/`);

export const snapshot = new Hono();

async function snapshotAsset(host: string, rest: string): Promise<Response> {
  const key = host + rest;
  let hit = assetCache.get(key);
  if (!hit) {
    const upstream = await fetch(`https://${host}${rest}`);
    if (!upstream.ok) {
      return new Response(`asset upstream ${upstream.status}`, { status: 502 });
    }
    const type = upstream.headers.get("content-type") || "application/octet-stream";
    let body: ArrayBuffer;
    if (/javascript|ecmascript|css|json/i.test(type)) {
      const text = proxyAssetUrls(await upstream.text(), host);
      body = new TextEncoder().encode(text).buffer as ArrayBuffer;
    } else {
      body = await upstream.arrayBuffer();
    }
    hit = { body, type };
    assetCache.set(key, hit);
  }
  return new Response(hit.body.slice(0), {
    headers: { "content-type": hit.type, "cache-control": "no-store" },
  });
}

async function snapshotDocument(host: string, rest: string): Promise<Response> {
  const key = host + rest;
  let html = htmlCache.get(key);
  if (!html) {
    const upstream = await fetch(`https://${host}${rest}`, {
      headers: { accept: "text/html", "user-agent": "Mozilla/5.0 (snapshot-fixture)" },
    });
    if (!upstream.ok) {
      return new Response(`page upstream ${upstream.status}`, { status: 502 });
    }
    html = proxyAssetUrls(await upstream.text(), host);
    htmlCache.set(key, html);
  }
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

snapshot.all("/snapshot/:host/*", async (c) => {
  const host = c.req.param("host");
  const rest = c.req.path.slice(`/__fixtures/snapshot/${host}`.length) || "/";
  if (!ALLOWED_HOSTS.has(host)) {
    return new Response("host not allowed", { status: 403 });
  }

  if (rest.startsWith("/assets/")) {
    return snapshotAsset(host, rest);
  }

  return snapshotDocument(host, rest);
});
