// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// The front door of stateful sessions: the paths it hands to a session's Durable Object, and
// what it tells the object. test/e2e/stateful-session.e2e.test.ts drives the object itself.

import { describe, expect, it } from "vitest";

import type { EngineHost } from "../src/host.ts";
import {
  createStatefulSession,
  parseStatefulPath,
  routeToStatefulSession,
} from "../src/stateful.ts";

const SESSION = "a".repeat(64);
const TARGET = "b".repeat(32);

function fakeExports() {
  const seen: { init?: Record<string, unknown>; request?: Request } = {};
  const stub = {
    create: async (init: Record<string, unknown>) => {
      seen.init = init;
      return { pageTargetId: TARGET };
    },
    fetch: async (request: Request) => {
      seen.request = request;
      return new Response("ok");
    },
  };
  const id = { toString: () => SESSION };
  const StatefulBrowser = {
    idFromString: () => id,
    newUniqueId: () => id,
    get: () => stub,
  };
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only the fields these read.
  const ctx = { exports: { StatefulBrowser }, props: {} } as unknown as ExecutionContext;
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- an id the stub never reads.
  return { ctx, seen, id: id as unknown as DurableObjectId };
}

const env = {} as Env;

describe("parseStatefulPath", () => {
  it("reads the browser, page and page-list endpoints of a session", () => {
    expect(parseStatefulPath(`/devtools/browser/${SESSION}`)?.endpoint).toEqual({
      kind: "browser",
    });
    expect(parseStatefulPath(`/devtools/browser/${SESSION}/page/${TARGET}`)?.endpoint).toEqual({
      kind: "page",
      targetId: TARGET,
    });
    expect(parseStatefulPath(`/devtools/browser/${SESSION}/json/list`)?.endpoint).toEqual({
      kind: "json",
    });
  });

  it("leaves a path that names no session to the stateless routes", () => {
    expect(parseStatefulPath("/devtools/browser")).toBeNull();
    expect(parseStatefulPath("/devtools/browser/5b2c8a3e-chrome-uuid")).toBeNull();
    expect(parseStatefulPath(`/devtools/browser/${SESSION}/page/short`)).toBeNull();
  });
});

describe("createStatefulSession", () => {
  it("is a 404 when the deploy declares no StatefulBrowser", async () => {
    // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only the field it reads.
    const ctx = { exports: {} } as unknown as ExecutionContext;
    const res = await createStatefulSession(env, ctx, new Request("https://e/x"), {});
    expect(res.status).toBe(404);
  });

  it("refuses a create when the host sets an egress the object cannot apply", async () => {
    const { ctx, seen } = fakeExports();
    const host: EngineHost = { egress: () => ({ fetch: async () => new Response("") }) };
    const res = await createStatefulSession(env, ctx, new Request("https://e/x"), host);
    expect(res.status).toBe(501);
    expect(seen.init).toBeUndefined();
  });

  it("holds keep_alive to its limits and records the host's owner", async () => {
    const { ctx, seen } = fakeExports();
    const host: EngineHost = { sessionOwner: () => "account-1" };
    const create = (q: string) =>
      createStatefulSession(env, ctx, new Request(`https://e/devtools/browser${q}`), host);

    const res = await create("?keep_alive=1");
    expect(seen.init).toMatchObject({ keepAliveMs: 10_000, owner: "account-1" });
    expect(await res.json()).toEqual({
      sessionId: SESSION,
      webSocketDebuggerUrl: `wss://e/devtools/browser/${SESSION}`,
      pageTargetId: TARGET,
    });
    await create("?keep_alive=99999999");
    expect(seen.init).toMatchObject({ keepAliveMs: 20 * 60_000 });
    await create("");
    expect(seen.init).toMatchObject({ keepAliveMs: 60_000 });
  });
});

describe("routeToStatefulSession", () => {
  it("drops the headers only the engine writes, and sets the host's owner", async () => {
    const { ctx, seen, id } = fakeExports();
    const request = new Request(`https://e/devtools/browser/${SESSION}`, {
      headers: {
        upgrade: "websocket",
        "x-kitesurf-stateful-owner": "someone-else",
        "x-kitesurf-stateful-outbound": "{}",
      },
    });
    await routeToStatefulSession(env, ctx, request, id, { sessionOwner: () => "account-1" });
    expect(seen.request?.headers.get("x-kitesurf-stateful-owner")).toBe("account-1");
    expect(seen.request?.headers.has("x-kitesurf-stateful-outbound")).toBe(false);
    expect(seen.request?.headers.get("upgrade")).toBe("websocket");

    await routeToStatefulSession(env, ctx, request, id, {});
    expect(seen.request?.headers.has("x-kitesurf-stateful-owner")).toBe(false);
  });
});
