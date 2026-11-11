// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import type Protocol from "devtools-protocol";
import type { PackedResult } from "@kitesurf/jsrpc-types/shared";
import type { DispatchCtx } from "../src/cdp/dispatch.ts";
import { makeChildFrameState } from "../src/cdp/frames.ts";
import { handleRuntime } from "../src/cdp/runtime.ts";
import type { CdpRequest, FrameState, TargetState } from "../src/cdp/types.ts";
import { createCookieJar } from "../src/cookies.ts";
import { consoleEntryToCdpEvent, type PageScriptStub } from "../src/eval/page-script.ts";

const FIRST = "https://first.test/";
const NEXT = "https://next.test/";

function heldStub(stamp?: string) {
  const held: Array<(cookieWrites: string[]) => void> = [];
  const call = () =>
    new Promise((resolve) =>
      held.push((cookieWrites) =>
        resolve({ ok: true, type: "string", valueJson: '"x"', cookieWrites }),
      ),
    );
  const stub = { evaluate: call, callFunctionOn: call, runScript: call, isolateStamp: stamp };
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only the three eval methods are stubbed.
  return { stub: stub as unknown as PageScriptStub, held };
}

function setup(stamp?: string) {
  const { stub, held } = heldStub(stamp);
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

const CHILD = "https://child.test/";
const OTHER = "https://other.test/";

const oopifRequests = [
  {
    method: "Runtime.evaluate",
    params: { expression: "location.href", contextId: 7, returnByValue: true },
  },
  {
    method: "Runtime.callFunctionOn",
    params: {
      functionDeclaration: "function(){return 1}",
      executionContextId: 7,
      returnByValue: true,
    },
  },
].map((r, i) => ({ id: i + 1, ...r }) as CdpRequest);

describe("an out-of-process frame's reply cookie writes", () => {
  const setupFrame = () => {
    const h = setup();
    const child = heldStub();
    const frame = makeChildFrameState({
      frameId: "C",
      parentFrameId: "F",
      loaderId: "LC",
      url: CHILD,
      name: "",
      ownerElementId: "",
      ownerBackendNodeId: 2,
      isCrossOrigin: true,
      delaysLoadEvent: false,
    });
    frame.pageScript = child.stub;
    frame.pageScriptUrl = CHILD;
    frame.execContextId = 7;
    h.target.frames.set("C", frame);
    const req = oopifRequests[0]!;
    return { ...h, frame, held: child.held, req };
  };

  it("land on the frame's url", async () => {
    const { ctx, cookies, held, req } = setupFrame();
    const pending = handleRuntime(ctx, req);
    await flush();
    held[0]!(["c=1"]);
    await pending;
    expect(cookies.documentCookieString(CHILD)).toBe("c=1");
  });

  it("are dropped when the frame navigated during the call", async () => {
    const { ctx, cookies, frame, held, req } = setupFrame();
    const pending = handleRuntime(ctx, req);
    await flush();
    frame.url = OTHER;
    frame.pageScript = null;
    held[0]!(["c=1"]);
    await pending.catch(() => {});
    expect(cookies.getAll()).toEqual([]);
  });

  it("are dropped when the frame has no sealed url", async () => {
    const { ctx, cookies, frame, held, req } = setupFrame();
    frame.pageScriptUrl = null;
    const pending = handleRuntime(ctx, req);
    await flush();
    held[0]!(["c=1; Path=/"]);
    await pending;
    expect(cookies.getAll()).toEqual([]);
  });

  describe.each(oopifRequests)(
    "$method reply writes stay with the installed frame document when frame metadata moves",
    (req) => {
      it("after the metadata moves during the call", async () => {
        const { ctx, cookies, frame, held } = setupFrame();
        const pending = handleRuntime(ctx, req);
        await flush();
        frame.url = OTHER;
        held[0]!(["c=1; Path=/"]);
        await pending;
        expect(cookies.documentCookieString(CHILD)).toBe("c=1");
        expect(cookies.documentCookieString(OTHER)).toBe("");
      });

      it("when the metadata already moved before dispatch", async () => {
        const { ctx, cookies, frame, held } = setupFrame();
        frame.url = OTHER;
        const pending = handleRuntime(ctx, req);
        await flush();
        held[0]!(["c=1; Path=/"]);
        await pending;
        expect(cookies.documentCookieString(CHILD)).toBe("c=1");
        expect(cookies.documentCookieString(OTHER)).toBe("");
      });
    },
  );
});

describe("runtime value json", () => {
  const MAX = 16 * 1024 * 1024;
  const oversized = `{"k":"${"€".repeat(Math.floor(MAX / 3) + 1)}"}`;
  const reply = (valueJson: string): PackedResult => ({
    ok: true,
    type: "object",
    valueJson,
    serializationError: null,
  });

  async function evaluate(valueJson: string) {
    const { ctx, target } = setup();
    // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only evaluate is stubbed.
    target.pageScript = { evaluate: async () => reply(valueJson) } as unknown as PageScriptStub;
    return (await handleRuntime(ctx, {
      id: 1,
      method: "Runtime.evaluate",
      params: { expression: "value", returnByValue: true },
    } as CdpRequest)) as Protocol.Runtime.EvaluateResponse;
  }

  it("parses within the limit and refuses a value over the utf8 byte limit", async () => {
    const small = await evaluate('{"a":1}');
    expect(small.exceptionDetails).toBeUndefined();
    expect(small.result.value).toEqual({ a: 1 });
    const big = await evaluate(oversized);
    expect(big.exceptionDetails?.text).toBe("Runtime result exceeds the value size limit");
    expect(big.result.className).toBe("Error");
  });

  it("skips an oversized console argument", () => {
    const event = consoleEntryToCdpEvent({ level: "log", timestamp: 0, args: [reply(oversized)] });
    expect(event.params.args[0]!.type).toBe("object");
    expect(event.params.args[0]!.value).toBeUndefined();
  });
});

function owner(stamp: string) {
  const calls: string[] = [];
  const stub: Record<string, unknown> = { isolateStamp: stamp };
  for (const m of ["callFunctionOn", "compileScript", "runScript"]) {
    stub[m] = () => (calls.push(m), Promise.resolve({ ok: true, scriptId: null }));
  }
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only the routed methods are stubbed.
  return { stub: stub as unknown as PageScriptStub, calls };
}

function setupOwners() {
  const { ctx, target } = setup();
  const parent = owner("p");
  const child = owner("c");
  const childUrl = "https://child.test/";
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only the fields these handlers read are set.
  const frame = { frameId: "C", url: childUrl, pageScript: child.stub } as unknown as FrameState;
  target.pageScript = parent.stub;
  target.frames.set("C", frame);
  target.isolatedWorlds = [{ name: "child", frameId: "C", id: 9 }];
  return { ctx, frame, parent, child };
}

it("routes remote ids to the isolate that minted them", async () => {
  const { ctx, frame, parent, child } = setupOwners();
  const run = (method: string, params: Record<string, unknown>) =>
    handleRuntime(ctx, { id: 1, method, params } as CdpRequest);
  await run("Runtime.callFunctionOn", { functionDeclaration: "()=>1", objectId: "ps:c:1" });
  await run("Runtime.compileScript", { expression: "1", sourceURL: "", executionContextId: 9 });
  await run("Runtime.runScript", { scriptId: "cs:c:1" });
  expect(child.calls).toEqual(["callFunctionOn", "compileScript", "runScript"]);
  expect(parent.calls).toEqual([]);
  const cfn = { functionDeclaration: "()=>1", objectId: "ps:c:1" };
  const mixed = { ...cfn, arguments: [{ objectId: "ps:p:1" }] };
  expect(await run("Runtime.callFunctionOn", mixed)).toHaveProperty("exceptionDetails");
  frame.pageScript = owner("n").stub;
  expect(await run("Runtime.callFunctionOn", cfn)).toHaveProperty("exceptionDetails");
  expect([child.calls.length, parent.calls.length]).toEqual([3, 0]);
  Object.assign(frame, { pageScript: null, isCrossOrigin: true });
  const compile = { expression: "1", sourceURL: "", executionContextId: 9 };
  expect(await run("Runtime.compileScript", compile)).toHaveProperty("exceptionDetails");
  expect(parent.calls).toEqual([]);
});

describe("a main-isolate call waits for the ready isolate", () => {
  it("Runtime.callFunctionOn lands on the successor installed while about:blank was pending", async () => {
    const { ctx, target, held } = setup();
    const next = heldStub();
    let releaseBlank!: () => void;
    target.blankReady = new Promise<void>((resolve) => (releaseBlank = resolve));
    const pending = handleRuntime(ctx, {
      id: 1,
      method: "Runtime.callFunctionOn",
      params: { functionDeclaration: "function(){return 1}", returnByValue: true },
    } as CdpRequest);
    await flush();
    target.pageScript = next.stub;
    releaseBlank();
    await flush();
    held[0]?.([]);
    next.held[0]?.([]);
    await pending;
    expect(held).toHaveLength(0);
    expect(next.held).toHaveLength(1);
  });

  it("Runtime.runScript rejects a script minted by the outgoing isolate", async () => {
    const { ctx, target, held } = setup("old");
    const next = heldStub("next");
    let releaseBlank!: () => void;
    target.blankReady = new Promise<void>((resolve) => (releaseBlank = resolve));
    const pending = handleRuntime(ctx, {
      id: 1,
      method: "Runtime.runScript",
      params: { scriptId: "cs:old:1", returnByValue: true },
    } as CdpRequest);
    await flush();
    target.pageScript = next.stub;
    releaseBlank();
    await flush();
    held[0]?.([]);
    next.held[0]?.([]);
    const res = (await pending) as Protocol.Runtime.RunScriptResponse;
    expect(res.exceptionDetails?.exception?.description).toMatch(/unknown or destroyed scriptId/);
    expect(held).toHaveLength(0);
    expect(next.held).toHaveLength(0);
  });
});

it("rejects an isolated world whose frameId names no frame", async () => {
  const { ctx, target, held } = setup();
  target.isolatedWorlds = [{ name: "w", frameId: "gone", id: 9 }];
  const pending = handleRuntime(ctx, {
    id: 1,
    method: "Runtime.evaluate",
    params: { expression: "location.href", contextId: 9, returnByValue: true },
  } as CdpRequest);
  await flush();
  held[0]?.([]);
  const res = (await pending) as Protocol.Runtime.EvaluateResponse;
  expect(res.exceptionDetails?.exception?.description).toMatch(/unknown or destroyed contextId 9/);
  expect(held).toHaveLength(0);
});
