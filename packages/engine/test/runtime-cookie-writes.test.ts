// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import type { DispatchCtx } from "../src/cdp/dispatch.ts";
import { makeChildFrameState } from "../src/cdp/frames.ts";
import { handleRuntime } from "../src/cdp/runtime.ts";
import type { CdpRequest, TargetState } from "../src/cdp/types.ts";
import { createCookieJar } from "../src/cookies.ts";
import type { PageScriptStub } from "../src/eval/page-script.ts";

const FIRST = "https://first.test/";
const NEXT = "https://next.test/";

function heldStub() {
  const held: Array<(cookieWrites: string[]) => void> = [];
  const call = () =>
    new Promise((resolve) =>
      held.push((cookieWrites) =>
        resolve({ ok: true, type: "string", valueJson: '"x"', cookieWrites }),
      ),
    );
  const stub = { evaluate: call, callFunctionOn: call, runScript: call };
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only the three eval methods are stubbed.
  return { stub: stub as unknown as PageScriptStub, held };
}

function setup() {
  const { stub, held } = heldStub();
  const target = {
    type: "page",
    targetId: "T",
    frameId: "F",
    loaderId: "L",
    browserContextId: "",
    url: FIRST,
    pageScriptUrl: FIRST,
    frames: new Map(),
    sessions: new Set<string>(),
    pageScript: stub,
    blankReady: null,
    navigateGeneration: 1,
    defaultContextId: 1,
  } as TargetState;
  const cookies = createCookieJar();
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only the fields the Runtime handlers read are set.
  const ctx = {
    env: {},
    emit: () => {},
    browser: { targets: new Map([["T", target]]), cookies, contexts: new Map() },
  } as unknown as DispatchCtx;
  return { ctx, target, cookies, held };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const requests = [
  { method: "Runtime.evaluate", params: { expression: "location.href", returnByValue: true } },
  {
    method: "Runtime.callFunctionOn",
    params: { functionDeclaration: "function(){return 1}", returnByValue: true },
  },
  { method: "Runtime.runScript", params: { scriptId: "1", returnByValue: true } },
].map((r, i) => ({ id: i + 1, ...r }) as CdpRequest);

describe.each(requests)("$method reply cookie writes", (req) => {
  it("stay on the answering document while a navigate moved target.url", async () => {
    const { ctx, target, cookies, held } = setup();
    target.url = NEXT;
    const pending = handleRuntime(ctx, req);
    await flush();
    held[0]!(["a=1; Path=/"]);
    await pending;
    expect(cookies.documentCookieString(NEXT)).toBe("");
    expect(cookies.documentCookieString(FIRST)).toBe("a=1");
  });

  it("stay on the answering document when target.url moves during the call", async () => {
    const { ctx, target, cookies, held } = setup();
    const pending = handleRuntime(ctx, req);
    await flush();
    target.url = NEXT;
    held[0]!(["a=1; Path=/"]);
    await pending;
    expect(cookies.documentCookieString(NEXT)).toBe("");
    expect(cookies.documentCookieString(FIRST)).toBe("a=1");
  });

  it("are dropped when the answering isolate was replaced during the call", async () => {
    const { ctx, target, cookies, held } = setup();
    const pending = handleRuntime(ctx, req);
    await flush();
    target.url = NEXT;
    target.pageScriptUrl = NEXT;
    target.pageScript = heldStub().stub;
    held[0]!(["a=1; Path=/"]);
    await pending.catch(() => {});
    expect(cookies.getAll()).toEqual([]);
  });

  it("land on the document's url after a same-origin history change", async () => {
    const { ctx, target, cookies, held } = setup();
    target.url = `${FIRST}app/page`;
    const pending = handleRuntime(ctx, req);
    await flush();
    held[0]!(["a=1"]);
    await pending;
    expect(cookies.documentCookieString(FIRST)).toBe("a=1");
  });
});

describe("an out-of-process frame's reply cookie writes", () => {
  const setupFrame = () => {
    const h = setup();
    const child = heldStub();
    const frame = makeChildFrameState({
      frameId: "C",
      parentFrameId: "F",
      loaderId: "LC",
      url: "https://child.test/",
      name: "",
      ownerElementId: "",
      ownerBackendNodeId: 2,
      isCrossOrigin: true,
      delaysLoadEvent: false,
    });
    frame.pageScript = child.stub;
    frame.execContextId = 7;
    h.target.frames.set("C", frame);
    const req = {
      id: 1,
      method: "Runtime.evaluate",
      params: { expression: "location.href", contextId: 7 },
    } as CdpRequest;
    return { ...h, frame, held: child.held, req };
  };

  it("land on the frame's url", async () => {
    const { ctx, cookies, held, req } = setupFrame();
    const pending = handleRuntime(ctx, req);
    await flush();
    held[0]!(["c=1"]);
    await pending;
    expect(cookies.documentCookieString("https://child.test/")).toBe("c=1");
  });

  it("are dropped when the frame navigated during the call", async () => {
    const { ctx, cookies, frame, held, req } = setupFrame();
    const pending = handleRuntime(ctx, req);
    await flush();
    frame.url = "https://other.test/";
    frame.pageScript = null;
    held[0]!(["c=1"]);
    await pending.catch(() => {});
    expect(cookies.getAll()).toEqual([]);
  });
});
