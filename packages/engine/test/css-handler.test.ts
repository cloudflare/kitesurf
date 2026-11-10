// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, it, expect } from "vitest";
import { handleCss } from "../src/cdp/css.ts";
import type { DispatchCtx } from "../src/cdp/dispatch.ts";
import type { CdpParamsOf, CdpRequest, TargetState } from "../src/cdp/types.ts";
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

describe("CSS replies from the isolate", () => {
  // A page can make a reply field a callable stub; the engine must never call into it.
  const calls: string[] = [];
  const callable = (name: string) => ({
    map: () => calls.push(`${name}.map`),
    [Symbol.iterator]: () => calls.push(`${name}[Symbol.iterator]`),
    length: 1,
    0: 0,
  });

  it("copies parsed rules and selector matches into plain data", async () => {
    calls.length = 0;
    const stub = makeStub({
      parseStyleSheet: {
        sheet: {
          rules: [
            {
              selector_text: "p",
              selector_specificities: callable("specificities"),
              declarations: callable("declarations"),
              source_line: 1,
              source_column: 1,
            },
            {
              selector_text: "div",
              selector_specificities: [1],
              declarations: [{ name: "color", value: "red" }, callable("declaration")],
              source_line: 1,
              source_column: 15,
            },
          ],
        },
      } as QueryDomResult<"parseStyleSheet">,
      // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- the reply imitates a stub where an array belongs.
      matchSelectorList: {
        matches: callable("matches"),
      } as unknown as QueryDomResult<"matchSelectorList">,
      // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- the reply imitates a stub where an array belongs.
      getAncestorElementIds: {
        ancestorIds: callable("ancestors"),
      } as unknown as QueryDomResult<"getAncestorElementIds">,
      getComputedStyle: {
        computedStyle: [{ name: "color", value: "red" }, callable("computed")],
      } as QueryDomResult<"getComputedStyle">,
    });
    const target = makeTarget(stub);
    target.styleSheets.set("s", {
      ownerNodeId: 2,
      rev: 1,
      text: "p { color: red } div { color: red }",
      isInline: true,
      sourceURL: "",
      origin: "regular",
      parsed: null,
    });
    const ctx = makeCtx(target);
    const matched = (await handleCss(ctx, {
      id: 1,
      method: "CSS.getMatchedStylesForNode",
      params: { nodeId: 5 },
      sessionId: "s1",
    })) as { matchedCSSRules: unknown[]; inherited: unknown[] };
    const computed = (await handleCss(ctx, req("CSS.getComputedStyleForNode", { nodeId: 5 }))) as {
      computedStyle: unknown;
    };

    expect(calls).toEqual([]);
    expect(matched).toEqual({ matchedCSSRules: [], pseudoElements: [], inherited: [] });
    expect(target.styleSheets.get("s")?.parsed?.rules.map((r) => r.declarations)).toEqual([
      [],
      [{ name: "color", value: "red" }],
    ]);
    expect(computed.computedStyle).toEqual([{ name: "color", value: "red" }]);
  });
});

describe("CSS.enable opaque stylesheet fetches", () => {
  async function enable(sourceURL: unknown) {
    const fetched: Array<{ url: string; method: string }> = [];
    const target = makeTarget(
      makeStub({
        enumerateStyleSheets: {
          sheets: [{ ownerNodeId: 2, text: "", sourceURL, cors: "opaque" }],
        } as QueryDomResult<"enumerateStyleSheets">,
      }),
    );
    target.nextStyleSheetRev = new Map();
    // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only the fields CSS.enable reads are set.
    const ctx = {
      browser: {
        targets: new Map([["t1", target]]),
        sandboxOutbound: {
          external: true,
          final: async (r: Request) => {
            fetched.push({ url: r.url, method: r.method });
            return new Response("p{}");
          },
        },
      },
      emit: () => {},
      env: {},
    } as unknown as DispatchCtx;
    await handleCss(ctx, { id: 1, method: "CSS.enable", sessionId: "s1" } as CdpRequest);
    return { fetched, text: [...target.styleSheets.values()].map((e) => e.text) };
  }

  it("fetches a string http(s) url with GET", async () => {
    expect(await enable("https://cdn.test/a.css")).toEqual({
      fetched: [{ url: "https://cdn.test/a.css", method: "GET" }],
      text: ["p{}"],
    });
  });

  it.each([
    ["a Request", new Request("https://cdn.test/a.css", { method: "POST", body: "x" })],
    ["a URL object", new URL("https://cdn.test/a.css")],
    ["a non-http url", "file:///etc/hosts"],
  ])("does not fetch %s", async (_, sourceURL) => {
    expect((await enable(sourceURL)).fetched).toEqual([]);
  });
});
