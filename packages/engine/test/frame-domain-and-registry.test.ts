// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";

import { domainAndRegistryOf } from "../src/cdp/frames";

describe("Page.Frame domainAndRegistry", () => {
  it.each([
    ["https://example.com/path", "example.com"],
    ["https://deep.sub.example.com/path", "example.com"],
    ["https://shop.example.co.uk/path", "example.co.uk"],
    ["https://co.uk/path", ""],
    ["http://localhost/path", ""],
    ["http://127.0.0.1/path", ""],
    ["http://[::1]/path", ""],
    ["about:blank", ""],
    ["data:text/html,hello", ""],
    ["not a url", ""],
  ])("maps %s to %s", (url, expected) => {
    expect(domainAndRegistryOf(url)).toBe(expected);
  });
});
