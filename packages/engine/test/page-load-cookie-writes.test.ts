// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A load summary and an unload harvest belong to the isolate that produced them, not to the
// mutable url that a later navigation has already moved.

import { describe, expect, it, vi } from "vitest";

// The engine's DOM parser needs the core wasm instance, which the unit-test embedder disallows.
// The scan only needs to describe a document with no scripts or frames.
vi.mock("../src/wasm.ts", () => ({
  scanDocument: () => ({
    title: "",
    baseHref: null,
    metaCsp: [],
    importMaps: [],
    scripts: [],
    iframes: [],
  }),
  extractScriptDescriptorsFromDom: () => [],
  createDom: () => {
    throw new Error("test harness: createDom is unused");
  },
}));

// Only the isolate factory is faked; every other page-script export stays real.
const pageScripts = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../src/eval/page-script.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/eval/page-script.ts")>()),
  getOrCreatePageScript: (opts: { startupInput?: { url?: string | null } }) =>
    pageScripts.get(opts.startupInput?.url ?? ""),
}));

import type { LoadCompletion } from "@kitesurf/jsrpc-types/page-script";
import type { DispatchCtx } from "../src/cdp/dispatch.ts";
import { createPageTarget } from "../src/cdp/target.ts";
import { handlePage } from "../src/cdp/page.ts";
import { NetworkEventTracker } from "../src/cdp/network-events.ts";
import type { CdpRequest, TargetState } from "../src/cdp/types.ts";
import type { UnloadHarvest } from "../src/cdp/page-script-generation.ts";
import { createCookieJar } from "../src/cookies.ts";
import type { PageScriptStub } from "../src/eval/page-script.ts";
import type { SandboxOutboundOverride } from "../src/eval/outbound.ts";
import { DynamicWorkerBudget } from "../src/eval/worker-budget.ts";

const FIRST = "https://first.test/";
const NEXT = "https://next.test/";
const SID = "session-1";
const CONN = "connection-1";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function fakePageScript() {
  const load = deferred<Partial<LoadCompletion>>();
  const unload = deferred<UnloadHarvest | null>();
  let markUnloadStarted = () => {};
  const unloadStarted = new Promise<void>((r) => {
    markUnloadStarted = r;
  });
  const hooks: { onNavigate?: () => void } = {};
  const stub = {
    navigate: async () => {
      hooks.onNavigate?.();
      return {};
    },
    awaitLoad: () => load.promise,
    unload: async () => {
      markUnloadStarted();
      return unload.promise;
    },
    close: () => {},
    killIsolate: () => {},
    queryDom: async () => ({ pumped: -1 }),
  };
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only the RPC verbs this path calls.
  return { stub: stub as unknown as PageScriptStub, load, unload, unloadStarted, hooks };
}

function setup() {
  pageScripts.clear();
  const background: Promise<unknown>[] = [];
  const cookies = createCookieJar();
  const emit = () => {};
  const fetchDocument = async () =>
    new Response("<html><head></head><body></body></html>", {
      headers: { "content-type": "text/html" },
    });
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only parent().fetch is used by navigate.
  const sandboxOutbound = {
    external: false,
    parent: () => ({ fetch: fetchDocument }),
    loaded: () => ({ fetch: fetchDocument }),
    session: () => ({}),
    final: async () => new Response(""),
  } as unknown as SandboxOutboundOverride;
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only fields the navigate path reads.
  const browser = {
    targets: new Map<string, TargetState>(),
    sandboxOutbound,
    cookies,
    contexts: new Map(),
    screencasts: new Map(),
    networkEvents: new NetworkEventTracker(emit, CONN),
    layoutMode: "full",
    cdpDebug: false,
    connectionMode: "browser",
    preNavScripts: new Map(),
    learnedInsertedScripts: new Map(),
    pendingBindings: new Set<string>(),
    execContextSeq: 1,
    workerBudget: new DynamicWorkerBudget(),
    dedicatedWorkers: {
      terminateTarget: () => {},
      terminateFrame: () => {},
      ownerFor: () => null,
    },
    skipSpeculativeRaster: false,
    fontDefer: false,
    attributionHeaders: {},
    wsClosing: false,
  } as unknown as DispatchCtx["browser"];
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only the fields dispatch reads.
  const ctx = {
    browser,
    emit,
    env: {},
    ctx: { waitUntil: (p: Promise<unknown>) => background.push(p) },
    connectionId: CONN,
    analytics: { now: () => 0, sessionAgeMs: () => 0, once: () => false, emit: () => {} },
  } as unknown as DispatchCtx;
  const target = createPageTarget(ctx, "about:blank");
  target.sessions.add(SID);
  const navigate = (url: string) =>
    handlePage(ctx, {
      id: 1,
      method: "Page.navigate",
      params: { url },
      sessionId: SID,
    } as CdpRequest);
  const install = (url: string, script: ReturnType<typeof fakePageScript>) => {
    pageScripts.set(url, script.stub);
    return script;
  };
  const documentCookies = () => ({
    first: cookies.documentCookieString(FIRST),
    next: cookies.documentCookieString(NEXT),
  });
  return { target, background, navigate, install, documentCookies };
}

describe("a load summary stays with its answering document", () => {
  it("writes its cookies there after the url moves", async () => {
    const h = setup();
    const a = h.install(FIRST, fakePageScript());
    // Another navigation has already moved the target to the next document.
    a.hooks.onNavigate = () => {
      h.target.url = NEXT;
    };
    await h.navigate(FIRST);
    expect(h.target.pageScriptUrl).toBe(FIRST);

    a.load.resolve({ phases: {}, cookieWrites: ["a=1; Path=/"] });
    await Promise.all(h.background);

    expect(h.documentCookies()).toEqual({ first: "a=1", next: "" });
  });
});

describe("an unload harvest stays with its retiring document", () => {
  it("writes its cookies there after the url moves", async () => {
    const h = setup();
    const a = fakePageScript();
    h.target.pageScript = a.stub;
    h.target.pageScriptUrl = FIRST;
    const b = h.install(NEXT, fakePageScript());

    const navigating = h.navigate(NEXT);
    await a.unloadStarted;
    // The next document's url is published while this harvest is still in flight.
    h.target.pageScriptUrl = NEXT;
    a.unload.resolve({ console: [], cookieWrites: ["a=1; Path=/"] });
    await navigating;

    expect(h.documentCookies()).toEqual({ first: "a=1", next: "" });

    b.load.resolve({ phases: {} });
    await Promise.all(h.background);
  });
});
