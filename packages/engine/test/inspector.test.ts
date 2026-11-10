// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import {
  absoluteInspectorBaseUrl,
  inspectorBaseUrlOrNull,
  inspectorTargetUrl,
} from "../src/inspector.ts";

describe("inspectorBaseUrlOrNull", () => {
  it("disables the inspector when the variable is unset or not a string", () => {
    expect(inspectorBaseUrlOrNull({})).toBeNull();
    expect(inspectorBaseUrlOrNull({ KITESURF_INSPECTOR_BASE_URL: 123 })).toBeNull();
  });

  it("disables the inspector for an empty or blank value", () => {
    expect(inspectorBaseUrlOrNull({ KITESURF_INSPECTOR_BASE_URL: "" })).toBeNull();
    expect(inspectorBaseUrlOrNull({ KITESURF_INSPECTOR_BASE_URL: "  " })).toBeNull();
  });

  it("returns a configured value trimmed", () => {
    expect(
      inspectorBaseUrlOrNull({ KITESURF_INSPECTOR_BASE_URL: " https://example.com/ui " }),
    ).toBe("https://example.com/ui");
  });
});

describe("absoluteInspectorBaseUrl", () => {
  const origin = "https://ks.invalid";

  it("resolves a path-only base against the request origin", () => {
    expect(absoluteInspectorBaseUrl("/inspector/inspector.html", origin)).toBe(
      "https://ks.invalid/inspector/inspector.html",
    );
    expect(absoluteInspectorBaseUrl("/inspector/inspector.html", "http://localhost:8787")).toBe(
      "http://localhost:8787/inspector/inspector.html",
    );
  });

  it("keeps a trailing slash for the caller to trim", () => {
    expect(absoluteInspectorBaseUrl("/inspector/", origin)).toBe("https://ks.invalid/inspector/");
  });

  it("leaves an absolute URL unchanged", () => {
    for (const base of [
      "https://example.com/devtools",
      "https://example.com/devtools/",
      "devtools://devtools/bundled/inspector.html",
    ]) {
      expect(absoluteInspectorBaseUrl(base, origin)).toBe(base);
    }
  });
});

describe("inspectorTargetUrl", () => {
  it("points a same-origin frontend at the page target over wss or ws", () => {
    expect(
      inspectorTargetUrl("/inspector/inspector.html", {
        url: new URL("https://ks.invalid/"),
        host: "ks.invalid",
      }),
    ).toBe(
      "https://ks.invalid/inspector/inspector.html?wss=ks.invalid%2Fdevtools%2Fpage%2Fkitesurf",
    );
    expect(
      inspectorTargetUrl("/inspector/inspector.html", {
        url: new URL("http://localhost:8787/"),
        host: "localhost:8787",
      }),
    ).toBe(
      "http://localhost:8787/inspector/inspector.html?ws=localhost%3A8787%2Fdevtools%2Fpage%2Fkitesurf",
    );
  });

  it("carries initialUrl inside the WebSocket endpoint", () => {
    const target = new URL(
      inspectorTargetUrl("https://example.com/devtools/", {
        url: new URL("https://ks.invalid/"),
        host: "ks.invalid",
        initialUrl: "https://example.com/?a=1&b=2",
      }),
    );
    expect(target.origin + target.pathname).toBe("https://example.com/devtools");
    expect(target.searchParams.get("wss")).toBe(
      "ks.invalid/devtools/page/kitesurf?initialUrl=" +
        encodeURIComponent("https://example.com/?a=1&b=2"),
    );
  });
});
