// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import { leadsWithDoctype, sourceDoctypeOf } from "../../page-script/src/source-scan.ts";

describe("sourceDoctypeOf", () => {
  it.each([
    ["<!doctype html><p>", "<!DOCTYPE html>", 15],
    [" \n<!-- a --><!----><!DOCTYPE html>", "<!DOCTYPE html>", 34],
    [
      '<!DOCTYPE html SYSTEM "about:legacy-compat">',
      '<!DOCTYPE html SYSTEM "about:legacy-compat">',
      44,
    ],
  ])("finds the doctype in %j", (html, markup, end) => {
    expect(sourceDoctypeOf(html)).toEqual({ markup, end });
    expect(leadsWithDoctype(html)).toBe(true);
  });

  it.each([["x<!doctype html>"], ["<!-- a --> b --><!doctype html>"], ["<!-- open"]])(
    "finds no doctype in %j",
    (html) => {
      expect(sourceDoctypeOf(html)).toBeNull();
      expect(leadsWithDoctype(html)).toBe(false);
    },
  );

  // A backtracking pattern takes about a second on this input and doubles with every two more
  // comments, so it fails here instead of hanging the run.
  it("scans empty comments without a doctype in linear time", () => {
    const html = "<!--" + "--><!--".repeat(28) + "x";
    const started = performance.now();
    expect(sourceDoctypeOf(html)).toBeNull();
    expect(leadsWithDoctype(html)).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
  });
});
