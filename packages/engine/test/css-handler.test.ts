// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, it, expect, vi } from "vitest";
import {
  MAX_PARSED_DECLARATIONS_PER_SHEET,
  MAX_PARSED_RULES_PER_SHEET,
  handleCss,
  syncStyleSheetsFromEnumeration,
} from "../src/cdp/css.ts";
import { ensureInterception, unregisterInterception } from "../src/cdp/fetch-interception.ts";
import { registerOutboundFilters } from "../src/cdp/outbound-filter-registry.ts";
import { MAX_CONNECTION_READ_BYTES, readCappedBytes } from "../src/read-capped.ts";
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

// Counts queryDom calls for one method by turning its reply into an accessor.
function countCalls(replies: StubReplies, method: QueryDomMethod): () => number {
  let calls = 0;
  const reply = replies[method];
  Object.defineProperty(replies, method, {
    get: () => {
      calls++;
      return reply;
    },
  });
  return () => calls;
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
    env: {},
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

  it("drops a stale enumeration that lands after a navigation", async () => {
    const replies: StubReplies = {
      enumerateStyleSheets: { sheets: [{ ownerNodeId: 7, text: "p{--successor:1}" }] },
    };
    const stub = makeStub(replies);
    const target = makeTarget(stub);
    target.nextStyleSheetRev = new Map();
    target.cssEnabledSessions.add("s1");
    const events: string[] = [];
    const ctx = makeCtx(target);
    ctx.emit = (e) => void events.push(e.method);
    // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only the walled fetch is read.
    ctx.browser.sandboxOutbound = {
      external: true,
      parent: () => ({
        fetch: async () => {
          // The navigation lands while this old document's opaque read is in flight.
          target.navigateGeneration = 1;
          return new Response("p{}");
        },
      }),
    } as unknown as DispatchCtx["browser"]["sandboxOutbound"];
    await syncStyleSheetsFromEnumeration(ctx, target, stub);
    events.length = 0;
    replies.enumerateStyleSheets = {
      sheets: [
        { ownerNodeId: 2, text: "p{--secret:1}" },
        { ownerNodeId: 4, text: "", sourceURL: "https://cdn.test/held.css", cors: "opaque" },
      ],
    };

    await syncStyleSheetsFromEnumeration(ctx, target, stub);

    expect([...target.styleSheets.values()].map((e) => `${e.ownerNodeId}:${e.text}`)).toEqual([
      "7:p{--successor:1}",
    ]);
    expect(events).toEqual([]);
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

  type HarnessSheet = {
    ownerNodeId: number;
    text: string;
    sourceURL?: string;
    isInline?: boolean;
    origin?: "regular" | "user-agent" | "injected" | "inspector";
    cors?: "clean" | "opaque" | "pending";
  };

  function harness(
    opts: {
      walled?: boolean;
      sourceURL?: unknown;
      respond?: (url: string) => Response;
      sheets?: HarnessSheet[];
    } = {},
  ) {
    const respond = opts.respond ?? (() => css("p{}"));
    const seen: string[] = [];
    const attempts: string[] = [];
    const headers: Array<{ endLine: number; endColumn: number }> = [];
    const events: string[] = [];
    const transport = {
      async fetch(request: Request) {
        seen.push(request.url);
        return respond(request.url);
      },
    };
    const walled = opts.walled === true;
    const replies: StubReplies = {
      enumerateStyleSheets: {
        sheets: opts.sheets ?? [
          { ownerNodeId: 2, text: "", sourceURL: opts.sourceURL ?? SHEET, cors: "opaque" },
        ],
      } as QueryDomResult<"enumerateStyleSheets">,
    };
    const target = makeTarget(makeStub(replies));
    target.nextStyleSheetRev = new Map();
    const connectionId = `css-sheet-${++connectionSeq}`;
    const sandboxOutbound = createSandboxOutboundOverride(
      outboundExports,
      env,
      walled ? transport : undefined,
      walled ? undefined : transport,
    );
    const parent = sandboxOutbound.parent;
    sandboxOutbound.parent = (props) => {
      const inner = parent(props);
      return {
        ...inner,
        fetch: (request: Request) => {
          attempts.push(request.url);
          return inner.fetch(request);
        },
      } as typeof inner;
    };
    // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only the fields CSS.enable reads are set.
    const ctx = {
      browser: {
        targets: new Map([["t1", target]]),
        sandboxOutbound,
      },
      connectionId,
      emit: () => {},
      env: {},
    } as unknown as DispatchCtx;
    ctx.emit = (event) => {
      events.push(event.method);
      if (event.method !== "CSS.styleSheetAdded") return;
      const params = event.params as { header?: { endLine: number; endColumn: number } };
      if (params.header) headers.push(params.header);
    };
    return {
      connectionId,
      seen,
      attempts,
      headers,
      events,
      enable: () => handleCss(ctx, { id: 1, method: "CSS.enable", sessionId: "s1" } as CdpRequest),
      texts: () => [...target.styleSheets.values()].map((e) => e.text),
      entries: () => [...target.styleSheets.values()],
      setSheets: (sheets: HarnessSheet[]) => {
        replies.enumerateStyleSheets = { sheets } as QueryDomResult<"enumerateStyleSheets">;
      },
    };
  }

  // Holds this connection's whole read share until release, so the next read is refused as
  // "budget" without touching the network.
  function holdReadBudget(connectionId: string) {
    const gate: { release: (() => void) | null } = { release: null };
    const response = new Response(
      new ReadableStream<Uint8Array>({
        async pull(c) {
          c.enqueue(new Uint8Array(MAX_CONNECTION_READ_BYTES));
          await new Promise<void>((r) => (gate.release = r));
          c.close();
        },
      }),
    );
    const done = readCappedBytes(response, MAX_CONNECTION_READ_BYTES, connectionId);
    return { done, release: () => gate.release?.() };
  }

  // Lets a matching interception see its request without a CDP client answering it.
  function continueParked(connectionId: string) {
    const state = ensureInterception(connectionId);
    const timer = setInterval(() => {
      for (const parked of state.parked.values()) parked.verdict ??= { kind: "continue" };
    }, 1);
    return () => clearInterval(timer);
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

  it("refetches after a budget refusal instead of caching it", async () => {
    const h = harness();
    const held = holdReadBudget(h.connectionId);
    await new Promise((r) => setTimeout(r, 0));
    try {
      await h.enable();
      expect(h.texts()).toEqual([""]);
    } finally {
      held.release();
      await held.done;
    }
    await h.enable();
    expect(h.seen).toEqual([SHEET, SHEET]);
    expect(h.texts()).toEqual(["p{}"]);
  });

  it("keeps previously fetched text when a refetch fails", async () => {
    const state = { ok: true };
    const h = harness({
      respond: () => (state.ok ? css("p{}") : new Response(null, { status: 404 })),
    });
    ensureInterception(h.connectionId).patterns = [{ pattern: "*cdn.test*" }];
    const stop = continueParked(h.connectionId);
    try {
      await h.enable();
      expect(h.texts()).toEqual(["p{}"]);
      state.ok = false;
      await h.enable();
      expect(h.seen).toEqual([SHEET, SHEET]);
      expect(h.texts()).toEqual(["p{}"]);
    } finally {
      stop();
      unregisterInterception(h.connectionId);
    }
  });

  it("keeps previously fetched text when a cached failure is replayed", async () => {
    const state = { fail: false };
    const h = harness({
      respond: (url) =>
        state.fail && url === SHEET ? new Response(null, { status: 404 }) : css("p{}"),
    });
    await h.enable();
    expect(h.texts()).toEqual(["p{}"]);
    // The module cache keeps 32 entries, so 36 newer sheets push this one out while the
    // styleSheets entry keeps its text.
    for (let round = 0; round < 3; round++) {
      h.setSheets([
        { ownerNodeId: 2, text: "p{}", sourceURL: SHEET, cors: "clean" },
        ...Array.from({ length: 12 }, (_, i) => ({
          ownerNodeId: 100 + round * 12 + i,
          text: "",
          sourceURL: `https://cdn.test/f${round}-${i}.css`,
          cors: "opaque" as const,
        })),
      ]);
      await h.enable();
    }
    state.fail = true;
    h.setSheets([{ ownerNodeId: 2, text: "", sourceURL: SHEET, cors: "opaque" }]);
    await h.enable(); // cache miss, the fetch fails: text is kept
    expect(h.texts()).toEqual(["p{}"]);
    h.events.length = 0;
    await h.enable(); // the cached failure must not erase it
    expect(h.texts()).toEqual(["p{}"]);
    expect(h.events).not.toContain("CSS.styleSheetChanged");
  });

  it("caches a policy refusal for the failure ttl", async () => {
    const h = harness();
    await h.enable();
    registerOutboundFilters(h.connectionId, { rejectPatterns: [/a\.css$/] });
    await h.enable();
    expect(h.texts()).toEqual([""]);
    expect(h.attempts).toEqual([SHEET, SHEET]);
    await h.enable();
    expect(h.attempts).toEqual([SHEET, SHEET]);
    expect(h.seen).toEqual([SHEET]);
  });

  it("refetches a cached policy refusal once the filter is removed", async () => {
    const h = harness();
    await h.enable();
    expect(h.texts()).toEqual(["p{}"]);
    registerOutboundFilters(h.connectionId, { rejectPatterns: [/a\.css$/] });
    await h.enable();
    expect(h.texts()).toEqual([""]);
    expect(h.seen).toEqual([SHEET]);
    registerOutboundFilters(h.connectionId, {});
    await h.enable();
    expect(h.texts()).toEqual(["p{}"]);
    expect(h.seen).toEqual([SHEET, SHEET]);
  });

  it("still attempts a refused sheet under a matching interception", async () => {
    const h = harness();
    ensureInterception(h.connectionId).patterns = [{ pattern: "*cdn.test*" }];
    registerOutboundFilters(h.connectionId, { rejectPatterns: [/a\.css$/] });
    try {
      await h.enable();
      await h.enable();
      expect(h.attempts).toEqual([SHEET, SHEET]);
      expect(h.seen).toEqual([]);
    } finally {
      unregisterInterception(h.connectionId);
    }
  });

  it("counts CR line endings in the stylesheet header", async () => {
    const h = harness({ sheets: [{ ownerNodeId: 2, text: "a{}\rb{}", sourceURL: "" }] });
    await h.enable();
    expect(h.headers.map(({ endLine, endColumn }) => [endLine, endColumn])).toEqual([[1, 3]]);
  });

  it.each([
    ["CRLF", "a{}\r\nb{}", [1, 3]],
    ["FF", "a{}\fb{}", [1, 3]],
    ["mixed", "a{}\r\nb\rc\fd{}", [3, 3]],
    ["no break", "a{}b{}", [0, 6]],
  ])("reports the header end position for %s", async (_, text, expected) => {
    const h = harness({ sheets: [{ ownerNodeId: 2, text, sourceURL: "" }] });
    await h.enable();
    expect(h.headers.map(({ endLine, endColumn }) => [endLine, endColumn])).toEqual([expected]);
  });

  it("refreshes opaqueText when the same text flips to opaque", async () => {
    const h = harness({ sheets: [{ ownerNodeId: 2, text: "p{}", sourceURL: "" }] });
    await h.enable();
    expect(h.entries()[0]?.opaqueText).toBe(false);
    h.setSheets([{ ownerNodeId: 2, text: "p{}", sourceURL: "", cors: "opaque" }]);
    await h.enable();
    expect(h.entries()[0]?.opaqueText).toBe(true);
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
  type TestRule = {
    selector_text: string;
    declarations: Array<{ name: string; value: string }>;
  };

  async function matchedRules(rules: TestRule[], matches: number[], ancestors: number) {
    const replies: StubReplies = {
      parseStyleSheet: { sheet: { rules } } as QueryDomResult<"parseStyleSheet">,
      matchSelectorList: { matches },
      getAncestorElementIds: { ancestorIds: Array.from({ length: ancestors }, (_, i) => i + 1) },
    };
    const calls = countCalls(replies, "matchSelectorList");
    const target = makeTarget(makeStub(replies));
    target.styleSheets.set("s", {
      ownerNodeId: 2,
      rev: 1,
      text: rules.map((r) => `${r.selector_text}{color:red}`).join("\n"),
      isInline: true,
      sourceURL: "",
      origin: "regular",
      parsed: null,
    });
    const result = (await handleCss(makeCtx(target), {
      id: 1,
      method: "CSS.getMatchedStylesForNode",
      params: { nodeId: 5 },
      sessionId: "s1",
    } as CdpRequest)) as CdpResultOf<"CSS.getMatchedStylesForNode">;
    return { result, calls: calls(), parsed: target.styleSheets.get("s")?.parsed };
  }

  async function matched(
    selector: string,
    count: number,
    ancestors: number,
    matches: number[] = [0],
    declarations: Array<{ name: string; value: string }> = [{ name: "color", value: "red" }],
  ) {
    const rule = { selector_text: selector, declarations };
    const { result } = await matchedRules(
      Array.from({ length: count }, () => rule),
      matches,
      ancestors,
    );
    return result;
  }

  it("bounds a large inherited reply", async () => {
    const r = await matched(Array.from({ length: 2048 }, () => "*").join(","), 1, 128);
    expect(r.matchedCSSRules?.length).toBe(1);
    expect(r.inherited?.some((e) => e.matchedCSSRules.length > 0)).toBe(true);
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  it("keeps every match of a large ordinary sheet", async () => {
    const declarations = [
      { name: "color", value: "red" },
      { name: "margin", value: "0" },
      { name: "padding", value: "0" },
      { name: "display", value: "block" },
      { name: "position", value: "relative" },
    ];
    expect(
      (await matched(".row > .col, .card-body", 3000, 0, [0], declarations)).matchedCSSRules
        ?.length,
    ).toBe(3000);
  });

  it("does not warn about a non-matching huge selector", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await matched("a".repeat(1_000_000), 1, 0, []);
      expect(r.matchedCSSRules).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("caps the parsed rules kept from one sheet", async () => {
    const rule = { selector_text: "a", declarations: [{ name: "color", value: "red" }] };
    const { calls, parsed } = await matchedRules(
      Array.from({ length: MAX_PARSED_RULES_PER_SHEET + 100 }, () => rule),
      [],
      0,
    );
    expect(parsed?.rules.length).toBe(MAX_PARSED_RULES_PER_SHEET);
    expect(calls).toBeLessThanOrEqual(MAX_PARSED_RULES_PER_SHEET);
  });

  it("caps the declarations kept from one sheet", async () => {
    const declarations = Array.from({ length: 200_000 }, (_, i) => ({
      name: `--p${i}`,
      value: "1",
    }));
    const { parsed } = await matchedRules([{ selector_text: "a", declarations }], [], 0);
    const kept = parsed?.rules.reduce((n, r) => n + r.declarations.length, 0) ?? 0;
    expect(kept).toBe(MAX_PARSED_DECLARATIONS_PER_SHEET);
  });

  it("warns about a capped parse once per sheet", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rule = { selector_text: "a", declarations: [{ name: "color", value: "red" }] };
      const rules = Array.from({ length: MAX_PARSED_RULES_PER_SHEET + 1 }, () => rule);
      const stub = makeStub({
        parseStyleSheet: { sheet: { rules } } as QueryDomResult<"parseStyleSheet">,
        matchSelectorList: { matches: [] } as QueryDomResult<"matchSelectorList">,
      });
      const target = makeTarget(stub);
      for (const [id, ownerNodeId] of [
        ["a", 2],
        ["b", 3],
      ] as const) {
        target.styleSheets.set(id, {
          ownerNodeId,
          rev: 1,
          text: "a{color:red}",
          isInline: true,
          sourceURL: "",
          origin: "regular",
          parsed: null,
        });
      }
      await handleCss(makeCtx(target), {
        id: 1,
        method: "CSS.getMatchedStylesForNode",
        params: { nodeId: 5 },
        sessionId: "s1",
      } as CdpRequest);
      const capped = warn.mock.calls.filter(([message]) =>
        String(message).includes(`more than ${MAX_PARSED_RULES_PER_SHEET} rules`),
      );
      expect(capped).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("skips a sparse match list before copying it", async () => {
    // A reply array of length 8M with one real index costs ~100 ms per rule to iterate, so the
    // budget must refuse it from the length alone instead of copying first.
    const matches: number[] = new Array(8_000_000);
    matches[0] = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const start = performance.now();
    try {
      const { result } = await matchedRules(
        [{ selector_text: "a", declarations: [{ name: "color", value: "red" }] }],
        matches,
        0,
      );
      expect(result.matchedCSSRules).toEqual([]);
    } finally {
      warn.mockRestore();
    }
    expect(performance.now() - start).toBeLessThan(250);
  });

  it("stops issuing selector matches once no match can fit", async () => {
    const big = "a".repeat(698_979);
    const { result, calls } = await matchedRules(
      [
        { selector_text: big, declarations: [{ name: "color", value: "red" }] },
        { selector_text: "b", declarations: [{ name: "color", value: "red" }] },
      ],
      [0],
      0,
    );
    expect(result.matchedCSSRules?.length).toBe(1);
    expect(calls).toBe(1);
  });
});
