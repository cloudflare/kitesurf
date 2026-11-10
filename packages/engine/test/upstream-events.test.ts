// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import type { ReceivedUpstreamParams, UpstreamEventName } from "@kitesurf/jsrpc-types/page-script";
import { makeMainFrameState } from "../src/cdp/frames.ts";
import { installUpstreamEventHandler } from "../src/cdp/page.ts";
import type { DispatchCtx } from "../src/cdp/dispatch.ts";
import type { DedicatedWorkers, WorkerOwner } from "../src/cdp/dedicated-workers.ts";
import type { CdpEvent, TargetState } from "../src/cdp/types.ts";
import { NetworkEventTracker } from "../src/cdp/network-events.ts";
import { learnedScriptsFor, type LearnedScripts } from "../src/eval/learned-scripts.ts";
import type { PageScriptStub, UpstreamEventHandler } from "../src/eval/page-script.ts";

const BIG = 64 * 1024;

function installFor(isolateUrl: string) {
  let handler: UpstreamEventHandler | null = null;
  const stub = {
    setUpstreamEventHandler(h: UpstreamEventHandler | null) {
      handler = h;
    },
  } as PageScriptStub;
  const store: LearnedScripts = new Map();
  const emitted: CdpEvent[] = [];
  const dedicatedWorkers = {
    ownerFor: (): WorkerOwner | null => null,
    terminateFrame: () => {},
  } as Partial<DedicatedWorkers>;
  const ctx = {
    browser: {
      wsClosing: false,
      learnedInsertedScripts: store,
      dedicatedWorkers,
      networkEvents: new NetworkEventTracker(() => {}, "test"),
    },
    emit: (e: CdpEvent) => {
      emitted.push(e);
    },
  } as DispatchCtx;
  const target = {
    type: "page",
    targetId: "T",
    frameId: "F",
    loaderId: "L",
    browserContextId: "",
    navigateGeneration: 1,
    url: isolateUrl,
    title: "",
    sessions: new Set<string>(),
    refetchOnPushState: false,
    navigationHistory: [{ id: 1, url: isolateUrl, userTypedURL: isolateUrl, title: "" }],
    navigationHistoryIndex: 0,
    nextNavigationHistoryId: 2,
    frames: new Map(),
  } as TargetState;
  installUpstreamEventHandler(ctx, target, stub, 1, isolateUrl);
  const send = (event: UpstreamEventName, params: ReceivedUpstreamParams) =>
    handler!(event, params);
  return { store, emitted, target, send, ctx, stub };
}

describe("kitesurf.insertedScriptRan", () => {
  it("files the script under the isolate's url while a navigate moved target.url", () => {
    const { store, target, send } = installFor("https://first.test/");
    target.url = "https://second.test/";
    send("kitesurf.insertedScriptRan", { url: "https://cdn.test/a.js", bytes: BIG, run: "boa" });
    expect(learnedScriptsFor(store, "https://second.test/")).toEqual([]);
    expect(learnedScriptsFor(store, "https://first.test/")).toEqual(["https://cdn.test/a.js"]);
  });
});

describe("pageScriptUrl", () => {
  it("records the isolate's url, and a superseded install leaves it alone", () => {
    const { ctx, stub, target } = installFor("https://first.test/");
    expect(target.pageScriptUrl).toBe("https://first.test/");
    installUpstreamEventHandler(ctx, target, stub, 0, "https://stale.test/");
    expect(target.pageScriptUrl).toBe("https://first.test/");
  });
});

describe("kitesurf.navigatedWithinDocument", () => {
  const navigate = (isolateUrl: string, url: string, kind = "pushState") => {
    const h = installFor(isolateUrl);
    h.send("kitesurf.navigatedWithinDocument", {
      url,
      kind,
      navigationType: kind === "hash" ? "fragment" : "historyApi",
      previousUrl: isolateUrl,
    });
    return {
      url: h.target.url,
      history: h.target.navigationHistory.map((e) => e.url),
      emitted: h.emitted.flatMap((e) =>
        e.method === "Page.navigatedWithinDocument" ? [e.params.url] : [],
      ),
    };
  };

  it.each([
    ["https://a.test/x", "https://a.test/y?q#f"],
    ["data:text/html,doc", "data:text/html,doc#f"],
    ["about:blank", "about:blank#f"],
    ["file:///doc.html", "file:///doc.html?q"],
  ])("moves %s to %s", (from, to) => {
    expect(navigate(from, to)).toEqual({ url: to, history: [from, to], emitted: [to] });
  });

  it.each([
    ["https://a.test/x", "https://b.test/x"],
    ["https://a.test/x", "http://a.test/x"],
    ["https://a.test/x", "https://a.test:8443/x"],
    ["https://a.test/x", "https://user@a.test/x"],
    ["data:text/html,doc", "data:text/html,other"],
    ["about:blank", "about:srcdoc"],
    ["file:///doc.html", "file:///other.html"],
    ["https://a.test/x", "not a url"],
  ])("keeps %s when the page reports %s", (from, to) => {
    expect(navigate(from, to)).toEqual({ url: from, history: [from], emitted: [] });
    expect(navigate(from, to, "replaceState")).toEqual({ url: from, history: [from], emitted: [] });
  });
});

describe("frame events while a navigate replaces the document", () => {
  const attach = (h: ReturnType<typeof installFor>, frameId: string) =>
    h.send("kitesurf.frameAttached", {
      frameId,
      url: "https://child.test/",
      ownerBackendNodeId: 7,
    });

  it("attaches a frame for the live document", () => {
    const h = installFor("https://first.test/");
    attach(h, "child");
    expect([...h.target.frames.keys()]).toEqual(["child"]);
  });

  it("drops them once Page.navigate reset the frames for the next loader", () => {
    const h = installFor("https://first.test/");
    // Page.navigate does this before the generation bump, while the isolate still runs.
    h.target.loaderId = "L2";
    h.target.url = "https://next.test/";
    h.target.frames = new Map();
    attach(h, "child");
    h.send("kitesurf.navigatedWithinDocument", {
      url: "https://first.test/pushed",
      kind: "pushState",
      navigationType: "historyApi",
      previousUrl: "https://first.test/",
    });
    expect([...h.target.frames.keys()]).toEqual([]);
    expect(h.target.url).toBe("https://next.test/");
    expect(h.emitted).toEqual([]);
  });
});

it.each([
  ["kitesurf.frameNavigated", { url: "https://attacker.test/" }],
  ["kitesurf.frameLifecycle", { name: "load" }],
  ["kitesurf.frameStoppedLoading", {}],
  ["kitesurf.frameDetached", {}],
] as const)("ignores %s naming the main frame", (event, params) => {
  const url = "https://first.test/";
  const h = installFor(url);
  const frame = makeMainFrameState({ frameId: "F", loaderId: "L", url });
  h.target.frames.set(frame.frameId, frame);
  h.target.sessions.add("client");
  // Avoid starting an OOPIF while exercising the unfixed cross-origin navigation.
  frame.oopifSpawning = true;
  h.send(event, { frameId: frame.frameId, ...params });
  expect(frame).toMatchObject({
    url,
    securityOrigin: "https://first.test",
    lifecycle: "init",
    detached: false,
  });
  expect(h.emitted).toEqual([]);
  h.send("kitesurf.frameAttached", { frameId: "child", url, ownerBackendNodeId: 7 });
  h.emitted.length = 0;
  h.send("kitesurf.frameNavigated", { frameId: "child", url: "https://first.test/next.html" });
  expect(h.target.frames.get("child")?.url).toBe("https://first.test/next.html");
  expect(
    h.emitted.some((e) => e.method === "Page.frameNavigated" && e.params.frame.id === "child"),
  ).toBe(true);
});
