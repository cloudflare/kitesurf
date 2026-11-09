// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, it, expect } from "vitest";
import { buildForwardRequest } from "../src/eval/outbound.ts";

const PAGE_ORIGIN = "https://app.internal.example";
const AUTH = "Basic dXNlcjpwYXNz";

function forward(url: string, extraHeaders: Record<string, string>, pageOrigin = PAGE_ORIGIN) {
  return buildForwardRequest({
    original: new Request(url),
    resourceType: "Script",
    pageOrigin,
    extraHeaders,
  });
}

describe("Authorization same-origin gate", () => {
  it("sends Authorization on same-origin requests", () => {
    const req = forward(`${PAGE_ORIGIN}/api/data`, { Authorization: AUTH });
    expect(req.headers.get("authorization")).toBe(AUTH);
  });

  it("strips Authorization on cross-origin requests", () => {
    const req = forward("https://cdn.example.com/lib.js", { Authorization: AUTH });
    expect(req.headers.get("authorization")).toBeNull();
  });

  it("treats a different port as cross-origin", () => {
    const req = forward(`${PAGE_ORIGIN}:8443/api`, { Authorization: AUTH });
    expect(req.headers.get("authorization")).toBeNull();
  });

  it("treats scheme downgrade as cross-origin", () => {
    const req = forward("http://app.internal.example/api", { Authorization: AUTH });
    expect(req.headers.get("authorization")).toBeNull();
  });

  it("gate is case-insensitive on the header name", () => {
    const req = forward("https://cdn.example.com/x.js", { authorization: AUTH });
    expect(req.headers.get("authorization")).toBeNull();
  });

  it("strips Authorization when pageOrigin is empty (can't prove same-origin)", () => {
    const req = forward("https://anywhere.example/x.js", { Authorization: AUTH }, "");
    expect(req.headers.get("authorization")).toBeNull();
  });

  it("non-credential extra headers keep all-requests semantics cross-origin", () => {
    const req = forward("https://cdn.example.com/lib.js", {
      Authorization: AUTH,
      "X-Custom-Header": "ride-everywhere",
    });
    expect(req.headers.get("x-custom-header")).toBe("ride-everywhere");
    expect(req.headers.get("authorization")).toBeNull();
  });
});

describe("header shaping basics", () => {
  it("strips x-kitesurf-* plumbing headers", () => {
    const original = new Request("https://cdn.example.com/x.js", {
      headers: { "x-kitesurf-resource-type": "Script", "x-real": "keep" },
    });
    const req = buildForwardRequest({
      original,
      resourceType: "Script",
      pageOrigin: PAGE_ORIGIN,
      extraHeaders: {},
    });
    expect(req.headers.get("x-kitesurf-resource-type")).toBeNull();
    expect(req.headers.get("x-real")).toBe("keep");
  });

  it("injects browser-shaped defaults without clobbering explicit values", () => {
    const original = new Request("https://cdn.example.com/x.js", {
      headers: { "user-agent": "custom-ua" },
    });
    const req = buildForwardRequest({
      original,
      resourceType: "Script",
      pageOrigin: PAGE_ORIGIN,
      extraHeaders: {},
    });
    expect(req.headers.get("user-agent")).toBe("custom-ua");
    expect(req.headers.get("referer")).toBe(`${PAGE_ORIGIN}/`);
    expect(req.headers.get("accept")).toBeTruthy();
  });

  it("extra headers override defaults (Chrome setExtraHTTPHeaders semantics)", () => {
    const req = forward("https://cdn.example.com/x.js", {
      Referer: "https://forced.example/",
    });
    expect(req.headers.get("referer")).toBe("https://forced.example/");
  });
});

describe("Accept-Encoding", () => {
  it("offers exactly the codings workerd decodes", () => {
    const req = forward("https://cdn.example.com/x.js", {});
    expect(req.headers.get("accept-encoding")).toBe("gzip, br");
  });

  it("replaces Chrome's header copied through setExtraHTTPHeaders", () => {
    const req = forward("https://cdn.example.com/x.js", {
      "Accept-Encoding": "gzip, deflate, br, zstd",
    });
    expect(req.headers.get("accept-encoding")).toBe("gzip, br");
  });

  it("keeps a client value that only accepts decodable codings", () => {
    for (const value of ["identity", "gzip", "br;q=1.0, gzip;q=0.5", "gzip, zstd;q=0"]) {
      const req = forward("https://cdn.example.com/x.js", { "Accept-Encoding": value });
      expect(req.headers.get("accept-encoding")).toBe(value);
    }
  });

  it("asks a Range request for identity", () => {
    const original = new Request("https://cdn.example.com/v.mp4", {
      headers: { range: "bytes=0-1023" },
    });
    const req = buildForwardRequest({
      original,
      resourceType: "Media",
      pageOrigin: PAGE_ORIGIN,
      extraHeaders: {},
    });
    expect(req.headers.get("accept-encoding")).toBe("identity");
  });

  it("replaces a wildcard, which would accept anything", () => {
    const req = forward("https://cdn.example.com/x.js", { "Accept-Encoding": "*" });
    expect(req.headers.get("accept-encoding")).toBe("gzip, br");
  });
});

// The document default follows the whole Referrer Policy table, which
// page-script also uses for frame documents' document.referrer.
describe("document Referrer-Policy", () => {
  const PAGE_URL = `${PAGE_ORIGIN}/dir/page.html?q=1#frag`;
  const referer = (url: string, policy?: string, pageUrl = PAGE_URL) =>
    buildForwardRequest({
      original: new Request(url),
      resourceType: "Script",
      pageOrigin: PAGE_ORIGIN,
      extraHeaders: {},
      pageUrl,
      referrerPolicy: policy,
    }).headers.get("referer");

  it("sends the full URL same-origin and the origin cross-origin by default", () => {
    expect(referer(`${PAGE_ORIGIN}/x.js`)).toBe(`${PAGE_ORIGIN}/dir/page.html?q=1`);
    expect(referer("https://cdn.example.com/x.js")).toBe(`${PAGE_ORIGIN}/`);
  });

  it("sends the origin only under strict-origin, even same-origin", () => {
    expect(referer(`${PAGE_ORIGIN}/x.js`, "strict-origin")).toBe(`${PAGE_ORIGIN}/`);
  });

  it("sends nothing cross-origin under same-origin", () => {
    expect(referer("https://cdn.example.com/x.js", "same-origin")).toBeNull();
  });

  it("drops the Referer on an https to http downgrade", () => {
    expect(referer("http://cdn.example.com/x.js")).toBeNull();
  });

  it("takes the last recognised token of a policy list", () => {
    expect(referer(`${PAGE_ORIGIN}/x.js`, "unsafe-url, origin")).toBe(`${PAGE_ORIGIN}/`);
  });

  it("falls back to the origin when pageUrl is another origin", () => {
    expect(referer(`${PAGE_ORIGIN}/x.js`, "", "https://other.example/p")).toBe(`${PAGE_ORIGIN}/`);
  });
});

// Origin on cors-mode hops: the gateway demands an ACAO echo on
// exactly these, so it has to send the value there is to echo.
describe("Origin stamping", () => {
  const cors = (url: string, original = new Request(url), pageOrigin = PAGE_ORIGIN) =>
    buildForwardRequest({
      original,
      resourceType: "Font",
      pageOrigin,
      extraHeaders: {},
      wbaHeaders: {},
      corsMode: true,
    });

  it("stamps the page origin on a cors-mode hop", () => {
    expect(cors("https://cdn.example.com/f.woff2").headers.get("origin")).toBe(PAGE_ORIGIN);
  });

  it("leaves Origin off a non-cors hop, as today", () => {
    const req = buildForwardRequest({
      original: new Request("https://cdn.example.com/f.woff2"),
      resourceType: "Font",
      pageOrigin: PAGE_ORIGIN,
      extraHeaders: {},
    });
    expect(req.headers.get("origin")).toBeNull();
  });

  it("overwrites a page-supplied Origin — the shim's value is page-settable", () => {
    const original = new Request("https://cdn.example.com/f.woff2", {
      headers: { origin: "https://forged.example" },
    });
    expect(cors("https://cdn.example.com/f.woff2", original).headers.get("origin")).toBe(
      PAGE_ORIGIN,
    );
  });

  it("an opaque page origin still stamps null, not the empty string", () => {
    expect(cors("https://cdn.example.com/f.woff2", undefined, "").headers.get("origin")).toBe(
      "null",
    );
  });

  it("an opaque origin OVERWRITES a forged Origin too", () => {
    const original = new Request("https://cdn.example.com/f.woff2", {
      headers: { origin: "https://forged.example" },
    });
    expect(cors("https://cdn.example.com/f.woff2", original, "").headers.get("origin")).toBe(
      "null",
    );
  });
});

describe("UA override via extras channel", () => {
  const OVERRIDE = "KitesurfOverride/1.0";

  it("replaces the injected browser-shaped UA default", () => {
    const req = forward("https://cdn.example.com/x.js", {
      "user-agent": OVERRIDE,
    });
    expect(req.headers.get("user-agent")).toBe(OVERRIDE);
  });

  it("beats a caller-supplied UA (Chrome: the CDP override wins)", () => {
    const original = new Request("https://cdn.example.com/x.js", {
      headers: { "user-agent": "page-author-ua" },
    });
    const req = buildForwardRequest({
      original,
      resourceType: "Script",
      pageOrigin: PAGE_ORIGIN,
      extraHeaders: {
        "user-agent": OVERRIDE,
      },
    });
    expect(req.headers.get("user-agent")).toBe(OVERRIDE);
  });

  it("rides cross-origin (not Authorization-gated)", () => {
    const req = forward("https://third-party.example/x.js", {
      "user-agent": OVERRIDE,
    });
    expect(req.headers.get("user-agent")).toBe(OVERRIDE);
  });

  it("last write wins when extras carry a mixed-case UA variant", () => {
    const req = forward("https://cdn.example.com/x.js", {
      "User-Agent": "FromExtras/1.0",
      "user-agent": OVERRIDE,
    });
    expect(req.headers.get("user-agent")).toBe(OVERRIDE);
  });
});

describe("Web Bot Auth header precedence", () => {
  const WBA = {
    signature: "sig1=:AAAA:",
    "signature-input": 'sig1=("@authority" "signature-agent");tag="web-bot-auth"',
    "signature-agent": '"https://wba.example"',
  };

  it("stamps all three headers on the forwarded request", () => {
    const req = buildForwardRequest({
      original: new Request("https://cdn.example.com/x.js"),
      resourceType: "Script",
      pageOrigin: PAGE_ORIGIN,
      extraHeaders: {},
      wbaHeaders: WBA,
    });
    expect(req.headers.get("signature")).toBe(WBA["signature"]);
    expect(req.headers.get("signature-input")).toBe(WBA["signature-input"]);
    expect(req.headers.get("signature-agent")).toBe(WBA["signature-agent"]);
  });

  it("overrides setExtraHTTPHeaders attempts to forge them", () => {
    const req = buildForwardRequest({
      original: new Request("https://cdn.example.com/x.js"),
      resourceType: "Script",
      pageOrigin: PAGE_ORIGIN,
      extraHeaders: {
        Signature: "sig1=:FORGED:",
        "Signature-Input": 'sig1=("@authority");tag="web-bot-auth"',
        "Signature-Agent": '"https://attacker.example"',
      },
      wbaHeaders: WBA,
    });
    expect(req.headers.get("signature")).toBe(WBA["signature"]);
    expect(req.headers.get("signature-agent")).toBe(WBA["signature-agent"]);
    expect(req.headers.get("signature-input")).toBe(WBA["signature-input"]);
  });

  it("overrides a page-author fetch() attempt to forge them", () => {
    const original = new Request("https://cdn.example.com/x.js", {
      headers: { signature: "sig1=:FORGED:", "signature-agent": '"https://evil"' },
    });
    const req = buildForwardRequest({
      original,
      resourceType: "Script",
      pageOrigin: PAGE_ORIGIN,
      extraHeaders: {},
      wbaHeaders: WBA,
    });
    expect(req.headers.get("signature")).toBe(WBA["signature"]);
    expect(req.headers.get("signature-agent")).toBe(WBA["signature-agent"]);
  });

  it("leaves caller headers untouched when signing is disabled", () => {
    const original = new Request("https://api.example.com/x", {
      headers: { signature: "app-level-hmac" },
    });
    const req = buildForwardRequest({
      original,
      resourceType: "Fetch",
      pageOrigin: PAGE_ORIGIN,
      extraHeaders: {},
    });
    expect(req.headers.get("signature")).toBe("app-level-hmac");
  });
});

describe("headers page script may not set", () => {
  const PAGE_SET = {
    Origin: "https://victim.example",
    Referer: "https://victim.example/account",
    Cookie: "sid=forged",
    "Sec-Fetch-Site": "same-origin",
    "Proxy-Authorization": "Basic Zm9yZ2Vk",
    "X-HTTP-Method-Override": "TRACE",
    "X-Requested-With": "XMLHttpRequest",
  };
  const forwardFromPage = (pageRealm: boolean) =>
    buildForwardRequest({
      original: new Request("https://api.example/data", { headers: PAGE_SET }),
      resourceType: "Fetch",
      pageOrigin: PAGE_ORIGIN,
      extraHeaders: {},
      pageRealm,
    });

  it("drops forbidden request headers that came from page script", () => {
    const req = forwardFromPage(true);
    expect(req.headers.get("origin")).toBeNull();
    expect(req.headers.get("referer")).not.toBe(PAGE_SET.Referer);
    expect(req.headers.get("cookie")).toBeNull();
    expect(req.headers.get("sec-fetch-site")).toBeNull();
    expect(req.headers.get("proxy-authorization")).toBeNull();
    expect(req.headers.get("x-http-method-override")).toBeNull();
    expect(req.headers.get("x-requested-with")).toBe("XMLHttpRequest");
  });

  it("keeps headers the engine set on its own requests", () => {
    const req = forwardFromPage(false);
    expect(req.headers.get("cookie")).toBe("sid=forged");
    expect(req.headers.get("referer")).toBe(PAGE_SET.Referer);
  });
});
