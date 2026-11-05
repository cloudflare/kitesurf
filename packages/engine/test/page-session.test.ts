// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, it, expect } from "vitest";
import {
  accessibilityTreeResponse,
  outerHtmlResponse,
  PageSession,
  registerEnsurePageScript,
  resolveTarget,
  sessionOf,
  stubQueryDom,
} from "../src/cdp/page-session.ts";
import type { DispatchCtx } from "../src/cdp/dispatch.ts";
import type { RawJsonResult, TargetState } from "../src/cdp/types.ts";
import type { PageScriptStub } from "../src/eval/page-script.ts";
import type { QueryDomArgs, QueryDomMethod, QueryDomResult } from "@kitesurf/jsrpc-types/query-dom";
import type { Protocol } from "devtools-protocol";

type StubReplies = Partial<{ [M in QueryDomMethod]: QueryDomResult<M> }>;
type StubWithTestState = PageScriptStub & {
  fail: string | null;
  calls: Array<{ method: QueryDomMethod; args: QueryDomArgs<QueryDomMethod> }>;
};

const documentRoot = (nodeId: number) =>
  ({
    nodeId,
    backendNodeId: nodeId,
    nodeType: 9,
    nodeName: "#document",
    localName: "",
    nodeValue: "",
  }) satisfies Protocol.DOM.Node;

function makeStub(replies: StubReplies = {}) {
  const calls: StubWithTestState["calls"] = [];
  const stub = {
    fail: null as string | null,
    calls,
    async queryDom<M extends QueryDomMethod>(
      method: M,
      args: QueryDomArgs<M>,
    ): Promise<QueryDomResult<M>> {
      if (stub.fail) throw new Error(stub.fail);
      calls.push({ method, args });
      return (replies[method] ?? {}) as QueryDomResult<M>;
    },
  };
  return stub as StubWithTestState;
}

function makeTarget(over: Partial<TargetState> = {}): TargetState {
  return {
    type: "page",
    sessions: new Set<string>(),
    pageScript: null,
    blankReady: null,
    ...over,
  } as TargetState;
}

const fakeCtx = {} as DispatchCtx;

function sessionFor(target: TargetState): PageSession {
  return new PageSession(fakeCtx, target);
}

describe("PageSession.pin", () => {
  it("never re-resolves a retired generation across awaits", async () => {
    const old = makeStub({ getDocument: { root: documentRoot(1) } });
    const next = makeStub({ getDocument: { root: documentRoot(2) } });
    const target = makeTarget({
      pageScript: old,
      navigateGeneration: 1,
    });
    const pinned = sessionFor(target).pin()!;
    expect((await pinned.call.getDocument({})).root?.nodeId).toBe(1);
    target.pageScript = next;
    target.navigateGeneration = 2;
    expect(await pinned.ready()).toBeNull();
    expect(await pinned.tryCall.getDocument({})).toBeNull();
    await expect(pinned.call.getDocument({})).rejects.toThrow(/retired/);
    expect(pinned.pin()).toBeNull();
    expect(next.calls).toEqual([]);
  });
});

describe("PageSession.call", () => {
  it("dispatches typed calls over the live stub", async () => {
    const stub = makeStub({ getRect: { rect: { x: 1, y: 2, width: 3, height: 4 } } });
    const target = makeTarget({ pageScript: stub });
    const r = await sessionFor(target).call.getRect({ nodeId: 7 });
    expect(r.rect).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(stub.calls).toEqual([{ method: "getRect", args: { nodeId: 7 } }]);
  });

  it("awaits blankReady before dispatching", async () => {
    const order: string[] = [];
    const stub = makeStub();
    const target = makeTarget({
      pageScript: stub,
      blankReady: Promise.resolve().then(() => {
        order.push("blank");
      }),
    });
    await sessionFor(target).call.getDocument({});
    order.push("dispatched");
    expect(order).toEqual(["blank", "dispatched"]);
    expect(stub.calls[0]?.method).toBe("getDocument");
  });

  it("throws when no isolate exists and none can be spawned", async () => {
    registerEnsurePageScript(() => null);
    const target = makeTarget();
    await expect(sessionFor(target).call.getDocument({})).rejects.toThrow(/No PageScript isolate/);
  });

  it("rethrows RPC failures (dispatch surfaces them as CDP errors)", async () => {
    const stub = makeStub();
    stub.fail = "no document loaded";
    const target = makeTarget({ pageScript: stub });
    await expect(sessionFor(target).call.querySelector({ selector: "p" })).rejects.toThrow(
      /no document loaded/,
    );
  });
});

describe("PageSession.tryCall / callIfLive — the fact-5 guard", () => {
  it("tryCall returns null on RPC failure instead of throwing", async () => {
    const stub = makeStub();
    stub.fail = "wasm panicked";
    const target = makeTarget({ pageScript: stub });
    const r = await sessionFor(target).tryCall.getComputedStyle({ nodeId: 1 });
    expect(r).toBeNull();
  });

  it("tryCall lazily spawns via the registered ensure", async () => {
    const stub = makeStub({ getAttributes: { attributes: ["style", "x"] } });
    const target = makeTarget();
    let ensures = 0;
    registerEnsurePageScript((_ctx, t) => {
      ensures += 1;
      t!.pageScript = stub;
      return t!.pageScript;
    });
    const r = await sessionFor(target).tryCall.getAttributes({ nodeId: 3 });
    expect(r?.attributes).toEqual(["style", "x"]);
    expect(ensures).toBe(1);
  });

  it("callIfLive never spawns: null when no isolate is live", async () => {
    let ensures = 0;
    registerEnsurePageScript(() => {
      ensures += 1;
      return null;
    });
    const target = makeTarget();
    const r = await sessionFor(target).callIfLive.setViewport({
      width: 100,
      height: 100,
    });
    expect(r).toBeNull();
    expect(ensures).toBe(0);
  });
});

describe("sessionOf / resolveTarget", () => {
  it("caches one session per target", () => {
    const target = makeTarget();
    const a = sessionOf(fakeCtx, target);
    const b = sessionOf(fakeCtx, target);
    expect(a).toBe(b);
    expect(target.pageSession).toBe(a);
  });

  it("resolves the session-attached target first", () => {
    const attached = makeTarget({ sessions: new Set(["s1"]) });
    const first = makeTarget();
    const ctx = {
      browser: {
        targets: new Map([
          ["t1", first],
          ["t2", attached],
        ]),
      },
    } as DispatchCtx;
    expect(resolveTarget(ctx, "s1")).toBe(attached);
    expect(resolveTarget(ctx, undefined)).toBe(first);
  });

  it("throws the caller's message when no page target exists", () => {
    const ctx = {
      browser: { targets: new Map() },
    } as DispatchCtx;
    expect(() => resolveTarget(ctx, undefined)).toThrow("No page target attached to session");
    expect(() => resolveTarget(ctx, undefined, "WebMCP: nope")).toThrow("WebMCP: nope");
  });
});

describe("intent proxies", () => {
  it("is not thenable — awaiting an intent must not invoke a method", async () => {
    const stub = makeStub();
    const target = makeTarget({ pageScript: stub });
    const session = sessionFor(target);
    const v = await session.call;
    expect(v).toBe(session.call);
    expect(stub.calls).toEqual([]);
  });

  it("caches the per-method closure", () => {
    const target = makeTarget();
    const session = sessionFor(target);
    expect(session.tryCall.getRect).toBe(session.tryCall.getRect);
  });
});

describe("stubQueryDom — pinned-stub typed calls", () => {
  it("types the wire without touching the stub's identity", async () => {
    const stub = makeStub({ querySelectorAll: { nodeIds: [1, 2] } });
    const r = await stubQueryDom(stub, "querySelectorAll", { selector: "a" });
    expect(r.nodeIds).toEqual([1, 2]);
  });
});

describe("PageSession.ready — the navigate window", () => {
  it("waits for an in-flight navigate and returns the published stub", async () => {
    const fresh = makeStub();
    let publish!: () => void;
    const target = makeTarget({
      pageScript: null,
      blankReady: new Promise<void>((r) => (publish = r)),
    });
    let ensures = 0;
    registerEnsurePageScript((_ctx, t) => {
      ensures += 1;
      if (t!.blankReady) return null;
      return t!.pageScript;
    });
    const pending = sessionFor(target).ready();
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    target.pageScript = fresh;
    target.blankReady = null;
    publish();
    expect(await pending).toBe(fresh);
    expect(ensures).toBe(0);
  });

  it("re-reads the stub after the gate: the one held before may be retired", async () => {
    const old = makeStub();
    const fresh = makeStub({ getDocument: { root: documentRoot(1) } });
    let publish!: () => void;
    const target = makeTarget({
      pageScript: old,
      blankReady: new Promise<void>((r) => (publish = r)),
    });
    registerEnsurePageScript((_ctx, t) => t!.pageScript);
    const pending = sessionFor(target).call.getDocument({});
    target.pageScript = null;
    target.pageScript = fresh;
    target.blankReady = null;
    publish();
    await pending;
    expect(old.calls).toEqual([]);
    expect(fresh.calls.map((c) => c.method)).toEqual(["getDocument"]);
  });

  it("goes round again when a newer navigate re-arms the gate", async () => {
    const fresh = makeStub();
    let first!: () => void;
    let second!: () => void;
    const target = makeTarget({
      pageScript: null,
      blankReady: new Promise<void>((r) => (first = r)),
    });
    registerEnsurePageScript((_ctx, t) => (t!.blankReady ? null : t!.pageScript));
    const pending = sessionFor(target).ready();
    target.blankReady = new Promise<void>((r) => (second = r));
    first();
    await Promise.resolve();
    await Promise.resolve();
    target.pageScript = fresh;
    target.blankReady = null;
    second();
    expect(await pending).toBe(fresh);
  });

  it("never returns a stub retired while its blank build settled", async () => {
    const lazy = makeStub();
    const fresh = makeStub();
    let blankDone!: () => void;
    let publish!: () => void;
    const target = makeTarget();
    registerEnsurePageScript((_ctx, t) => {
      if (t!.blankReady) return null;
      if (t!.pageScript) return t!.pageScript;
      t!.pageScript = lazy;
      t!.blankReady = new Promise<void>((r) => (blankDone = r));
      return t!.pageScript;
    });
    const pending = sessionFor(target).ready();
    await Promise.resolve();
    target.pageScript = null;
    target.blankReady = new Promise<void>((r) => (publish = r));
    blankDone();
    await Promise.resolve();
    await Promise.resolve();
    target.pageScript = fresh;
    target.blankReady = null;
    publish();
    expect(await pending).toBe(fresh);
  });

  it("gives up (null) when no isolate can exist and no gate is armed", async () => {
    registerEnsurePageScript(() => null);
    expect(await sessionFor(makeTarget()).ready()).toBeNull();
  });

  it("spawns lazily and settles the about:blank build when nothing is in flight", async () => {
    const stub = makeStub();
    const order: string[] = [];
    const target = makeTarget();
    registerEnsurePageScript((_ctx, t) => {
      t!.pageScript = stub;
      t!.blankReady = Promise.resolve().then(() => {
        order.push("blank");
      });
      return t!.pageScript;
    });
    expect(await sessionFor(target).ready()).toBe(stub);
    order.push("ready");
    expect(order).toEqual(["blank", "ready"]);
  });
});

describe("outerHtmlResponse", () => {
  type OuterHtmlResult = QueryDomResult<"getOuterHTML">;

  const utf8 = new TextEncoder().encode("<p>é𝔽</p>");

  const streamOf = (chunks: Uint8Array[], onCancel?: () => void) =>
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift();
        if (next) controller.enqueue(next);
        else controller.close();
      },
      cancel: onCancel,
    });

  const resultOf = (chunks: Uint8Array[], byteLength = utf8.byteLength): OuterHtmlResult => ({
    byteLength,
    outerHTMLUtf8: streamOf(chunks),
  });

  const alwaysReplies = (result: OuterHtmlResult) => () => Promise.resolve(result);

  // Replies in turn and records whether each request asked for a snapshot.
  const repliesInTurn = (...results: OuterHtmlResult[]) => {
    const snapshotRequests: Array<boolean | undefined> = [];
    const request = (args: Pick<QueryDomArgs<"getOuterHTML">, "snapshot">) => {
      snapshotRequests.push(args.snapshot);
      const next = results.shift();
      return next ? Promise.resolve(next) : Promise.reject(new Error("no more replies"));
    };
    return { snapshotRequests, request };
  };

  // A live stream that ends one byte before the byteLength it declared.
  const shortByOneByte = (): OuterHtmlResult => ({
    byteLength: utf8.byteLength + 1,
    outerHTMLUtf8: streamOf([utf8]),
  });

  // The wire text must stringify the whole response, and parse() must give it back.
  const expectSerializedAs = (result: RawJsonResult, outerHTML: string) => {
    expect(result.pieces.join("")).toBe(JSON.stringify({ outerHTML }));
    expect(result.parse()).toEqual({ outerHTML });
  };

  it("joins chunks that split a multibyte character", async () => {
    const chunks = [utf8.slice(0, 5), utf8.slice(5, 7), utf8.slice(7)];

    expectSerializedAs(await outerHtmlResponse(alwaysReplies(resultOf(chunks))), "<p>é𝔽</p>");
  });

  it("escapes JSON specials in every chunk", async () => {
    const html = '<p title="a\\b">\n\t\u0001\u2028</p>';
    const bytes = new TextEncoder().encode(html);
    const oneBytePerChunk = Array.from(bytes, (byte) => Uint8Array.of(byte));

    const reply = alwaysReplies(resultOf(oneBytePerChunk, bytes.byteLength));

    expectSerializedAs(await outerHtmlResponse(reply), html);
  });

  it("asks for a snapshot once when the live stream ends short", async () => {
    const { snapshotRequests, request } = repliesInTurn(shortByOneByte(), resultOf([utf8.slice()]));

    expectSerializedAs(await outerHtmlResponse(request), "<p>é𝔽</p>");
    expect(snapshotRequests).toEqual([undefined, true]);
  });

  it("rejects a snapshot stream shorter than byteLength", async () => {
    const { snapshotRequests, request } = repliesInTurn(shortByOneByte(), shortByOneByte());

    await expect(outerHtmlResponse(request)).rejects.toThrow(
      `DOM.getOuterHTML: PageScript stream ended after ${utf8.byteLength} of ${utf8.byteLength + 1} bytes`,
    );
    expect(snapshotRequests).toEqual([undefined, true]);
  });

  it("cancels a stream longer than byteLength", async () => {
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.enqueue(utf8.slice()),
      cancel: () => {
        cancelled = true;
      },
    });

    await expect(
      outerHtmlResponse(alwaysReplies({ byteLength: utf8.byteLength, outerHTMLUtf8: endless })),
    ).rejects.toThrow(`DOM.getOuterHTML: PageScript sent more than ${utf8.byteLength} bytes`);
    expect(cancelled).toBe(true);
  });

  it("cancels the stream when byteLength is invalid", async () => {
    for (const byteLength of [-1, 1.5, Number.NaN]) {
      let cancelled = false;
      const stream = streamOf([utf8], () => {
        cancelled = true;
      });

      const result = { byteLength, outerHTMLUtf8: stream };

      await expect(outerHtmlResponse(alwaysReplies(result))).rejects.toThrow(
        "DOM.getOuterHTML: PageScript sent an invalid byteLength",
      );
      expect(cancelled).toBe(true);
    }
  });
});

describe("accessibilityTreeResponse", () => {
  const streamOf = (chunks: Uint8Array[]) =>
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift();
        if (next) controller.enqueue(next);
        else controller.close();
      },
    });

  it("retries a short live stream and decodes split UTF-8 into string pieces", async () => {
    const text = '{"name":"café 😀"}';
    const encoded = new TextEncoder().encode(text);
    const modes: boolean[] = [];
    const result = await accessibilityTreeResponse((buffered) => {
      modes.push(buffered);
      return Promise.resolve(
        buffered
          ? {
              byteLength: encoded.byteLength,
              json: streamOf([encoded.slice(0, 11), encoded.slice(11, 14), encoded.slice(14)]),
            }
          : { byteLength: encoded.byteLength + 1, json: streamOf([encoded]) },
      );
    }, "Accessibility.getFullAXTree");
    expect(result).toBeInstanceOf(RawJsonResult);
    if (!(result instanceof RawJsonResult)) throw new Error("expected raw JSON result");
    expect(result.pieces.join("")).toBe(text);
    expect(modes).toEqual([false, true]);
  });

  it("returns a budget error without retrying", async () => {
    const budgetError = { nodes: 120_000, bytes: 30_000_000, budget: 25_165_824 };
    const modes: boolean[] = [];
    const result = await accessibilityTreeResponse((buffered) => {
      modes.push(buffered);
      return Promise.resolve({ budgetError });
    }, "Accessibility.getFullAXTree");
    expect(result).toEqual({ budgetError });
    expect(modes).toEqual([false]);
  });
});
