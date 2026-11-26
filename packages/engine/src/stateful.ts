// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Stateful browser sessions: one StatefulBrowser Durable Object per session, opt-in per request.
// POST /devtools/browser creates one, and clients connect to /devtools/browser/<sessionId>. The
// browser outlives its clients for its keep-alive and serves several at once. A deploy that does
// not declare the class answers the POST with a 404, and plain upgrades stay stateless.

// The session's data lives in the object's SQLite (state/sqlite-session-store.ts), and each page
// runs in a facet with a database of its own (eval/page-script-host.ts). The live browser stays
// in memory, so a restart of the object ends the session: the next connect gets a 404, and the
// alarm, which outlives the restart, deletes what the session left in storage.

import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { BrowserSession, parseConnectionParams } from "./cdp/connection.ts";
import type { SessionContext } from "./cdp/dispatch.ts";
import type { TargetState } from "./cdp/types.ts";
import { facetPageScriptHost } from "./eval/page-script-host.ts";
import { SandboxOutbound, type OutboundProps } from "./eval/outbound.ts";
import { DEFAULT_ENGINE_HOST, type EngineHost } from "./host.ts";
import { inspectorTargetUrl, resolveInspectorBaseUrl } from "./inspector.ts";
import { SESSION_ID_HEADER } from "./observability.ts";
import {
  OUTBOUND_FORWARD_HEADER,
  readForwardedOutbound,
  statefulNamespace,
} from "./state/outbound-forward.ts";
import { SqliteSessionStore } from "./state/sqlite-session-store.ts";

export const STATEFUL_BROWSER_PATH = "/devtools/browser";

// How long a session outlives its last client, unless the creator asks with ?keep_alive=<ms>.
const KEEP_ALIVE_DEFAULT_MS = 60_000;
const KEEP_ALIVE_MIN_MS = 10_000;
const KEEP_ALIVE_MAX_MS = 20 * 60_000;
// An object with no request is evicted after a minute or two, and takes the browser with it. The
// alarm fires at least this often, which also keeps the object in memory.
const ALARM_MAX_INTERVAL_MS = 30_000;
// After the session ends, the storage goes this much later: a navigate or a gateway fetch that
// is still running can write a row after the end.
const CLEANUP_DELAY_MS = 30_000;

// The owner the front door resolved (EngineHost.sessionOwner) for a connect. Clients cannot set
// it: the front door builds the forwarded request's headers itself.
const OWNER_HEADER = "x-kitesurf-stateful-owner";

const keepAliveParam = z.coerce.number().int().positive().optional().catch(undefined);

/** What a `/devtools/browser/<sessionId>...` path asks of the session. */
export type StatefulEndpoint =
  | { kind: "browser" }
  | { kind: "page"; targetId: string }
  | { kind: "json" };

// Session ids are Durable Object ids (64 hex digits), and target ids are 32 hex digits.
const STATEFUL_PATH =
  /^\/devtools\/browser\/([0-9a-f]{64})(?:\/page\/([0-9a-f]{32})|\/(json)(?:\/list)?)?\/?$/;

/** Parses a session path, or returns null when it is not one. */
export function parseStatefulPath(
  pathname: string,
): { sessionId: string; endpoint: StatefulEndpoint } | null {
  const m = STATEFUL_PATH.exec(pathname);
  if (!m?.[1]) return null;
  let endpoint: StatefulEndpoint = { kind: "browser" };
  if (m[2]) endpoint = { kind: "page", targetId: m[2] };
  else if (m[3]) endpoint = { kind: "json" };
  return { sessionId: m[1], endpoint };
}

/** The page-mode path of one page of a session. */
export function statefulPagePath(sessionId: string, targetId: string): string {
  return `${STATEFUL_BROWSER_PATH}/${sessionId}/page/${targetId}`;
}

/** The answer to a session path whose session the deploy cannot reach. */
export function statefulSessionNotFound(): Response {
  return new Response("kitesurf: no such browser session (it ended, or never existed)\n", {
    status: 404,
  });
}

// The session that a `/devtools/browser/<sessionId>...` path names: null when the path names no
// session, and "unknown" when it does but the deploy declares no StatefulBrowser or its
// namespace did not mint the id. An unknown session is a 404, never a fresh stateless browser.
// Chrome's `/devtools/browser/<uuid>` is not a session path, so it stays stateless.
export function statefulRoute(
  ctx: ExecutionContext,
  url: URL,
): { id: DurableObjectId; endpoint: StatefulEndpoint } | "unknown" | null {
  const parsed = parseStatefulPath(url.pathname);
  if (!parsed) return null;
  const ns = statefulNamespace(ctx.exports);
  if (!ns) return "unknown";
  try {
    return { id: ns.idFromString(parsed.sessionId), endpoint: parsed.endpoint };
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "stateful_session_id_rejected",
        sessionId: parsed.sessionId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return "unknown";
  }
}

interface CreateInit {
  // The URL and headers of the creating request: the session options a stateless upgrade takes.
  url: string;
  headers: [string, string][];
  // The front door's ctx.props, for the session's telemetry and loaded workers.
  props: unknown;
  keepAliveMs: number;
  owner: string | null;
}

/**
 * POST /devtools/browser: creates a stateful session and returns its id and endpoint. A 404 when
 * the deploy declares no StatefulBrowser.
 */
export async function createStatefulSession(
  env: Env,
  ctx: ExecutionContext,
  request: Request,
  host: EngineHost,
): Promise<Response> {
  const ns = statefulNamespace(ctx.exports);
  if (!ns) {
    return new Response("kitesurf: stateful sessions are not enabled here\n", { status: 404 });
  }
  // The object cannot apply a host egress (see create), and must not send around it.
  if (host.egress?.(env, ctx) !== undefined) {
    return new Response("kitesurf: stateful sessions do not support this deploy's egress\n", {
      status: 501,
    });
  }
  const url = new URL(request.url);
  const asked = keepAliveParam.parse(url.searchParams.get("keep_alive") ?? undefined);
  const keepAliveMs = Math.min(
    Math.max(asked ?? KEEP_ALIVE_DEFAULT_MS, KEEP_ALIVE_MIN_MS),
    KEEP_ALIVE_MAX_MS,
  );
  const id = ns.newUniqueId();
  const { pageTargetId } = await ns.get(id).create({
    url: request.url,
    headers: Array.from(request.headers.entries()),
    props: ctx.props,
    keepAliveMs,
    owner: host.sessionOwner?.(request, env, ctx) ?? null,
  });
  const sessionId = id.toString();
  const requestHost = request.headers.get("host") ?? url.host;
  const scheme = url.protocol === "https:" ? "wss" : "ws";
  return Response.json({
    sessionId,
    webSocketDebuggerUrl: `${scheme}://${requestHost}${STATEFUL_BROWSER_PATH}/${sessionId}`,
    pageTargetId,
  });
}

/** Hands a `/devtools/browser/<sessionId>...` request to the session's object. */
export function routeToStatefulSession(
  env: Env,
  ctx: ExecutionContext,
  request: Request,
  id: DurableObjectId,
  host: EngineHost,
): Promise<Response> {
  const ns = statefulNamespace(ctx.exports);
  if (!ns) return Promise.resolve(new Response("not found", { status: 404 }));
  const headers = new Headers(request.headers);
  headers.delete(OWNER_HEADER);
  headers.delete(OUTBOUND_FORWARD_HEADER);
  const owner = host.sessionOwner?.(request, env, ctx) ?? null;
  if (owner !== null) headers.set(OWNER_HEADER, owner);
  return ns.get(id).fetch(new Request(request.url, { headers }));
}

/**
 * The Durable Object that hosts one stateful session. A deploy opts in by declaring the class
 * with SQLite storage. An embedder overrides host() to give the session its EngineHost.
 */
export class StatefulBrowser extends DurableObject<Env> {
  #session: BrowserSession | null = null;
  #owner: string | null = null;
  #keepAliveMs = KEEP_ALIVE_DEFAULT_MS;
  // When the last client left, or null while one is connected.
  #idleSince: number | null = null;
  // When the session ended, for the cleanup alarm.
  #endedAt: number | null = null;

  protected host(): EngineHost {
    return DEFAULT_ENGINE_HOST;
  }

  async create(init: CreateInit): Promise<{ pageTargetId: string }> {
    if (this.#session || this.#endedAt !== null) {
      throw new Error("kitesurf: this object already hosts a session");
    }
    // The session has no host egress: the hook takes a request's ExecutionContext, and a call
    // forwarded into the object cannot carry the egress stub. Refuse rather than send around it.
    if (this.host().egress) {
      throw new Error("kitesurf: a StatefulBrowser host cannot set egress");
    }
    const request = new Request(init.url, { headers: init.headers });
    this.#owner = init.owner;
    this.#keepAliveMs = init.keepAliveMs;
    this.#idleSince = Date.now();
    const session = new BrowserSession(
      request,
      this.env,
      sessionContext(this.ctx, init.props),
      parseConnectionParams(request),
      {
        persistent: true,
        host: this.host(),
        store: new SqliteSessionStore(this.ctx.storage),
        statefulSessionId: this.ctx.id.toString(),
        pageScriptHost: facetPageScriptHost(this.ctx.facets),
        onClientLeft: (remaining) => {
          if (remaining > 0) return;
          this.#idleSince = Date.now();
          void this.#scheduleAlarm();
        },
      },
    );
    this.#session = session;
    const first = session.openBrowser()[0];
    if (!first) throw new Error("kitesurf: a new browser has no page");
    await this.#scheduleAlarm();
    return { pageTargetId: first.targetId };
  }

  override async fetch(request: Request): Promise<Response> {
    const forwarded = readForwardedOutbound(request);
    if (forwarded === "invalid") {
      return new Response("kitesurf: malformed gateway forward", { status: 502 });
    }
    if (forwarded) return this.#outbound(forwarded.props, forwarded.request);
    const session = this.#session;
    if (!session || session.disposed) return statefulSessionNotFound();
    if (this.#owner !== null && request.headers.get(OWNER_HEADER) !== this.#owner) {
      return new Response("kitesurf: this session belongs to another owner\n", { status: 403 });
    }
    const url = new URL(request.url);
    const endpoint = parseStatefulPath(url.pathname)?.endpoint;
    if (!endpoint) return new Response("not found", { status: 404 });
    if (endpoint.kind === "json") return this.#json(request, url);
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("kitesurf: expected a WebSocket upgrade\n", { status: 426 });
    }
    const pageTargetId = endpoint.kind === "page" ? endpoint.targetId : undefined;
    if (pageTargetId && session.browser.targets.get(pageTargetId)?.type !== "page") {
      return new Response("kitesurf: no such page in this session\n", { status: 404 });
    }
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    server.accept();
    session.attachClient(
      server,
      { ...parseConnectionParams(request), connectionMode: pageTargetId ? "page" : "browser" },
      { pageTargetId },
    );
    this.#idleSince = null;
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { [SESSION_ID_HEADER]: session.id },
    });
  }

  // GET /devtools/browser/<sessionId>/json: the session's pages in Chrome's /json/list shape,
  // each with its page-mode endpoint and the link that opens it in DevTools.
  async #json(request: Request, url: URL): Promise<Response> {
    const sessionId = this.ctx.id.toString();
    const host = request.headers.get("host") ?? url.host;
    const scheme = url.protocol === "https:" ? "wss" : "ws";
    const inspectorBase = await resolveInspectorBaseUrl(this.env);
    return Response.json(
      this.#pages().map((t) => {
        const path = statefulPagePath(sessionId, t.targetId);
        return {
          id: t.targetId,
          type: "page",
          title: t.title,
          url: t.url,
          description: "",
          webSocketDebuggerUrl: `${scheme}://${host}${path}`,
          ...(inspectorBase
            ? { devtoolsFrontendUrl: inspectorTargetUrl(inspectorBase, { url, host, path }) }
            : {}),
        };
      }),
    );
  }

  #pages(): TargetState[] {
    const out: TargetState[] = [];
    for (const t of this.#session?.browser.targets.values() ?? []) {
      if (t.type === "page") out.push(t);
    }
    return out;
  }

  // A loaded worker's outbound call for this session, forwarded from the loopback
  // (state/outbound-forward.ts). The policy runs here, where the session's state is.
  #outbound(props: OutboundProps, request: Request): Promise<Response> {
    const session = this.#session;
    if (!session || session.disposed || props.connectionId !== session.id) {
      return Promise.resolve(new Response("kitesurf: browser session ended", { status: 502 }));
    }
    return SandboxOutbound.handle(this.env, props, request);
  }

  override async alarm(): Promise<void> {
    const session = this.#session;
    const now = Date.now();
    // A restarted object wakes with nothing in memory, so what is in storage belongs to nobody.
    // deleteAll also drops the alarm, and the object can go.
    if (!session) {
      await this.ctx.storage.deleteAll();
      return;
    }
    if (
      !session.disposed &&
      this.#idleSince !== null &&
      session.clientCount === 0 &&
      now - this.#idleSince >= this.#keepAliveMs
    ) {
      console.log(
        JSON.stringify({
          event: "stateful_session_keep_alive_expired",
          sessionId: session.id,
          keepAliveMs: this.#keepAliveMs,
        }),
      );
      session.dispose({ endReason: "close", closeCode: 1000, wasClean: 1 });
    }
    if (session.disposed) {
      this.#endedAt ??= now;
      if (now - this.#endedAt >= CLEANUP_DELAY_MS) {
        this.#session = null;
        await this.ctx.storage.deleteAll();
        return;
      }
      await this.ctx.storage.setAlarm(this.#endedAt + CLEANUP_DELAY_MS);
      return;
    }
    await this.#scheduleAlarm();
  }

  // The next alarm: the keep-alive deadline while no client is connected, and never later than
  // ALARM_MAX_INTERVAL_MS. The session enforces its own wall-clock cap.
  async #scheduleAlarm(): Promise<void> {
    const now = Date.now();
    let at = now + ALARM_MAX_INTERVAL_MS;
    if (this.#idleSince !== null) at = Math.min(at, this.#idleSince + this.#keepAliveMs);
    await this.ctx.storage.setAlarm(Math.max(at, now + 1));
  }
}

// The context a BrowserSession uses, from the object's state. The props are the creating
// request's, since the object has none of its own.
function sessionContext(state: DurableObjectState, props: unknown): SessionContext {
  return {
    waitUntil: (promise: Promise<unknown>) => state.waitUntil(promise),
    passThroughOnException: () => {},
    exports: state.exports,
    props,
  };
}
