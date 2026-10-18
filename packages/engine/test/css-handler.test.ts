// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, it, expect } from "vitest";
import { handleCss } from "../src/cdp/css.ts";
import type { DispatchCtx } from "../src/cdp/dispatch.ts";
import type { CdpParamsOf, TargetState } from "../src/cdp/types.ts";
import type { PageScriptStub } from "../src/eval/page-script.ts";
import type { QueryDomArgs, QueryDomMethod, QueryDomResult } from "@kitesurf/jsrpc-types/query-dom";

type StubReplies = Partial<{ [M in QueryDomMethod]: QueryDomResult<M> }>;

function makeStub(replies: StubReplies, failure?: Error) {
  const stub = {
    async queryDom<M extends QueryDomMethod>(
      method: M,
      _args: QueryDomArgs<M>,
    ): Promise<QueryDomResult<M>> {
      if (failure) throw failure;
      const reply = replies[method];
      if (reply === undefined) throw new Error(`unexpected queryDom: ${method}`);
      return reply;
    },
  };
  return stub as PageScriptStub;
}

function makeTarget(stub: PageScriptStub): TargetState {
  return {
    type: "page",
    sessions: new Set(["s1"]),
    pageScript: stub,
    blankReady: null,
    cssEnabledSessions: new Set<string>(),
    styleSheets: new Map(),
  } as TargetState;
}

function makeCtx(target: TargetState): DispatchCtx {
  return {
    browser: { targets: new Map([["t1", target]]) },
  } as DispatchCtx;
}

type CssNodeRequestMethod = "CSS.getComputedStyleForNode" | "CSS.getInlineStylesForNode";
type CssNodeRequestParams = CdpParamsOf<"CSS.getComputedStyleForNode"> &
  CdpParamsOf<"CSS.getInlineStylesForNode">;

function req(method: CssNodeRequestMethod, params: CssNodeRequestParams) {
  if (method === "CSS.getComputedStyleForNode") {
    return { id: 1, method, params, sessionId: "s1" };
  }
  return { id: 1, method, params, sessionId: "s1" };
}

describe("CSS.getComputedStyleForNode", () => {
  it("maps the isolate reply onto the CDP wire shape", async () => {
    const target = makeTarget(
      makeStub({
        getComputedStyle: {
          computedStyle: [{ name: "color", value: "rgb(0, 0, 0)" }],
        },
      }),
    );
    const r = (await handleCss(
      makeCtx(target),
      req("CSS.getComputedStyleForNode", { nodeId: 5 }),
    )) as { computedStyle: unknown };
    expect(r.computedStyle).toEqual([{ name: "color", value: "rgb(0, 0, 0)" }]);
  });

  it("degrades to an empty reply when the isolate RPC blows up", async () => {
    const target = makeTarget(makeStub({}, new Error("wasm panicked")));
    const r = (await handleCss(
      makeCtx(target),
      req("CSS.getComputedStyleForNode", { nodeId: 5 }),
    )) as { computedStyle: unknown };
    expect(r.computedStyle).toEqual([]);
  });
});

describe("CSS.getInlineStylesForNode", () => {
  it("splits the style attribute into CDP declarations", async () => {
    const target = makeTarget(
      makeStub({
        getAttributes: {
          attributes: ["class", "x", "style", "color: red; margin: 0"],
        },
      }),
    );
    const r = (await handleCss(
      makeCtx(target),
      req("CSS.getInlineStylesForNode", { nodeId: 5 }),
    )) as {
      inlineStyle?: { cssProperties: Array<{ name: string; value: string }> };
    };
    const names = r.inlineStyle?.cssProperties.map((p) => p.name);
    expect(names).toContain("color");
    expect(names).toContain("margin");
  });

  it("returns an empty reply when the node has no style attribute", async () => {
    const target = makeTarget(makeStub({ getAttributes: { attributes: ["class", "x"] } }));
    const r = await handleCss(makeCtx(target), req("CSS.getInlineStylesForNode", { nodeId: 5 }));
    expect(r).toEqual({});
  });
});
