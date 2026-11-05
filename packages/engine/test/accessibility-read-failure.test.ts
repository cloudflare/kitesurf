// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, it, expect } from "vitest";

import { buildTree, handleAccessibility } from "../src/cdp/accessibility.ts";
import type { DispatchCtx } from "../src/cdp/dispatch.ts";
import type { TargetState } from "../src/cdp/types.ts";
import type { PageScriptStub } from "../src/eval/page-script.ts";
import type { QueryDomArgs, QueryDomMethod, QueryDomResult } from "@kitesurf/jsrpc-types/query-dom";

describe("document read failure", () => {
  it("rejects a full-tree request when PageScript cannot read the document", async () => {
    const stub = {
      async queryDom<M extends QueryDomMethod>(
        _method: M,
        _args: QueryDomArgs<M>,
      ): Promise<QueryDomResult<M>> {
        throw new Error("Worker exceeded memory limit");
      },
    };
    const target = {
      type: "page",
      sessions: new Set<string>(),
      pageScript: stub as PageScriptStub,
      blankReady: null,
      frameId: "F",
      url: "",
      title: "",
    } as TargetState;
    const ctx = { browser: { targets: new Map([["t", target]]) } } as DispatchCtx;
    await expect(
      handleAccessibility(ctx, { id: 1, method: "Accessibility.getFullAXTree" }),
    ).rejects.toThrow("Worker exceeded memory limit");
  });

  it("buildTree reports the engine DOM budget error instead of an empty tree", async () => {
    const target = {
      type: "page",
      sessions: new Set<string>(),
      pageScript: null,
      blankReady: null,
      frameId: "F",
      url: "",
    } as TargetState;
    const engineDom = {
      documentBudgetError: () => ({
        nodes: 12,
        atLeastBytes: 40_000_000,
        nodesAtLeast: false,
        budget: 33_550_336,
      }),
    };
    // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- partial DomHandle fixture.
    target.dom = engineDom as unknown as TargetState["dom"];
    await expect(buildTree(null, target)).rejects.toThrow(
      /Accessibility\.getFullAXTree.*12 nodes.*40000000 bytes.*33550336 bytes/,
    );
  });
});
