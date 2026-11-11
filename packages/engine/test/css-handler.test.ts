// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, it, expect } from "vitest";
import { handleCss } from "../src/cdp/css.ts";
import { ensureInterception, unregisterInterception } from "../src/cdp/fetch-interception.ts";
import { registerOutboundFilters } from "../src/cdp/outbound-filter-registry.ts";
import {
  createSandboxOutboundOverride,
  type SandboxOutboundEnv,
  type SandboxOutboundExports,
} from "../src/eval/outbound.ts";
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
  const SHEET = "https://cdn.test/a.css";
  const HOP = "https://blocked.test/b.css";
  const env: SandboxOutboundEnv = {
    FONT_ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
  };
  const outboundExports: SandboxOutboundExports = {
    SandboxOutbound: () => {
      throw new Error("loaded outbound is not used here");
    },
  };
  const css = (body: string) => new Response(body, { headers: { "content-type": "text/css" } });
  let connectionSeq = 0;

  function harness(
    opts: { walled?: boolean; sourceURL?: unknown; respond?: (url: string) => Response } = {},
  ) {
    const respond = opts.respond ?? (() => css("p{}"));
    const seen: string[] = [];
    const transport = {
      async fetch(request: Request) {
        seen.push(request.url);
        return respond(request.url);
      },
    };
    const walled = opts.walled === true;
    const target = makeTarget(
      makeStub({
        enumerateStyleSheets: {
          sheets: [
            { ownerNodeId: 2, text: "", sourceURL: opts.sourceURL ?? SHEET, cors: "opaque" },
          ],
        } as QueryDomResult<"enumerateStyleSheets">,
      }),
    );
    target.nextStyleSheetRev = new Map();
    const connectionId = `css-sheet-${++connectionSeq}`;
    // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only the fields CSS.enable reads are set.
    const ctx = {
      browser: {
        targets: new Map([["t1", target]]),
        sandboxOutbound: createSandboxOutboundOverride(
          outboundExports,
          env,
          walled ? transport : undefined,
          walled ? undefined : transport,
        ),
      },
      connectionId,
      emit: () => {},
      env: {},
    } as unknown as DispatchCtx;
    return {
      connectionId,
      seen,
      enable: () => handleCss(ctx, { id: 1, method: "CSS.enable", sessionId: "s1" } as CdpRequest),
      texts: () => [...target.styleSheets.values()].map((e) => e.text),
    };
  }

  it.each([false, true])("fetches a string http(s) url with GET (walled=%s)", async (walled) => {
    const h = harness({ walled });
    await h.enable();
    expect(h.seen).toEqual([SHEET]);
    expect(h.texts()).toEqual(["p{}"]);
  });

  it.each([
    ["a Request", new Request(SHEET, { method: "POST", body: "x" })],
    ["a URL object", new URL(SHEET)],
    ["a non-http url", "file:///etc/hosts"],
  ])("does not fetch %s", async (_, sourceURL) => {
    const h = harness({ sourceURL });
    await h.enable();
    expect(h.seen).toEqual([]);
  });

  it.each([false, true])(
    "applies current policy to cached and walled sheet text (walled=%s)",
    async (walled) => {
      // A never-blocked sheet stays inspectable.
      const control = harness({ walled });
      await control.enable();
      await control.enable();
      expect(control.texts()).toEqual(["p{}"]);

      // Denying the original URL after the warm fetch serves no text and no new request.
      const denied = harness({ walled });
      await denied.enable();
      registerOutboundFilters(denied.connectionId, { rejectPatterns: [/a\.css$/] });
      await denied.enable();
      expect(denied.texts()).toEqual([""]);
      expect(denied.seen).toEqual([SHEET]);

      // Denying a redirect hop serves no text and never requests the denied host.
      const redirected = harness({
        walled,
        respond: (url) =>
          url === SHEET
            ? new Response(null, { status: 302, headers: { location: HOP } })
            : css("p{}"),
      });
      await redirected.enable();
      expect(redirected.texts()).toEqual(["p{}"]);
      registerOutboundFilters(redirected.connectionId, { rejectPatterns: [/blocked\.test/] });
      await redirected.enable();
      expect(redirected.texts()).toEqual([""]);
      expect(redirected.seen).toEqual([SHEET, HOP, SHEET]);
    },
  );

  it("caches failures and keeps the cache under a non-matching interception pattern", async () => {
    const failed = harness({ respond: () => new Response(null, { status: 404 }) });
    await failed.enable();
    await failed.enable();
    expect(failed.seen).toEqual([SHEET]);

    const h = harness();
    ensureInterception(h.connectionId).patterns = [{ re: /other\.test/ }];
    await h.enable();
    await h.enable();
    expect(h.seen).toEqual([SHEET]);
    unregisterInterception(h.connectionId);
  });
});
