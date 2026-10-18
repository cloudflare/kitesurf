// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";

import { attributionTails, type AttributionTailProps } from "../src/eval/attribution-tail.ts";

describe("attributionTails", () => {
  const headers = { "x-run": "r1" };
  // Identity-only sentinel; attributionTails never invokes this platform binding.
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- identity-only Fetcher sentinel.
  const tail = { fetch: () => {} } as unknown as Fetcher;
  const seen: AttributionTailProps[] = [];
  const exports = {
    AttributionTail(opts: { props: AttributionTailProps }) {
      seen.push(opts.props);
      return tail;
    },
  };

  it("adds no tail when the entry has no AttributionTail export", () => {
    expect(attributionTails({}, headers, "page")).toEqual({});
  });

  it("adds no tail for a session without attribution headers", () => {
    expect(attributionTails(exports, {}, "page")).toEqual({});
  });

  it("passes the headers and script name as tail props", () => {
    expect(attributionTails(exports, headers, "page")).toEqual({ tails: [tail] });
    expect(seen).toEqual([{ headers, scriptName: "page" }]);
  });
});
