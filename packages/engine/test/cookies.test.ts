// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, it, expect } from "vitest";

import { createCookieJar, entryToCdp, setCdpCookie } from "../src/cookies.ts";
import { schemefulSite } from "../src/public-suffix.ts";

const HTTPS = "https://app.example.com/x";

describe("Domain attribute", () => {
  it("accepts a parent domain the setting host is within", () => {
    const jar = createCookieJar();
    const e = jar.setFromHeader(HTTPS, "sid=1; Domain=example.com");
    expect(e).not.toBeNull();
    expect(e!.host).toBe("example.com");
    expect(e!.hostOnly).toBe(false);
  });

  it("accepts a leading-dot Domain, canonicalized", () => {
    const jar = createCookieJar();
    const e = jar.setFromHeader(HTTPS, "sid=1; Domain=.example.com");
    expect(e!.host).toBe("example.com");
  });

  it("accepts Domain equal to the setting host", () => {
    const jar = createCookieJar();
    const e = jar.setFromHeader(HTTPS, "sid=1; Domain=app.example.com");
    expect(e!.host).toBe("app.example.com");
  });

  it("REJECTS a Domain the setting host is not within", () => {
    const jar = createCookieJar();
    expect(jar.setFromHeader(HTTPS, "sid=1; Domain=bank.example")).toBeNull();
    expect(jar.cookieHeaderForUrl("https://bank.example/")).toBeNull();
  });

  it("REJECTS a sibling domain that merely shares a suffix", () => {
    const jar = createCookieJar();
    expect(jar.setFromHeader("https://evil-example.com/x", "sid=1; Domain=example.com")).toBeNull();
  });

  it("REJECTS a suffix that is not a label boundary", () => {
    const jar = createCookieJar();
    expect(jar.setFromHeader(HTTPS, "sid=1; Domain=ample.com")).toBeNull();
  });

  it("REJECTS a bare public suffix", () => {
    const jar = createCookieJar();
    expect(jar.setFromHeader(HTTPS, "sid=1; Domain=com")).toBeNull();
    expect(jar.setFromHeader("https://a.foo.co.uk/x", "sid=1; Domain=co.uk")).toBeNull();
  });

  it("REJECTS any Domain on an IP host except the host itself", () => {
    const jar = createCookieJar();
    expect(jar.setFromHeader("http://1.2.3.4/x", "sid=1; Domain=3.4")).toBeNull();
    expect(jar.setFromHeader("http://1.2.3.4/x", "sid=1; Domain=1.2.3.4")).not.toBeNull();
  });

  it("allows a single-label host to claim itself (localhost dev)", () => {
    const jar = createCookieJar();
    const e = jar.setFromHeader("http://localhost/x", "sid=1; Domain=localhost");
    expect(e).not.toBeNull();
    expect(e!.host).toBe("localhost");
  });

  it("treats an empty Domain= as host-only", () => {
    const jar = createCookieJar();
    const e = jar.setFromHeader("https://example.com/x", "sid=1; Domain=");
    expect(e).not.toBeNull();
    expect(e!.hostOnly).toBe(true);
    expect(jar.cookieHeaderForUrl("https://app.example.com/")).toBeNull();
  });

  it("stores a self-claim on a public suffix as host-only", () => {
    const jar = createCookieJar();
    const e = jar.setFromHeader("https://co.uk/x", "sid=1; Domain=co.uk");
    expect(e).not.toBeNull();
    expect(e!.hostOnly).toBe(true);
    expect(jar.cookieHeaderForUrl("https://victim.co.uk/")).toBeNull();
    expect(jar.cookieHeaderForUrl("https://co.uk/")).toBe("sid=1");
  });
});

describe("Domain attribute on read", () => {
  it("sends a Domain cookie to a subdomain", () => {
    const jar = createCookieJar();
    jar.setFromHeader(HTTPS, "sid=1; Domain=example.com");
    expect(jar.cookieHeaderForUrl("https://app.example.com/")).toBe("sid=1");
    expect(jar.cookieHeaderForUrl("https://other.example.com/")).toBe("sid=1");
    expect(jar.cookieHeaderForUrl("https://example.com/")).toBe("sid=1");
  });

  it("does NOT send a Domain cookie to a sibling registrable domain", () => {
    const jar = createCookieJar();
    jar.setFromHeader(HTTPS, "sid=1; Domain=example.com");
    expect(jar.cookieHeaderForUrl("https://example.org/")).toBeNull();
    expect(jar.cookieHeaderForUrl("https://notexample.com/")).toBeNull();
  });

  it("keeps a host-only cookie on its exact host", () => {
    const jar = createCookieJar();
    jar.setFromHeader(HTTPS, "sid=1");
    expect(jar.cookieHeaderForUrl("https://app.example.com/")).toBe("sid=1");
    expect(jar.cookieHeaderForUrl("https://example.com/")).toBeNull();
    expect(jar.cookieHeaderForUrl("https://deep.app.example.com/")).toBeNull();
  });

  it("host-only and Domain cookies of one name coexist", () => {
    const jar = createCookieJar();
    jar.setFromHeader(HTTPS, "sid=hostonly");
    jar.setFromHeader(HTTPS, "sid=domain; Domain=example.com");
    const hdr = jar.cookieHeaderForUrl("https://app.example.com/");
    expect(hdr).toContain("sid=hostonly");
    expect(hdr).toContain("sid=domain");
  });
});

describe("HttpOnly", () => {
  it("is withheld from document.cookie reads", () => {
    const jar = createCookieJar();
    jar.setFromHeader(HTTPS, "sid=secret; HttpOnly");
    jar.setFromHeader(HTTPS, "vis=ible");
    expect(jar.documentCookieString(HTTPS)).toBe("vis=ible");
  });

  it("still rides the Cookie header to the origin", () => {
    const jar = createCookieJar();
    jar.setFromHeader(HTTPS, "sid=secret; HttpOnly");
    expect(jar.cookieHeaderForUrl(HTTPS)).toBe("sid=secret");
  });

  it("is still reported to a CDP client", () => {
    const jar = createCookieJar();
    jar.setFromHeader(HTTPS, "sid=secret; HttpOnly");
    expect(jar.getAll().map((c) => c.name)).toEqual(["sid"]);
  });

  it("cannot be set from document.cookie", () => {
    const jar = createCookieJar();
    const e = jar.setFromDocumentCookie(HTTPS, "sid=1; HttpOnly");
    expect(e).not.toBeNull();
    expect(e!.httpOnly).toBe(false);
    expect(jar.documentCookieString(HTTPS)).toBe("sid=1");
  });

  it("cannot be overwritten from document.cookie", () => {
    const jar = createCookieJar();
    jar.setFromHeader(HTTPS, "sid=server; HttpOnly");
    expect(jar.setFromDocumentCookie(HTTPS, "sid=hijacked")).toBeNull();
    expect(jar.cookieHeaderForUrl(HTTPS)).toBe("sid=server");
  });

  it("cannot be deleted from document.cookie", () => {
    const jar = createCookieJar();
    jar.setFromHeader(HTTPS, "sid=server; HttpOnly");
    const past = "sid=; Expires=Thu, 01 Jan 1970 00:00:00 GMT";
    expect(jar.setFromDocumentCookie(HTTPS, past)).toBeNull();
    expect(jar.cookieHeaderForUrl(HTTPS)).toBe("sid=server");
  });

  it("can still be overwritten by a Set-Cookie header", () => {
    const jar = createCookieJar();
    jar.setFromHeader(HTTPS, "sid=first; HttpOnly");
    jar.setFromHeader(HTTPS, "sid=second; HttpOnly");
    expect(jar.cookieHeaderForUrl(HTTPS)).toBe("sid=second");
  });
});

describe("Secure", () => {
  it("is not sent to an http origin", () => {
    const jar = createCookieJar();
    jar.setFromHeader(HTTPS, "sid=1; Secure");
    expect(jar.cookieHeaderForUrl("http://app.example.com/")).toBeNull();
  });

  it("cannot be claimed from a non-trustworthy origin", () => {
    const jar = createCookieJar();
    expect(jar.setFromHeader("http://app.example.com/x", "sid=1; Secure")).toBeNull();
  });

  it("can be claimed from http://localhost", () => {
    const jar = createCookieJar();
    expect(jar.setFromHeader("http://localhost:8787/x", "sid=1; Secure")).not.toBeNull();
    expect(jar.setFromHeader("http://127.0.0.1:8787/x", "sid=1; Secure")).not.toBeNull();
  });

  it("cannot be overwritten from a non-trustworthy origin", () => {
    const jar = createCookieJar();
    jar.setFromHeader(HTTPS, "sid=secure; Secure");
    expect(jar.setFromHeader("http://app.example.com/x", "sid=downgraded")).toBeNull();
    expect(jar.cookieHeaderForUrl(HTTPS)).toBe("sid=secure");
  });

  it.each([
    ["setFromHeader", "http://victim.example/login", "sid=bad; Path=/login"],
    [
      "setFromHeader",
      "http://evil.victim.example/login",
      "sid=bad; Domain=victim.example; Path=/login",
    ],
    ["setFromDocumentCookie", "http://victim.example/login", "sid=bad; Path=/login"],
  ] as const)("rejects insecure overlapping cookies via %s at %s", (method, url, cookie) => {
    const jar = createCookieJar();
    jar.setFromHeader("https://victim.example/", "sid=good; Secure; Path=/");
    expect(jar[method](url, cookie)).toBeNull();
    expect(jar.cookieHeaderForUrl("https://victim.example/login")).toBe("sid=good");
    expect(jar[method](url, "other=ok; Path=/login")).not.toBeNull();
  });

  it("can be overwritten from https", () => {
    const jar = createCookieJar();
    jar.setFromHeader(HTTPS, "sid=first; Secure");
    jar.setFromHeader(HTTPS, "sid=second; Secure");
    expect(jar.cookieHeaderForUrl(HTTPS)).toBe("sid=second");
  });
});

describe("SameSite", () => {
  const CROSS = { initiatorOrigin: "https://attacker.net" };
  const SAME_SITE = { initiatorOrigin: "https://other.example.com" };
  const OPAQUE = { initiatorOrigin: null };

  it.each([
    ["ws://other.example.com:8080/", "http://example.com"],
    ["wss://other.example.com:8443/", "https://example.com"],
    ["data:text/html,top", null],
    ["file:///example.com", null],
    ["not a url", null],
  ])("maps %s to its schemeful site", (url, site) => {
    expect(schemefulSite(url)).toBe(site);
  });

  it("withholds Strict, Lax and unspecified from a cross-site subrequest", () => {
    const jar = createCookieJar();
    jar.setFromHeader(HTTPS, "s=1; SameSite=Strict");
    jar.setFromHeader(HTTPS, "l=1; SameSite=Lax");
    jar.setFromHeader(HTTPS, "d=1");
    expect(jar.cookieHeaderForUrl(HTTPS, CROSS)).toBeNull();
  });

  it("sends SameSite=None Secure cross-site", () => {
    const jar = createCookieJar();
    jar.setFromHeader(HTTPS, "n=1; SameSite=None; Secure");
    expect(jar.cookieHeaderForUrl(HTTPS, CROSS)).toBe("n=1");
  });

  it("same-SITE (not just same-origin) attaches everything", () => {
    const jar = createCookieJar();
    jar.setFromHeader(HTTPS, "s=1; SameSite=Strict");
    expect(jar.cookieHeaderForUrl(HTTPS, SAME_SITE)).toBe("s=1");
  });

  it.each([
    ["an HTTP sibling", { initiatorOrigin: "http://other.example.com" }, "n=1"],
    [
      "an HTTPS sibling on another port",
      { initiatorOrigin: "https://other.example.com:8443" },
      "s=1; l=1; d=1; n=1",
    ],
    ["an opaque initiator", { initiatorOrigin: null }, "n=1"],
    ["an omitted context", undefined, "s=1; l=1; d=1; n=1"],
  ])("compares schemeful sites for %s", (_label, ctx, expected) => {
    const jar = createCookieJar();
    const victim = "https://victim.example.com/";
    jar.setFromHeader(victim, "s=1; SameSite=Strict");
    jar.setFromHeader(victim, "l=1; SameSite=Lax");
    jar.setFromHeader(victim, "d=1");
    jar.setFromHeader(victim, "n=1; SameSite=None; Secure");
    expect(jar.cookieHeaderForUrl(victim, ctx)).toBe(expected);
  });

  it("an opaque initiator is same-site with nothing", () => {
    const jar = createCookieJar();
    jar.setFromHeader(HTTPS, "l=1; SameSite=Lax");
    jar.setFromHeader(HTTPS, "n=1; SameSite=None; Secure");
    expect(jar.cookieHeaderForUrl(HTTPS, OPAQUE)).toBe("n=1");
  });

  it("a cross-site top-level navigation withholds Strict alone", () => {
    const jar = createCookieJar();
    jar.setFromHeader(HTTPS, "s=1; SameSite=Strict");
    jar.setFromHeader(HTTPS, "l=1; SameSite=Lax");
    jar.setFromHeader(HTTPS, "d=1");
    jar.setFromHeader(HTTPS, "n=1; SameSite=None; Secure");
    expect(jar.cookieHeaderForUrl(HTTPS, { ...OPAQUE, topLevel: true })).toBe("l=1; d=1; n=1");
  });

  it("topLevel cannot widen a SAME-site context", () => {
    const jar = createCookieJar();
    jar.setFromHeader(HTTPS, "s=1; SameSite=Strict");
    expect(jar.cookieHeaderForUrl(HTTPS, { ...SAME_SITE, topLevel: true })).toBe("s=1");
  });

  it("no context (top-level navigation, CDP views) attaches everything", () => {
    const jar = createCookieJar();
    jar.setFromHeader(HTTPS, "s=1; SameSite=Strict");
    jar.setFromHeader(HTTPS, "d=1");
    expect(jar.cookieHeaderForUrl(HTTPS)).toBe("s=1; d=1");
  });

  it("REJECTS SameSite=None without Secure at write", () => {
    const jar = createCookieJar();
    expect(jar.setFromHeader(HTTPS, "n=1; SameSite=None")).toBeNull();
    expect(jar.setFromDocumentCookie(HTTPS, "n=1; SameSite=None")).toBeNull();
  });
});

describe("shadowing", () => {
  it("script cannot ride alongside an HttpOnly cookie of the same name", () => {
    const jar = createCookieJar();
    jar.setFromHeader(HTTPS, "sid=server; Path=/; HttpOnly; Secure");
    expect(jar.setFromDocumentCookie(HTTPS, "sid=evil; Domain=example.com; Path=/")).toBeNull();
    expect(jar.cookieHeaderForUrl(HTTPS)).toBe("sid=server");
  });

  it("blocks the shadow in the other direction too", () => {
    const jar = createCookieJar();
    jar.setFromHeader(HTTPS, "sid=server; Domain=example.com; HttpOnly; Secure");
    expect(jar.setFromDocumentCookie(HTTPS, "sid=evil")).toBeNull();
    expect(jar.cookieHeaderForUrl(HTTPS)).toBe("sid=server");
  });

  it("blocks a Domain write from reaching a host-only HttpOnly cookie on the parent", () => {
    const jar = createCookieJar();
    jar.setFromHeader("https://example.com/", "sid=server; Path=/; HttpOnly; Secure");
    expect(jar.setFromDocumentCookie(HTTPS, "sid=evil; Domain=example.com; Path=/")).toBeNull();
    expect(jar.documentCookieString(HTTPS)).toBe("");
  });

  it("blocks a Domain write from reaching a host-only HttpOnly cookie on a sibling", () => {
    const jar = createCookieJar();
    jar.setFromHeader("https://api.example.com/", "sid=server; Path=/; HttpOnly; Secure");
    expect(jar.setFromDocumentCookie(HTTPS, "sid=evil; Domain=example.com; Path=/")).toBeNull();
  });

  it("allows a host-only write on a child when the HttpOnly cookie is host-only on the parent", () => {
    const jar = createCookieJar();
    jar.setFromHeader("https://example.com/", "sid=server; Path=/; HttpOnly; Secure");
    expect(jar.setFromDocumentCookie(HTTPS, "sid=evil; Path=/")).not.toBeNull();
    expect(jar.documentCookieString(HTTPS)).toBe("sid=evil");
    expect(jar.cookieHeaderForUrl("https://example.com/")).toBe("sid=server");
  });

  it("a server may still shadow its own non-HttpOnly cookie, oldest first", () => {
    const jar = createCookieJar();
    const a = jar.setFromHeader(HTTPS, "dup=first; Path=/")!;
    const b = jar.setFromHeader(HTTPS, "dup=second; Domain=example.com; Path=/")!;
    a.createdAt = 1000;
    b.createdAt = 2000;
    expect(jar.cookieHeaderForUrl(HTTPS)).toBe("dup=first; dup=second");
    a.createdAt = 3000;
    expect(jar.cookieHeaderForUrl(HTTPS)).toBe("dup=second; dup=first");
  });

  it("an overwrite retains the original creation time", () => {
    const jar = createCookieJar();
    const first = jar.setFromHeader(HTTPS, "a=1")!;
    first.createdAt = 1000;
    const again = jar.setFromHeader(HTTPS, "a=2")!;
    expect(again.createdAt).toBe(1000);
  });
});

describe("__Host- / __Secure- prefixes", () => {
  it("__Host- accepts host-only, Secure, Path=/", () => {
    const jar = createCookieJar();
    expect(jar.setFromHeader(HTTPS, "__Host-s=1; Secure; Path=/")).not.toBeNull();
  });

  it("__Host- rejects a Domain attribute — the anti-shadow guarantee", () => {
    const jar = createCookieJar();
    expect(jar.setFromHeader(HTTPS, "__Host-s=1; Secure; Path=/; Domain=example.com")).toBeNull();
  });

  it("__Host- rejects a non-root Path and a missing Secure", () => {
    const jar = createCookieJar();
    expect(jar.setFromHeader(HTTPS, "__Host-s=1; Secure; Path=/p")).toBeNull();
    expect(jar.setFromHeader(HTTPS, "__Host-s=1; Path=/")).toBeNull();
  });

  it("__Secure- requires Secure from a trustworthy origin", () => {
    const jar = createCookieJar();
    expect(jar.setFromHeader(HTTPS, "__Secure-s=1; Secure")).not.toBeNull();
    expect(jar.setFromHeader(HTTPS, "__Secure-s=1")).toBeNull();
    expect(jar.setFromHeader("http://plain.example.com/", "__Secure-s=1; Secure")).toBeNull();
  });

  it("applies to script writes on the same terms", () => {
    const jar = createCookieJar();
    expect(jar.setFromDocumentCookie(HTTPS, "__Host-s=1; Secure; Domain=example.com")).toBeNull();
    expect(jar.setFromDocumentCookie(HTTPS, "__Host-s=1; Secure; Path=/")).not.toBeNull();
  });
});

describe("regressions the fixes must not cause", () => {
  it("an ordinary session cookie still round-trips", () => {
    const jar = createCookieJar();
    jar.setFromHeader(HTTPS, "a=1");
    jar.setFromDocumentCookie(HTTPS, "b=2");
    const hdr = jar.cookieHeaderForUrl(HTTPS);
    expect(hdr).toContain("a=1");
    expect(hdr).toContain("b=2");
    expect(jar.documentCookieString(HTTPS)).toContain("b=2");
  });

  it("path matching and longer-path-first ordering are unchanged", () => {
    const jar = createCookieJar();
    jar.setFromHeader(HTTPS, "root=1; Path=/");
    jar.setFromHeader(HTTPS, "deep=1; Path=/x");
    expect(jar.cookieHeaderForUrl(HTTPS)).toBe("deep=1; root=1");
    expect(jar.cookieHeaderForUrl("https://app.example.com/other")).toBe("root=1");
  });

  it("expiry in the past deletes, from a script write too", () => {
    const jar = createCookieJar();
    jar.setFromDocumentCookie(HTTPS, "a=1");
    jar.setFromDocumentCookie(HTTPS, "a=; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    expect(jar.cookieHeaderForUrl(HTTPS)).toBeNull();
  });

  it("an invalid cookie octet is still rejected", () => {
    const jar = createCookieJar();
    expect(jar.setFromHeader(HTTPS, "a\u0000b=1")).toBeNull();
    expect(jar.setFromHeader(HTTPS, "a=1;2")).not.toBeNull();
  });
});

describe("size quotas", () => {
  it("evicts oldest-first past the per-host cap", () => {
    const jar = createCookieJar();
    for (let i = 0; i < 200; i++) {
      jar.setFromHeader(HTTPS, `c=${i}; Path=/p${i}`);
    }
    const mine = jar.getAll().filter((c) => c.host === "app.example.com");
    expect(mine.length).toBe(180);
    expect(mine.some((c) => c.path === "/p0")).toBe(false);
    expect(mine.some((c) => c.path === "/p199")).toBe(true);
  });

  it.each(["Domain=victim.example; ", ""])(
    "protects secure entries under quota pressure: %s",
    (domain) => {
      const jar = createCookieJar();
      const victim = "https://victim.example/";
      jar.setFromHeader(victim, `sid=good; ${domain}Secure; HttpOnly; Path=/`);
      for (let i = 0; i < 180; i++) {
        jar.setFromHeader("http://evil.victim.example/", `f${i}=1; Domain=victim.example; Path=/`);
      }
      expect(jar.cookieHeaderForUrl(victim)).toContain("sid=good");
    },
  );

  it("refuses a cookie over 4096 bytes", () => {
    const jar = createCookieJar();
    expect(jar.setFromHeader(HTTPS, `big=${"x".repeat(4096)}`)).toBeNull();
    expect(jar.setFromHeader(HTTPS, `ok=${"x".repeat(4000)}`)).not.toBeNull();
    expect(jar.setFromHeader(HTTPS, `p=1; Path=/${"y".repeat(4096)}`)).toBeNull();
  });

  it("holds a global ceiling across many hosts", () => {
    const jar = createCookieJar();
    for (let h = 0; h < 40; h++) {
      for (let i = 0; i < 100; i++) {
        jar.setFromHeader(`https://h${h}.example.com/`, `c${i}=1`);
      }
    }
    expect(jar.getAll().length).toBe(3000);
  });

  it("applies the quota to a CDP write path too, not just script", () => {
    const jar = createCookieJar();
    expect(jar.setFromHeader(HTTPS, `big=${"x".repeat(5000)}`)).toBeNull();
  });

  it("a replacement is free — refreshing one cookie never spends quota", () => {
    const jar = createCookieJar();
    for (let i = 0; i < 500; i++) jar.setFromHeader(HTTPS, `sid=${i}`);
    expect(jar.getAll().length).toBe(1);
    expect(jar.cookieHeaderForUrl(HTTPS)).toBe("sid=499");
  });

  it("expired entries are collected before a write is refused", () => {
    const jar = createCookieJar();
    for (let i = 0; i < 180; i++) {
      jar.setFromHeader(HTTPS, `c=1; Path=/p${i}; Max-Age=-1`);
    }
    for (let i = 0; i < 181; i++) jar.setFromHeader(HTTPS, `live${i}=1`);
    expect(jar.getAll().filter((c) => c.host === "app.example.com").length).toBe(180);
    expect(jar.cookieHeaderForUrl(HTTPS)).toContain("live180=1");
  });

  it("dead entries never evict a live cookie", () => {
    const jar = createCookieJar();
    jar.setFromHeader(HTTPS, "keepme=1; Path=/");
    for (let i = 0; i < 179; i++) {
      jar.setFromHeader(HTTPS, `d=1; Path=/d${i}; Max-Age=-1`);
    }
    jar.setFromHeader(HTTPS, "fresh=1; Path=/");
    expect(jar.cookieHeaderForUrl(HTTPS)).toContain("keepme=1");
  });

  it("sweeps expired entries jar-wide rather than wedging at the ceiling", () => {
    const jar = createCookieJar();
    for (let h = 0; h < 30; h++) {
      for (let i = 0; i < 100; i++) {
        jar.setFromHeader(`https://h${h}.example.com/`, `c${i}=1; Max-Age=-1`);
      }
    }
    expect(jar.getAll().length).toBe(0);
    expect(jar.setFromHeader(HTTPS, "sid=1")).not.toBeNull();
  });
});

describe("CDP cookie domain", () => {
  it("reads a bare domain as host-only and a dotted one as a domain cookie", () => {
    const jar = createCookieJar();
    setCdpCookie(jar, { name: "host", value: "1", domain: "example.com", path: "/" });
    setCdpCookie(jar, { name: "dom", value: "1", domain: ".example.com", path: "/" });
    expect(jar.cookieHeaderForUrl("https://example.com/")).toBe("host=1; dom=1");
    expect(jar.cookieHeaderForUrl("https://app.example.com/")).toBe("dom=1");
  });

  it("round-trips through entryToCdp", () => {
    const jar = createCookieJar();
    jar.setFromHeader("https://app.example.com/", "host=1");
    jar.setFromHeader("https://app.example.com/", "dom=1; Domain=example.com");
    const cdp = jar.getAll().map(entryToCdp);
    expect(cdp.map((c) => c.domain)).toEqual(["app.example.com", ".example.com"]);
    const copy = createCookieJar();
    for (const c of cdp) setCdpCookie(copy, c);
    expect(copy.getAll().map((c) => [c.name, c.host, c.hostOnly])).toEqual([
      ["host", "app.example.com", true],
      ["dom", "example.com", false],
    ]);
  });
});

describe("CDP cookie params", () => {
  it("drops fields of the wrong type instead of throwing", () => {
    const jar = createCookieJar();
    expect(setCdpCookie(jar, { name: "a", value: "1", domain: 42 })).toBeNull();
    expect(
      setCdpCookie(jar, { name: "b", value: "1", url: "https://example.com/", secure: "yes" })
        ?.secure,
    ).toBe(false);
    expect(setCdpCookie(jar, null)).toBeNull();
    expect(setCdpCookie(jar, "a=1")).toBeNull();
  });
});

describe("private public suffixes", () => {
  it.each(["github.io", "pages.dev", "workers.dev", "s3.amazonaws.com"])(
    "rejects Domain=%s from one tenant",
    (suffix) => {
      const jar = createCookieJar();
      expect(jar.setFromHeader(`https://a.${suffix}/x`, `sid=1; Domain=${suffix}`)).toBeNull();
      expect(jar.getForUrl(`https://b.${suffix}/`)).toEqual([]);
    },
  );

  it("keeps a tenant's own parent domain", () => {
    const jar = createCookieJar();
    expect(
      jar.setFromHeader("https://www.a.github.io/x", "sid=1; Domain=a.github.io"),
    ).not.toBeNull();
    expect(jar.getForUrl("https://a.github.io/").map((c) => c.name)).toEqual(["sid"]);
  });

  it("treats two tenants as different sites", () => {
    const jar = createCookieJar();
    jar.setFromHeader("https://b.github.io/x", "lax=1; SameSite=Lax");
    expect(
      jar.getForUrl("https://b.github.io/", { initiatorOrigin: "https://a.github.io" }),
    ).toEqual([]);
    expect(
      jar.getForUrl("https://b.github.io/", { initiatorOrigin: "https://www.b.github.io" }).length,
    ).toBe(1);
  });

  it.each([
    "duckdns.org",
    "s3-website-us-east-1.amazonaws.com",
    "a.ck", // *.ck: a.ck is the suffix.
    "xn--55qx5d.cn", // IDN rule matched through its A-label.
  ])("rejects domain cookies and Strict reads across %s tenants", (suffix) => {
    const jar = createCookieJar();
    const cookie = `sid=attacker; Domain=${suffix}; Path=/; Secure; SameSite=None`;
    expect(jar.setFromHeader(`https://a.${suffix}/`, cookie)).toBeNull();
    expect(jar.setFromDocumentCookie(`https://a.${suffix}/`, cookie)).toBeNull();
    expect(jar.cookieHeaderForUrl(`https://b.${suffix}/`)).toBeNull();
    expect(
      jar.setFromHeader(`https://www.a.${suffix}/`, `ok=1; Domain=a.${suffix}; Path=/`),
    ).not.toBeNull();
    expect(jar.cookieHeaderForUrl(`https://a.${suffix}/`)).toBe("ok=1");
    jar.setFromHeader(`https://b.${suffix}/`, "strict=1; SameSite=Strict");
    expect(
      jar.cookieHeaderForUrl(`https://b.${suffix}/`, { initiatorOrigin: `https://a.${suffix}` }),
    ).toBeNull();
    expect(
      jar.cookieHeaderForUrl(`https://b.${suffix}/`, {
        initiatorOrigin: `https://www.b.${suffix}`,
      }),
    ).toBe("strict=1");
  });
});
