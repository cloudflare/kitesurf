// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";

import { facetPageScriptHost, type PageFacets } from "../src/eval/page-script-host.ts";

function fakes() {
  const calls: string[] = [];
  const classes: Array<{ name: string | undefined; options: unknown }> = [];
  const facets: PageFacets = {
    get<T extends Rpc.DurableObjectBranded | undefined = undefined>(
      name: string,
      startup: () => FacetStartupOptions<T> | Promise<FacetStartupOptions<T>>,
    ): Fetcher<T> {
      calls.push(`get ${name}`);
      void startup();
      // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- a stub with one method.
      return { openSession: async () => ({ name }) } as unknown as Fetcher<T>;
    },
    abort: (name) => calls.push(`abort ${name}`),
    delete: (name) => calls.push(`delete ${name}`),
  };
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only the method the host uses.
  const worker = {
    getDurableObjectClass: (name?: string, options?: unknown) => {
      classes.push({ name, options });
      return {};
    },
  } as unknown as WorkerStub;
  return { calls, classes, facets, worker };
}

const options = { props: { KS_TAIL_TOKEN: "t" }, limits: { cpuMs: 1 } };

describe("facetPageScriptHost", () => {
  it("loads each page's facet from the loaded worker's PageScriptFacet class", () => {
    const { classes, facets, worker } = fakes();
    facetPageScriptHost(facets).entrypoint("page-1", worker, options);
    expect(classes).toEqual([{ name: "PageScriptFacet", options }]);
  });

  it("aborts the running generation before it starts the next one", () => {
    const { calls, facets, worker } = fakes();
    const host = facetPageScriptHost(facets);
    host.entrypoint("page-1", worker, options);
    host.entrypoint("page-1", worker, options);
    expect(calls).toEqual(["get page-1", "abort page-1", "get page-1"]);
  });

  it("ignores the kill of a generation that a newer one replaced", async () => {
    const { calls, facets, worker } = fakes();
    const host = facetPageScriptHost(facets);
    const old = host.entrypoint("page-1", worker, options);
    host.entrypoint("page-1", worker, options);
    calls.length = 0;
    await old.killIsolate?.("late");
    expect(calls).toEqual([]);
  });

  it("aborts the current generation on its kill and keeps the page's storage", async () => {
    const { calls, facets, worker } = fakes();
    const host = facetPageScriptHost(facets);
    const current = host.entrypoint("page-1", worker, options);
    calls.length = 0;
    await current.killIsolate?.("navigate");
    expect(calls).toEqual(["abort page-1"]);
  });

  it("deletes a closed page's facet, and every page's facet when the session ends", () => {
    const { calls, facets, worker } = fakes();
    const host = facetPageScriptHost(facets);
    host.entrypoint("page-1", worker, options);
    host.entrypoint("page-2", worker, options);
    calls.length = 0;
    host.deletePage("page-1");
    expect(calls).toEqual(["abort page-1", "delete page-1"]);
    calls.length = 0;
    host.retireAll("session ended");
    expect(calls).toEqual(["abort page-2", "delete page-2"]);
    calls.length = 0;
    host.deletePage("page-1");
    expect(calls).toEqual([]);
  });
});
