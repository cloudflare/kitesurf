// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveFontProfile } from "../src/cdp/font-profile.ts";

describe("resolveFontProfile", () => {
  afterEach(() => vi.restoreAllMocks());

  it("defaults to noto when no source is set", () => {
    expect(resolveFontProfile(undefined, null, undefined)).toBe("noto");
    // wrangler.jsonc ships the var as "".
    expect(resolveFontProfile(undefined, "", "")).toBe("noto");
  });

  it("uses the env var as the deployment default", () => {
    expect(resolveFontProfile(undefined, null, "macos")).toBe("macos");
  });

  it("lets the query override the env var and the host override both", () => {
    expect(resolveFontProfile(undefined, "noto", "macos")).toBe("noto");
    expect(resolveFontProfile(undefined, "macos", "noto")).toBe("macos");
    expect(resolveFontProfile("noto", "macos", "macos")).toBe("noto");
  });

  it("ignores unknown values with a warning and falls through", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveFontProfile("Noto", "macOS", "macos")).toBe("macos");
    expect(resolveFontProfile(undefined, "comic-sans", undefined)).toBe("noto");
    expect(resolveFontProfile(undefined, null, "helvetica")).toBe("noto");
    expect(warn).toHaveBeenCalledTimes(4);
  });
});
