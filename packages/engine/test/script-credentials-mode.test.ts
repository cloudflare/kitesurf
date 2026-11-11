// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// HTML fetches module scripts and `crossorigin` classic scripts with credentials mode
// "same-origin", so a cross-origin request carries no jar cookies unless the script asks for
// "use-credentials"; that mode must also demand Access-Control-Allow-Credentials.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { registerCookieJar, unregisterCookieJar } from "../src/cdp/cookie-jar-registry.ts";
import { createCookieJar } from "../src/cookies.ts";
import {
  createSandboxOutboundOverride,
  type SandboxOutboundEnv,
  type SandboxOutboundExports,
} from "../src/eval/outbound.ts";
import { prefetchExternalScripts } from "../src/eval/prefetch-scripts.ts";
import { walkModuleGraph } from "../src/eval/walk-module-graph.ts";

// The wasm-bindgen sibling is resolved from the Worker Loader's modules map at runtime.
vi.mock("../../page-script/src/wasm-glue.js", () => ({
  __setBridgeFetchResource: () => {},
  initSync: () => {},
  ks_bridge_install_desc_helpers: () => {},
  DomHandle: class {
    deliverResource(): boolean {
      return true;
    }
  },
}));

// The page-script modules load through vi.importActual: engine's tsconfig must not type-check them.
const { fetchInsertedScript } = (await vi.importActual(
  "../../page-script/src/resource-fetch.ts",
)) as {
  fetchInsertedScript: (url: string, crossOrigin?: string | null) => Promise<{ status: number }>;
};
const { captureTrustedFetch } = (await vi.importActual(
  "../../page-script/src/trusted-fetch.ts",
)) as { captureTrustedFetch: () => void };
const { installFetchShim } = (await vi.importActual("../../page-script/src/fetch-shim.ts")) as {
  installFetchShim: () => void;
};
const { state: pageScriptState } = (await vi.importActual("../../page-script/src/state.ts")) as {
  state: Record<string, unknown>;
};

const KEY = "script-credentials-mode";
const ORIGIN = "https://attacker.example";
const PAGE = `${ORIGIN}/page`;
const TARGET = "https://victim.example/app.js";
const DEP = "https://victim.example/dep.js";
const SECRET = "sid=SECRET";
const IMPORT = `import "${DEP}";`;

const realFetch = globalThis.fetch;

beforeAll(() => {
  pageScriptState.pageUrl = PAGE;
  pageScriptState.connectionId = KEY;
  pageScriptState.cookieKey = KEY;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  unregisterCookieJar(KEY);
});

// The real gateway and the real jar: `acac` decides whether the victim admits credentials.
async function fetchThrough(
  kind: "classic" | "module",
  crossOrigin: string | null,
  acac = false,
  served = "",
) {
  const jar = createCookieJar();
  jar.setFromHeader("https://victim.example/", "sid=SECRET; Secure; Path=/; SameSite=None");
  registerCookieJar(KEY, jar);
  const seen: Array<string | null> = [];
  const sandboxOutbound = createSandboxOutboundOverride(
    {} as SandboxOutboundExports,
    {} as SandboxOutboundEnv,
    {
      fetch: async (req) => {
        seen.push(req.headers.get("cookie"));
        const headers: Record<string, string> = {
          "content-type": "text/javascript",
          "access-control-allow-origin": acac ? ORIGIN : "*",
        };
        if (acac) headers["access-control-allow-credentials"] = "true";
        return new Response(req.url === TARGET && served ? served : "export default 1;", {
          headers,
        });
      },
    },
  );
  const args = {
    descriptors: [{ src: TARGET, kind, defer: false, async: false, body: "", crossOrigin }],
    pageUrl: PAGE,
    connectionId: KEY,
    cookieKey: KEY,
    sandboxOutbound,
  };
  const descriptors =
    kind === "classic"
      ? await prefetchExternalScripts({ ...args, baseUrl: PAGE })
      : (await walkModuleGraph(args)).descriptors;
  return { seen, descriptors };
}

describe("script fetches follow the browser credentials mode", () => {
  it.each([
    ["module entry", "module", null, false, "", [null], false],
    ["static import", "module", null, false, IMPORT, [null, null], false],
    ["anonymous classic", "classic", "anonymous", false, "", [null], false],
    ["use-credentials wildcard", "module", "use-credentials", false, "", [SECRET], true],
    ["use-credentials allowed", "module", "use-credentials", true, IMPORT, [SECRET, SECRET], false],
    ["use-credentials uppercase module", "module", "USE-CREDENTIALS", false, "", [SECRET], true],
    ["use-credentials mixed-case classic", "classic", "Use-Credentials", true, "", [SECRET], false],
  ] as const)("%s", async (_name, kind, crossOrigin, acac, served, seen, blocked) => {
    const got = await fetchThrough(kind, crossOrigin, acac, served);
    expect([got.seen, !!got.descriptors[0]?.prefetchError]).toEqual([seen, blocked]);
  });
});

// Drives the page-script path that fetches parser and inserted scripts, so the headers it
// produces meet the real gateway.
async function fetchInserted(crossOrigin: string | null, acac = true) {
  const jar = createCookieJar();
  jar.setFromHeader("https://victim.example/", "sid=SECRET; Secure; Path=/; SameSite=None");
  registerCookieJar(KEY, jar);
  const seen: Array<string | null> = [];
  const leaked: string[] = [];
  let requests = 0;
  const sandboxOutbound = createSandboxOutboundOverride(
    {} as SandboxOutboundExports,
    {} as SandboxOutboundEnv,
    {
      fetch: async (req) => {
        requests++;
        seen.push(req.headers.get("cookie"));
        for (const name of req.headers.keys()) {
          if (name.startsWith("x-kitesurf-")) leaked.push(name);
        }
        const headers: Record<string, string> = {
          "content-type": "text/javascript",
          "access-control-allow-origin": acac ? ORIGIN : "*",
        };
        if (acac) headers["access-control-allow-credentials"] = "true";
        return new Response("export default 1;", { headers });
      },
    },
  );
  // The page isolate's own outbound, and its shim installed before the trusted capture
  // (index.ts:2138-2142), so the carriers the page path sends are the ones the gateway sees.
  const fetcher = sandboxOutbound.parent({
    pageOrigin: ORIGIN,
    pageUrl: PAGE,
    connectionId: KEY,
    cookieKey: KEY,
    pageRealm: true,
  });
  globalThis.fetch = ((input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
    fetcher.fetch(new Request(input, init))) as typeof fetch;
  installFetchShim();
  captureTrustedFetch();
  const res = await fetchInsertedScript(TARGET, crossOrigin);
  return { seen, leaked, requests, status: res.status };
}

describe("page-script script fetches follow the browser credentials mode", () => {
  it.each([
    ["no-cors classic keeps jar cookies", null, [SECRET], 200],
    ["anonymous module sends none", "", [null], 200],
    ["anonymous classic sends none", "anonymous", [null], 200],
    ["use-credentials uppercase sends the cookie", "USE-CREDENTIALS", [SECRET], 200],
  ] as const)("%s", async (_name, crossOrigin, seen, status) => {
    const got = await fetchInserted(crossOrigin);
    expect([got.seen, got.status, got.leaked, got.requests]).toEqual([seen, status, [], 1]);
  });
});
