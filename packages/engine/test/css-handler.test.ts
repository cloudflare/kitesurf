// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, it, expect } from "vitest";
import { handleCss, syncStyleSheetsFromEnumeration } from "../src/cdp/css.ts";
import { ensureInterception, unregisterInterception } from "../src/cdp/fetch-interception.ts";
import { registerOutboundFilters } from "../src/cdp/outbound-filter-registry.ts";
import {
  createSandboxOutboundOverride,
  type SandboxOutboundEnv,
  type SandboxOutboundExports,
} from "../src/eval/outbound.ts";
import type { DispatchCtx } from "../src/cdp/dispatch.ts";
import type { CdpParamsOf, CdpRequest, CdpResultOf, TargetState } from "../src/cdp/types.ts";
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

describe("CSS.getMatchedStylesForNode source ranges", () => {
  async function ranges(text: string, line: number, count: number) {
    const rules = Array.from({ length: count }, (_, i) => ({
      selector_text: "a",
      declarations: [{ name: "--x", value: "1" }],
      source_line: line + i,
    }));
    const stub = makeStub({
      enumerateStyleSheets: { sheets: [{ ownerNodeId: 2, text }] },
      parseStyleSheet: { sheet: { rules } } as QueryDomResult<"parseStyleSheet">,
      matchSelectorList: { matches: [0] } as QueryDomResult<"matchSelectorList">,
    });
    const target = makeTarget(stub);
    target.nextStyleSheetRev = new Map();
    await syncStyleSheetsFromEnumeration(makeCtx(target), target, stub);
    const m = (
      (await handleCss(makeCtx(target), {
        id: 1,
        method: "CSS.getMatchedStylesForNode",
        params: { nodeId: 5 },
      } as CdpRequest)) as CdpResultOf<"CSS.getMatchedStylesForNode">
    ).matchedCSSRules?.[0];
    const s = m?.rule.style;
    const sel = m?.rule.selectorList.selectors[0];
    return [s?.range, sel?.range, s?.cssProperties[0]?.range].flatMap((x) =>
      x ? [x.startLine, x.startColumn, x.endLine, x.endColumn] : [null],
    );
  }
  it.each([
    ["CR, FF, escapes", "\r\f\\(\\{\\,{x:a\\;b}", 2, 1, [2, 6, 2, 14, 2, 0, 2, 6, 2, 7, 2, 13]],
    ["8000 escaped", ".a\\( {x:1}\n", 0, 8000, [0, 5, 0, 10, 0, 0, 0, 4, 0, 6, 0, 9]],
  ])("maps %s to body, selector and declaration ranges", async (_, unit, line, count, expected) => {
    const start = performance.now();
    expect(await ranges(unit.repeat(count), line, count)).toEqual(expected);
    if (count > 1) expect(performance.now() - start).toBeLessThan(250);
  });
});

describe("CSS stylesheet owner reconciliation", () => {
  // Enumerations are "ownerNodeId:text"; a non-null second round re-enumerates.
  const owners = (count: number): string[] => Array.from({ length: count }, (_, i) => `${i}:x`);
  const rows: Array<[string, string[], string[] | null, string[], number?]> = [
    ["keeps finite owners", ["3:a", "-1:b"], null, ["3:a", "-1:b"]],
    ["updates an owner in place", ["3:a"], ["3:c"], ["3:c"]],
    ["collapses a duplicate owner", ["1:a", "1:b"], null, ["1:b"]],
    ["drops repeated NaN", ["NaN:a", "NaN:b"], null, []],
    ["drops infinities", ["Infinity:a", "-Infinity:b"], null, []],
    ["indexes 8000 distinct owners", owners(8000), null, owners(8000), 250],
  ];
  it.each(rows)("%s", async (_, first, second, expected, maxMs) => {
    const replies: StubReplies = {};
    const stub = makeStub(replies);
    const target = makeTarget(stub);
    target.nextStyleSheetRev = new Map();
    const start = performance.now();
    for (const sheets of second ? [first, second] : [first]) {
      replies.enumerateStyleSheets = {
        sheets: sheets.map((s) => {
          const at = s.indexOf(":");
          return { ownerNodeId: Number(s.slice(0, at)), text: s.slice(at + 1) };
        }),
      } as QueryDomResult<"enumerateStyleSheets">;
      await syncStyleSheetsFromEnumeration(makeCtx(target), target, stub);
    }
    const elapsed = performance.now() - start;
    expect([...target.styleSheets.values()].map((e) => `${e.ownerNodeId}:${e.text}`)).toEqual(
      expected,
    );
    if (maxMs !== undefined) expect(elapsed).toBeLessThan(maxMs);
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

describe("CSS opaque stylesheet read bounds", () => {
  it("bounds a lengthless opaque sheet and the shared text cache", async () => {
    const cancelled: string[] = [];
    let fetched = 0;
    const replies: StubReplies = {};
    const stub = makeStub(replies);
    const target = makeTarget(stub);
    target.nextStyleSheetRev = new Map();
    const body = (url: string, n: number) => {
      let left = n;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            if (left <= 0) return c.close();
            c.enqueue(new Uint8Array(Math.min(left, 65536)).fill(97));
            left -= 65536;
          },
          cancel: () => void cancelled.push(url),
        }),
      );
    };
    // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only the fields the fetch path reads are set.
    const ctx = {
      browser: {
        targets: new Map([["t1", target]]),
        sandboxOutbound: {
          external: false,
          parent: () => ({
            fetch: async (r: Request) => {
              fetched += 1;
              return body(r.url, r.url.includes("oversize") ? 8 * 1024 * 1024 + 1 : 1024 * 1024);
            },
          }),
        },
      },
      connectionId: "c1",
      emit: () => {},
      env: {},
    } as unknown as DispatchCtx;
    const sync = async (ownerNodeId: number, sourceURL: string) => {
      replies.enumerateStyleSheets = {
        sheets: [{ ownerNodeId, text: "", sourceURL, cors: "opaque" }],
      } as QueryDomResult<"enumerateStyleSheets">;
      await syncStyleSheetsFromEnumeration(ctx, target, stub);
      return [...target.styleSheets.values()][0]?.text ?? "";
    };

    expect((await sync(0, "https://cdn.test/oversize.css")).length).toBe(0);
    expect(cancelled).toEqual(["https://cdn.test/oversize.css"]);
    await sync(0, "https://cdn.test/oversize.css");
    expect(fetched).toBe(1);
    expect((await sync(1, "https://cdn.test/1.css")).length).toBe(1024 * 1024);
    for (let i = 2; i <= 25; i++) await sync(i, `https://cdn.test/${i}.css`);
    const before = fetched;
    await sync(1, "https://cdn.test/1.css");
    expect(fetched).toBe(before + 1);
  });
});

describe("CSS.getMatchedStylesForNode reply bounds", () => {
  async function matched(selector: string, count: number, ancestors: number) {
    const rule = { selector_text: selector, declarations: [{ name: "color", value: "red" }] };
    const stub = makeStub({
      parseStyleSheet: {
        sheet: { rules: Array.from({ length: count }, () => rule) },
      } as QueryDomResult<"parseStyleSheet">,
      matchSelectorList: { matches: [0] },
      getAncestorElementIds: { ancestorIds: Array.from({ length: ancestors }, (_, i) => i + 1) },
    });
    const target = makeTarget(stub);
    target.styleSheets.set("s", {
      ownerNodeId: 2,
      rev: 1,
      text: `${selector}{color:red}`,
      isInline: true,
      sourceURL: "",
      origin: "regular",
      parsed: null,
    });
    return (await handleCss(makeCtx(target), {
      id: 1,
      method: "CSS.getMatchedStylesForNode",
      params: { nodeId: 5 },
      sessionId: "s1",
    } as CdpRequest)) as CdpResultOf<"CSS.getMatchedStylesForNode">;
  }

  it("bounds a large inherited reply", async () => {
    const r = await matched(Array.from({ length: 2048 }, () => "*").join(","), 1, 128);
    expect(r.matchedCSSRules?.length).toBe(1);
    expect(r.inherited?.some((e) => e.matchedCSSRules.length > 0)).toBe(true);
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  it("keeps every match of a large ordinary sheet", async () => {
    expect((await matched(".row > .col, .card-body", 3000, 0)).matchedCSSRules?.length).toBe(3000);
  });
});
