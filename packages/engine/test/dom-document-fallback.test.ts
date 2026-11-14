// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, it, expect } from "vitest";
import { handleDom } from "../src/cdp/dom.ts";
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
