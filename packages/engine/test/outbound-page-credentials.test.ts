// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A page-realm request that carries no credentials mode gets fetch's default ("same-origin"),
// so a cross-origin hop sends no jar cookie even when the response admits any origin. The
// engine realm's own egress keeps sending jar cookies without a carrier.

import { afterEach, describe, expect, it } from "vitest";
import { registerCookieJar, unregisterCookieJar } from "../src/cdp/cookie-jar-registry.ts";
import { createCookieJar } from "../src/cookies.ts";
import {
  createSandboxOutboundOverride,
  type SandboxOutboundEnv,
  type SandboxOutboundExports,
} from "../src/eval/outbound.ts";

const KEY = "outbound-page-credentials";
const ORIGIN = "https://attacker.example";
const PAGE = `${ORIGIN}/page`;
const CROSS_ORIGIN = "https://victim.example/sse";
const SAME_ORIGIN = `${ORIGIN}/sse`;
const SECRET = "sid=SECRET";
const BODY = "data: hello\n\n";

afterEach(() => unregisterCookieJar(KEY));

// The real gateway and the real jar; the victim answers `Access-Control-Allow-Origin: *`, which
// a credentialed request would have to reject.
async function send(pageRealm: boolean, url: string) {
  const jar = createCookieJar();
  jar.setFromHeader(`${new URL(url).origin}/`, "sid=SECRET; Secure; Path=/; SameSite=None");
  registerCookieJar(KEY, jar);
  const seen: Array<string | null> = [];
  const outbound = createSandboxOutboundOverride(
    {} as SandboxOutboundExports,
    {} as SandboxOutboundEnv,
    {
      fetch: async (request) => {
        seen.push(request.headers.get("cookie"));
        return new Response(BODY, {
          headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
        });
      },
    },
  );
  const fetcher = outbound.parent({
    pageOrigin: ORIGIN,
    pageUrl: PAGE,
    connectionId: KEY,
    cookieKey: KEY,
    pageRealm,
  });
  const response = await fetcher.fetch(new Request(url));
  return { seen, readable: await response.text() };
}

describe("page-realm requests default to same-origin credentials", () => {
  it.each([
    ["page realm cross-origin sends no cookie", true, CROSS_ORIGIN, [null]],
    ["page realm same-origin sends the cookie", true, SAME_ORIGIN, [SECRET]],
    ["engine realm cross-origin still sends the cookie", false, CROSS_ORIGIN, [SECRET]],
  ] as const)("%s", async (_name, pageRealm, url, cookies) => {
    const got = await send(pageRealm, url);
    expect([got.seen, got.readable]).toEqual([cookies, BODY]);
  });
});
