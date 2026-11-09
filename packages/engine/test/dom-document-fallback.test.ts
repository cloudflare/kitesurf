// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, it, expect } from "vitest";
import { handleDom } from "../src/cdp/dom.ts";
import { MAX_RETAINED_FALLBACK_HTML_CHARS, releaseFallbackHtml } from "../src/cdp/dom-release.ts";
import type { DispatchCtx } from "../src/cdp/dispatch.ts";
import type { TargetState } from "../src/cdp/types.ts";
import type { PageScriptStub } from "../src/eval/page-script.ts";
import type { QueryDomArgs, QueryDomMethod, QueryDomResult } from "@kitesurf/jsrpc-types/query-dom";

describe("DOM.getDocument before PageScript has a document", () => {
  it("returns an empty document instead of parsing the source HTML in the engine", async () => {
    const stub = {
      async queryDom<M extends QueryDomMethod>(
        _method: M,
        _args: QueryDomArgs<M>,
      ): Promise<QueryDomResult<M>> {
        throw new Error("PageScript: no document loaded");
      },
    };
    let engineParsed = false;
    const target = {
      type: "page",
      sessions: new Set(["s1"]),
      pageScript: stub as PageScriptStub,
      blankReady: null,
      frames: new Map(),
      domEnabledSessions: new Set<string>(),
      html: "<html><body><p>source</p></body></html>",
      get dom() {
        engineParsed = true;
        return null;
      },
    } as TargetState;
    const ctx = { browser: { targets: new Map([["t1", target]]) } } as DispatchCtx;

    const reply = await handleDom(ctx, { id: 1, method: "DOM.getDocument", sessionId: "s1" });

    expect(reply).toMatchObject({ root: { nodeName: "#document", childNodeCount: 0 } });
    expect(engineParsed).toBe(false);
  });
});

describe("fallback HTML retention", () => {
  it("keeps the source for small documents", () => {
    const target = {
      html: "x".repeat(MAX_RETAINED_FALLBACK_HTML_CHARS),
      fallbackHtmlReleased: false,
    } as TargetState;
    releaseFallbackHtml(target);
    expect(target.html).toHaveLength(MAX_RETAINED_FALLBACK_HTML_CHARS);
    expect(target.fallbackHtmlReleased).toBe(false);
  });

  it("drops the source for large documents once PageScript owns them", () => {
    const target = { html: "x".repeat(MAX_RETAINED_FALLBACK_HTML_CHARS + 1) } as TargetState;
    releaseFallbackHtml(target);
    expect(target.html).toBe("");
    expect(target.fallbackHtmlReleased).toBe(true);
  });

  it("does not report a released document as an empty one", async () => {
    const target = {
      type: "page",
      sessions: new Set(["s1"]),
      pageScript: null,
      blankReady: null,
      frames: new Map(),
      domEnabledSessions: new Set<string>(),
      dom: null,
      html: "x".repeat(MAX_RETAINED_FALLBACK_HTML_CHARS + 1),
      fallbackHtmlReleased: false,
    } as TargetState;
    releaseFallbackHtml(target);
    const ctx = { browser: { targets: new Map([["t1", target]]) } } as DispatchCtx;

    await expect(
      handleDom(ctx, { id: 1, method: "DOM.getDocument", sessionId: "s1" }),
    ).rejects.toThrow(/released after a PageScript failure/);
  });
});
