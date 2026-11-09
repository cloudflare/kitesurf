// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Routes Worker HTTP requests, discovery endpoints, RBI assets, and CDP WebSocket upgrades.

import { handleWebSocket } from "./cdp/connection.ts";
import { traceSpan } from "./tracing.ts";
import { armLocalTracing } from "./tracing-local.ts";
import { WorkerEntrypoint } from "cloudflare:workers";
import { Hono, type Context, type ErrorHandler } from "hono";
import { z } from "zod";
import {
  cdpUpgradeOriginAllowed,
  inspectorTargetUrl,
  resolveInspectorBaseUrl,
} from "./inspector.ts";
import { DEFAULT_ENGINE_HOST, type EngineHost } from "./host.ts";

// Loopback service binding for PageScript subresource fetches.
export { SandboxOutbound } from "./eval/outbound.ts";
// Deny-all gateway used as the pageRenderer's globalOutbound.
export { DeniedOutbound } from "./eval/denied-outbound.ts";
export { SpanSink } from "./eval/span-sink.ts";
export { PageScriptTail } from "./eval/page-script-tail.ts";

// `Env` is generated from wrangler.jsonc; rerun type generation after changing bindings.

// Puppeteer reads the protocol version and WebSocket endpoint from /json/version.
const VERSION_INFO = {
  Browser: "Kitesurf/0.0.1",
  "Protocol-Version": "1.3",
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  "V8-Version": "12.0.0",
  "WebKit-Version": "537.36",
};

const CHROME_BUNDLED_INSPECTOR_URL = "devtools://devtools/bundled/inspector.html";

type EngineBindings = {
  engine: KitesurfEngine;
  env: Env;
  ctx: ExecutionContext;
  host: EngineHost;
};
type EngineApp = { Bindings: EngineBindings };

// Hono's default onError answers 500 and swallows the error, so an
// embedding Worker's wrapper on the default export would never see it.
const rethrow: ErrorHandler<EngineApp> = (err) => {
  throw err;
};

const ASSETS_ORIGIN = "https://kitesurf.invalid";
async function serveRbiAsset(
  env: Env,
  assetPath: string,
  contentType?: string,
  ifNoneMatch?: string,
): Promise<Response> {
  const requestHeaders = new Headers();
  if (ifNoneMatch !== undefined) requestHeaders.set("If-None-Match", ifNoneMatch);
  const res = await env.FONT_ASSETS.fetch(
    new Request(ASSETS_ORIGIN + assetPath, { headers: requestHeaders }),
  );
  if (res.status !== 200 && res.status !== 304) {
    return new Response("not found", { status: 404 });
  }
  const headers = new Headers(res.headers);
  headers.set(
    "content-type",
    contentType || res.headers.get("content-type") || "application/octet-stream",
  );
  return new Response(res.body, { status: res.status, headers });
}

const upgrades = new Hono<EngineApp>();
upgrades.onError(rethrow);

upgrades.use("/__fixtures/*", async (c, next) => {
  const fixtures = c.env.env.FIXTURES;
  if (fixtures) return fixtures.fetch(c.req.raw);
  await next();
});

upgrades.all("*", (c) =>
  !cdpUpgradeOriginAllowed(c.req.raw, c.env.env)
    ? c.text("CDP connections from this origin are not allowed", 403)
    : traceSpan(c.env.env.HOST_TRACER, "ws.connect", () =>
        handleWebSocket(c.req.raw, c.env.env, c.env.ctx, undefined, {
          host: c.env.host,
        }),
      ),
);

const app = new Hono<EngineApp>();
app.onError(rethrow);

app.notFound(
  async (c) =>
    (await c.env.host.serveFallback?.(new URL(c.req.url), c.env.env)) ?? c.text("not found", 404),
);

for (const retired of ["/tui", "/tui/*", "/rbi/ws"]) {
  app.all(retired, (c) => c.text("not found", 404));
}

app.use(async (c, next) => {
  const { env, ctx, host } = c.env;
  const rejected = await host.admit?.(c.req.raw, env, ctx);
  if (rejected) return rejected;
  await next();
});

app.use(async (c, next) => {
  if (c.req.header("upgrade")?.toLowerCase() === "websocket") {
    return upgrades.fetch(c.req.raw, c.env);
  }
  await next();
});

app.get("/rbi/scene_host.wasm", (c) =>
  serveRbiAsset(c.env.env, "/rbi/scene_host.wasm", "application/wasm"),
);
app.get("/rbi/scene_host.json", (c) =>
  serveRbiAsset(c.env.env, "/rbi/scene_host.json", "application/json; charset=utf-8"),
);
app.get("/rbi/fonts/*", (c) =>
  serveRbiAsset(
    c.env.env,
    new URL(c.req.url).pathname.slice("/rbi".length),
    undefined,
    c.req.header("If-None-Match"),
  ),
);
app.all("/rbi", (c) => c.text("not found", 404));
app.all("/rbi/*", (c) => c.text("not found", 404));

const inspectorQuery = z.object({
  url: z
    .url({ protocol: /^https?$/ })
    .transform((value) => new URL(value).toString())
    .optional()
    .catch(undefined),
  inspect: z
    .string()
    .optional()
    .transform((value) => value === "1"),
});
app.get("/", async (c, next) => {
  const url = new URL(c.req.url);
  const query = inspectorQuery.parse(c.req.query());
  if (query.url === undefined && !query.inspect) return next();
  const inspectorBase = await resolveInspectorBaseUrl(c.env.env);
  if (inspectorBase === null) {
    return new Response(
      "Inspector base URL not configured. Set the\n" +
        "KITESURF_INSPECTOR_BASE_URL env var on the engine worker\n" +
        "to a hosted Chrome DevTools Frontend build (any URL that\n" +
        "accepts `?wss=<endpoint>`), or to /inspector/inspector.html\n" +
        "after a `--config=devtools` build, or use\n" +
        "chrome://inspect → Configure → Discover network targets\n" +
        "and add this host.\n",
      { status: 501, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
  const host = c.req.header("host") ?? url.host;
  return Response.redirect(
    inspectorTargetUrl(inspectorBase, { url, host, initialUrl: query.url }),
    302,
  );
});

app.get(
  "/health",
  () =>
    new Response("kitesurf: OK\n", {
      headers: { "content-type": "text/plain" },
    }),
);

function discoveryVersion(c: Context<EngineApp>): Response {
  const url = new URL(c.req.url);
  const host = c.req.header("host") ?? url.host;
  const scheme = url.protocol === "https:" ? "wss" : "ws";
  return Response.json({
    ...VERSION_INFO,
    webSocketDebuggerUrl: `${scheme}://${host}/devtools/browser`,
  });
}
app.get("/json/version", discoveryVersion);
app.get("/json/version/", discoveryVersion);

async function discoveryList(c: Context<EngineApp>): Promise<Response> {
  const url = new URL(c.req.url);
  const host = c.req.header("host") ?? url.host;
  const scheme = url.protocol === "https:" ? "wss" : "ws";
  const wsUrl = `${scheme}://${host}/devtools/page/kitesurf`;
  const inspectorBase = await resolveInspectorBaseUrl(c.env.env);
  const entry: Record<string, unknown> = {
    id: "kitesurf",
    type: "page",
    title: "kitesurf",
    url: "about:blank",
    description: "kitesurf headless target",
    webSocketDebuggerUrl: wsUrl,
    faviconUrl: `${url.protocol}//${host}/favicon.ico`,
  };
  // Chrome's discovery UI needs this field even for "inspect fallback";
  // omitting it makes both actions silently do nothing. A path-only base
  // stays relative, like Chrome's own /json/list, which chrome://inspect accepts.
  entry.devtoolsFrontendUrl =
    (inspectorBase ?? CHROME_BUNDLED_INSPECTOR_URL).replace(/\/$/, "") +
    `?${scheme}=${host}/devtools/page/kitesurf`;
  return Response.json([entry]);
}
app.get("/json", discoveryList);
app.get("/json/list", discoveryList);
app.get("/json/list/", discoveryList);

app.get("/json/protocol", () => Response.json({}));

app.all("/__fixtures/*", (c) =>
  c.env.env.FIXTURES ? c.env.env.FIXTURES.fetch(c.req.raw) : c.text("not found", 404),
);

export class KitesurfEngine extends WorkerEntrypoint<Env> {
  protected host(): EngineHost {
    return DEFAULT_ENGINE_HOST;
  }

  override async fetch(request: Request): Promise<Response> {
    const traced = armLocalTracing(this.env, this.ctx, request);
    return traced ? traced(() => this.#fetch(request)) : this.#fetch(request);
  }

  async #fetch(request: Request): Promise<Response> {
    return app.fetch(request, {
      engine: this,
      env: this.env,
      ctx: this.ctx,
      host: this.host(),
    });
  }
}

export default KitesurfEngine;
