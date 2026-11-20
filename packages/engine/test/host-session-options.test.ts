// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";

import { resolveConnectionOptions } from "../src/host.ts";

describe("resolveConnectionOptions", () => {
  it("uses generic defaults based on the WebSocket path", () => {
    expect(
      resolveConnectionOptions(
        new Request("https://kitesurf.invalid/devtools/page/kitesurf"),
        "connection-1",
      ),
    ).toEqual({ entrypoint: "devtools", fontDefer: false, fontProfile: "noto" });
    expect(
      resolveConnectionOptions(
        new Request("https://kitesurf.invalid/devtools/browser"),
        "connection-2",
      ),
    ).toEqual({ entrypoint: "puppeteer", fontDefer: false, fontProfile: "noto" });
  });

  it("ignores internal session headers on the public default host", () => {
    const request = new Request("https://kitesurf.invalid/devtools/browser", {
      headers: {
        "x-kitesurf-entrypoint": "html",
        "x-kitesurf-font-defer": "1",
      },
    });

    expect(resolveConnectionOptions(request, "connection-3")).toEqual({
      entrypoint: "puppeteer",
      fontDefer: false,
      fontProfile: "noto",
    });
  });

  it("uses host-owned entrypoint and font options", () => {
    const request = new Request("https://kitesurf.invalid/devtools/page/kitesurf");

    let receivedRequest: Request | undefined;
    let receivedConnectionId: string | undefined;
    expect(
      resolveConnectionOptions(request, "connection-4", {
        connectionOptions: (received, connectionId) => {
          receivedRequest = received;
          receivedConnectionId = connectionId;
          return { entrypoint: "host-action", fontDefer: true };
        },
      }),
    ).toEqual({ entrypoint: "host-action", fontDefer: true, fontProfile: "noto" });
    expect(receivedRequest).toBe(request);
    expect(receivedConnectionId).toBe("connection-4");
  });

  it("keeps the generic entrypoint when the host only supplies font options", () => {
    const request = new Request("https://kitesurf.invalid/devtools/page/kitesurf");

    expect(
      resolveConnectionOptions(request, "connection-5", {
        connectionOptions: () => ({ fontDefer: true }),
      }),
    ).toEqual({ entrypoint: "devtools", fontDefer: true, fontProfile: "noto" });
  });

  it("resolves the font profile from the host, then the query, then the env var", () => {
    const request = new Request("https://kitesurf.invalid/devtools/browser?ks_font_profile=macos");
    const env = { KITESURF_FONT_PROFILE: "noto" };

    expect(resolveConnectionOptions(request, "connection-6", undefined, env).fontProfile).toBe(
      "macos",
    );
    expect(
      resolveConnectionOptions(
        new Request("https://kitesurf.invalid/devtools/browser"),
        "connection-7",
        undefined,
        { KITESURF_FONT_PROFILE: "macos" },
      ).fontProfile,
    ).toBe("macos");
    expect(
      resolveConnectionOptions(
        request,
        "connection-8",
        { connectionOptions: () => ({ fontProfile: "noto" }) },
        env,
      ).fontProfile,
    ).toBe("noto");
  });
});
