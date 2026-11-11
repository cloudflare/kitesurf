// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { ReceivedUpstreamParams, UpstreamEventName } from "@kitesurf/jsrpc-types/page-script";
import { createCookieJar } from "../src/cookies.ts";
import { makeMainFrameState } from "../src/cdp/frames.ts";
import { installUpstreamEventHandler } from "../src/cdp/page.ts";
import type { DispatchCtx } from "../src/cdp/dispatch.ts";
import type { DedicatedWorkers, WorkerOwner } from "../src/cdp/dedicated-workers.ts";
import type { CdpEvent, TargetState } from "../src/cdp/types.ts";
import { testClient } from "./client-state.ts";
import { NetworkEventTracker } from "../src/cdp/network-events.ts";
import type { PageScriptStub, UpstreamEventHandler } from "../src/eval/page-script.ts";

const PAGE = "https://a.test/challenge";

function installFor(isolateUrl: string) {
  let handler: UpstreamEventHandler | null = null;
  const stub = {
    setUpstreamEventHandler(h: UpstreamEventHandler | null) {
      handler = h;
    },
  } as PageScriptStub;
  const targets = new Map<string, TargetState>();
  const cookies = createCookieJar();
  const dedicatedWorkers = {
    ownerFor: (): WorkerOwner | null => null,
    terminateFrame: () => {},
  } as Partial<DedicatedWorkers>;
  const ctx = {
    browser: {
      wsClosing: false,
      learnedInsertedScripts: new Map(),
      dedicatedWorkers,
      networkEvents: new NetworkEventTracker(() => {}, "test"),
      targets,
      contexts: new Map(),
      cookies,
    },
    emit: (_e: CdpEvent) => {},
    client: testClient(),
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
    navigationHistory: [{ id: 1, url: isolateUrl, userTypedURL: isolateUrl, title: "" }],
    navigationHistoryIndex: 0,
    nextNavigationHistoryId: 2,
    frames: new Map([["F", makeMainFrameState({ frameId: "F", loaderId: "L", url: isolateUrl })]]),
    domStorageSessions: new Map(),
    autoReloadCount: 0,
    lastLoadAt: 0,
  } as TargetState;
  targets.set(target.targetId, target);
  installUpstreamEventHandler(ctx, target, stub, 1, isolateUrl);
  const send = (event: UpstreamEventName, params: ReceivedUpstreamParams) =>
    handler!(event, params);
  return { send, cookies };
}

// A document still loading has no stub to drain, so the cookies it stored before navigating
// travel with the navigation it reports and are in the jar before the request is built.
describe("the cookies a page-started navigation reports", () => {
  it("are stored under the reporting document's URL", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { send, cookies } = installFor(PAGE);
    send("kitesurf.navigatedWithinDocument", {
      url: PAGE,
      navigationType: "other",
      kind: "navigate",
      previousUrl: PAGE,
      cookieWrites: ["tok=1; Path=/", 7],
    });
    send("kitesurf.formSubmitNavigate", { url: `${PAGE}?a=1`, cookieWrites: ["form=2"] });
    expect(cookies.documentCookieString("https://a.test/challenge")).toBe("tok=1; form=2");
    warn.mockRestore();
  });

  it("are ignored for a same-document change", () => {
    const { send, cookies } = installFor(PAGE);
    send("kitesurf.navigatedWithinDocument", {
      url: `${PAGE}#x`,
      navigationType: "fragment",
      kind: "hash",
      previousUrl: PAGE,
      cookieWrites: ["tok=1; Path=/"],
    });
    expect(cookies.documentCookieString(PAGE)).toBe("");
  });
});
