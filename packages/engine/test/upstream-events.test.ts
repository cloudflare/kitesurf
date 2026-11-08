// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import type { ReceivedUpstreamParams, UpstreamEventName } from "@kitesurf/jsrpc-types/page-script";
import { installUpstreamEventHandler } from "../src/cdp/page.ts";
import type { DispatchCtx } from "../src/cdp/dispatch.ts";
import type { DedicatedWorkers, WorkerOwner } from "../src/cdp/dedicated-workers.ts";
import type { CdpEvent, TargetState } from "../src/cdp/types.ts";
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
  } as Partial<DedicatedWorkers>;
  const ctx = {
    browser: { wsClosing: false, learnedInsertedScripts: store, dedicatedWorkers },
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
  } as TargetState;
  installUpstreamEventHandler(ctx, target, stub, 1, isolateUrl);
  const send = (event: UpstreamEventName, params: ReceivedUpstreamParams) =>
    handler!(event, params);
  return { store, emitted, target, send };
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
