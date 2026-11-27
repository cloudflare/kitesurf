// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// The document a navigation leaves can be stuck in script. Saving its scroll position and
// restoring the destination's are both best-effort, so neither may hold the navigation open
// past the same bound the pre-navigate drain uses. Without the bound, Page.navigate waits for
// the page isolate's CPU cap (300s) instead of NAVIGATE_DRAIN_TIMEOUT_MS (1s).

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
    modulePreloads: [],
  }),
  extractScriptDescriptorsFromDom: () => [],
  createDom: () => ({}),
}));

// Only the isolate factory is faked; every other page-script export stays real.
const pageScripts = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../src/eval/page-script.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/eval/page-script.ts")>()),
  getOrCreatePageScript: (opts: { startupInput?: { url?: string | null } }) =>
    pageScripts.get(opts.startupInput?.url ?? ""),
}));

import type { DispatchCtx } from "../src/cdp/dispatch.ts";
import { createPageTarget } from "../src/cdp/target.ts";
import { handlePage } from "../src/cdp/page.ts";
import { NetworkEventTracker } from "../src/cdp/network-events.ts";
import type { CdpRequest, TargetState } from "../src/cdp/types.ts";
import { createCookieJar } from "../src/cookies.ts";
import type { PageScriptStub } from "../src/eval/page-script.ts";
import type { SandboxOutboundOverride } from "../src/eval/outbound.ts";
import { DynamicWorkerBudget } from "../src/eval/worker-budget.ts";
import { LocalStorage } from "../src/state/local-storage.ts";
import { MemorySessionStore } from "../src/state/session-store.ts";
import { testClient } from "./client-state.ts";

const FIRST = "https://first.test/";
const NEXT = "https://next.test/";
const SID = "session-1";
const CONN = "connection-1";

// NAVIGATE_DRAIN_TIMEOUT_MS is 1s; the test's own timeout is the negative control.
const BOUNDED_WITHIN_MS = 4_000;

interface ScrollMetrics {
  scrollX: number;
  scrollY: number;
}

function fakePageScript(
  opts: {
    metrics?: ScrollMetrics;
    hangMetrics?: boolean;
    evaluate?: "record" | "hang";
  } = {},
) {
  const evaluations: string[] = [];
  const stub = {
    navigate: async () => ({}),
    unload: async () => ({ console: [], cookieWrites: [] }),
    close: () => {},
    killIsolate: () => {},
    queryDom: async (method: string) => {
      if (method !== "layoutMetrics") return {};
      if (opts.hangMetrics) return new Promise<never>(() => {});
      return opts.metrics ?? { scrollX: 0, scrollY: 0 };
    },
    evaluate: async (source: string) => {
      evaluations.push(source);
      if (opts.evaluate === "hang") return new Promise<never>(() => {});
      return undefined;
    },
  };
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only the RPC verbs this path calls.
  return { stub: stub as unknown as PageScriptStub, evaluations };
}

function setup() {
  pageScripts.clear();
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
    localStorage: new LocalStorage(new MemorySessionStore()),
    screencasts: new Map(),
    networkEvents: new NetworkEventTracker(emit, CONN),
    layoutMode: "full",
    cdpDebug: false,
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
    ctx: { waitUntil: () => {} },
    connectionId: CONN,
    client: testClient(),
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
  const navigateToHistoryEntry = (entryId: number) =>
    handlePage(ctx, {
      id: 2,
      method: "Page.navigateToHistoryEntry",
      params: { entryId },
      sessionId: SID,
    } as CdpRequest);
  const install = (url: string, script: ReturnType<typeof fakePageScript>) => {
    pageScripts.set(url, script.stub);
    return script;
  };
  return { target, navigate, navigateToHistoryEntry, install };
}

describe("history scroll is saved within a bound", () => {
  it("navigates away from a document that never answers layoutMetrics", async () => {
    const h = setup();
    h.target.pageScript = fakePageScript({ hangMetrics: true }).stub;
    h.install(FIRST, fakePageScript());

    const started = Date.now();
    await h.navigate(FIRST);

    expect(Date.now() - started).toBeLessThan(BOUNDED_WITHIN_MS);
    expect(h.target.url).toBe(FIRST);
    // The unanswered read saved nothing; the navigation still committed.
    expect(h.target.navigationHistoryScroll.size).toBe(0);
  });

  it("saves the leaving document's scroll when it answers", async () => {
    const h = setup();
    h.install(FIRST, fakePageScript({ metrics: { scrollX: 10, scrollY: 20 } }));
    await h.navigate(FIRST);
    h.install(NEXT, fakePageScript());

    await h.navigate(NEXT);

    const first = h.target.navigationHistory.find((e) => e.url === FIRST);
    expect(first).toBeDefined();
    expect(h.target.navigationHistoryScroll.get(first!.id)).toEqual({ x: 10, y: 20 });
  });
});

describe("history scroll is restored within a bound", () => {
  it("restores the saved position on a history navigation", async () => {
    const h = setup();
    h.install(FIRST, fakePageScript({ metrics: { scrollX: 10, scrollY: 20 } }));
    await h.navigate(FIRST);
    h.install(NEXT, fakePageScript());
    await h.navigate(NEXT);
    const back = h.install(FIRST, fakePageScript({ evaluate: "record" }));
    const first = h.target.navigationHistory.find((e) => e.url === FIRST)!;

    await h.navigateToHistoryEntry(first.id);

    expect(back.evaluations).toEqual([expect.stringContaining("window.scrollTo(10, 20)")]);
  });

  it("returns when the restored document never answers the scroll call", async () => {
    const h = setup();
    h.install(FIRST, fakePageScript({ metrics: { scrollX: 10, scrollY: 20 } }));
    await h.navigate(FIRST);
    h.install(NEXT, fakePageScript());
    await h.navigate(NEXT);
    h.install(FIRST, fakePageScript({ evaluate: "hang" }));
    const first = h.target.navigationHistory.find((e) => e.url === FIRST)!;

    const started = Date.now();
    await h.navigateToHistoryEntry(first.id);

    expect(Date.now() - started).toBeLessThan(BOUNDED_WITHIN_MS);
    expect(h.target.url).toBe(FIRST);
  });
});
