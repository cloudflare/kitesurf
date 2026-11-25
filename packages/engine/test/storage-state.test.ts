// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// playwright's storageState file as Kitesurf.setStorageState reads it (state/storage-state.ts).
import { describe, expect, it } from "vitest";

import { createCookieJar, setCdpCookie } from "../src/cookies.ts";
import { LOCAL_STORAGE_QUOTA_UNITS } from "../src/state/local-storage.ts";
import {
  MAX_STORAGE_STATE_ORIGINS,
  parseStorageState,
  storageStateOps,
} from "../src/state/storage-state.ts";

// A file as playwright writes it, with the fields kitesurf ignores.
const FILE = {
  cookies: [
    {
      name: "sid",
      value: "abc",
      domain: "app.example.com",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
    {
      name: "pref",
      value: "dark",
      domain: ".example.com",
      path: "/",
      expires: 4102444800,
      httpOnly: false,
      secure: true,
      sameSite: "None",
      partitionKey: "https://example.com",
    },
  ],
  origins: [
    {
      origin: "https://app.example.com",
      localStorage: [{ name: "token", value: "t" }],
      indexedDB: [],
    },
  ],
};

describe("parseStorageState", () => {
  it("reads a playwright file and drops the fields kitesurf does not keep", () => {
    const state = parseStorageState(FILE);
    const { partitionKey: _, ...pref } = FILE.cookies[1]!;
    expect(state.cookies).toEqual([FILE.cookies[0], pref]);
    expect(state.origins).toEqual(
      new Map([["https://app.example.com", new Map([["token", "t"]])]]),
    );
  });

  it("gives the jar the cookies as Set-Cookie would set them", () => {
    const jar = createCookieJar();
    for (const c of parseStorageState(FILE).cookies) setCdpCookie(jar, c);
    expect(jar.cookieHeaderForUrl("https://app.example.com/")).toBe("sid=abc; pref=dark");
    // pref is a domain cookie; sid is host-only.
    expect(jar.cookieHeaderForUrl("https://www.example.com/")).toBe("pref=dark");
  });

  it("accepts a cookie by url, an empty file, and an origin given as a URL", () => {
    expect(parseStorageState({})).toEqual({ cookies: [], origins: new Map() });
    const state = parseStorageState({
      cookies: [{ name: "u", value: "1", url: "https://example.com/x" }],
      origins: [
        { origin: "https://example.com/path", localStorage: [{ name: "a", value: "1" }] },
        { origin: "https://example.com", localStorage: [{ name: "a", value: "2" }] },
      ],
    });
    expect(state.cookies).toEqual([
      { name: "u", value: "1", url: "https://example.com/x", path: "/", secure: true },
    ]);
    // Repeated origins merge, and a repeated key keeps its last value.
    expect(state.origins).toEqual(new Map([["https://example.com", new Map([["a", "2"]])]]));
  });

  it("takes a url cookie's path and secure flag from the URL, as playwright does", () => {
    const jar = createCookieJar();
    const state = parseStorageState({
      cookies: [
        { name: "app", value: "1", url: "https://example.com/app/x", secure: false },
        { name: "plain", value: "1", url: "http://example.com/" },
      ],
    });
    expect(state.cookies.map((c) => [c.path, c.secure])).toEqual([
      ["/app/", true],
      ["/", false],
    ]);
    for (const c of state.cookies) setCdpCookie(jar, c);
    expect(jar.cookieHeaderForUrl("https://example.com/app/y")).toBe("app=1; plain=1");
    expect(jar.cookieHeaderForUrl("https://example.com/other")).toBe("plain=1");
    expect(jar.cookieHeaderForUrl("http://example.com/app/y")).toBe("plain=1");
  });

  it("keeps a cookie field from adding attributes to the cookie", () => {
    expect(() =>
      parseStorageState({
        cookies: [
          { name: "a", value: "1", domain: "app.example.com", path: "/; Domain=.example.com" },
        ],
      }),
    ).toThrow(/cookies\[0\]\.path: has ";"/);
  });

  it("drops a cookie that expired at the epoch", () => {
    const state = parseStorageState({
      cookies: [
        { name: "gone", value: "1", domain: "x", path: "/", expires: 0 },
        { name: "kept", value: "1", domain: "x", path: "/", expires: -1 },
      ],
    });
    expect(state.cookies.map((c) => c.name)).toEqual(["kept"]);
  });

  it("counts the quota across repeated origins and keys", () => {
    const half = "v".repeat(LOCAL_STORAGE_QUOTA_UNITS / 2);
    const entry = (name: string) => ({
      origin: "https://x.example",
      localStorage: [{ name, value: half }],
    });
    // A repeated key replaces its value, so it counts once.
    expect(parseStorageState({ origins: [entry("k"), entry("k"), entry("k")] }).origins.size).toBe(
      1,
    );
    expect(() => parseStorageState({ origins: [entry("a"), entry("b")] })).toThrow(
      /origins\[1\]\.localStorage: over the .*quota/,
    );
  });

  it.each([
    [[], /storageState: not an object/],
    [{ cookies: {} }, /storageState.cookies: not an array/],
    [{ cookies: [{ name: "a", value: "b" }] }, /needs a url, or a domain and a path/],
    [
      { cookies: [{ name: "a", value: "b", url: "https://x/", domain: "x", path: "/" }] },
      /not both/,
    ],
    [{ cookies: [{ name: "a", value: "b", url: "ftp://x/" }] }, /cookies\[0\]\.url/],
    [{ cookies: [{ name: "a", value: "b", domain: "x", path: "/", sameSite: "lax" }] }, /sameSite/],
    [{ cookies: [{ name: "a", value: "b", domain: "x", path: "/", expires: "1" }] }, /expires/],
    [{ cookies: [{ name: "a", value: "b", domain: "x", path: "/", expires: -5 }] }, /expires/],
    [{ cookies: [{ name: "a=b", value: "c", domain: "x", path: "/" }] }, /name: has "="/],
    [{ cookies: [{ name: "a", value: "b; Secure", domain: "x", path: "/" }] }, /value: has ";"/],
    [{ cookies: [{ name: "a", value: "b\n", domain: "x", path: "/" }] }, /value: has "\\n"/],
    [{ cookies: [{ name: "a", value: "b", domain: "x;y", path: "/" }] }, /domain: has ";"/],
    [{ cookies: [{ name: "a", value: "b", domain: "x", path: "app" }] }, /path: does not start/],
    [{ cookies: [{ name: "a", value: "b", url: "https://x/a;b/c" }] }, /url: has ";"/],
    [
      {
        origins: Array.from({ length: MAX_STORAGE_STATE_ORIGINS + 1 }, (_, i) => ({
          origin: `https://o${i}.example`,
          localStorage: [],
        })),
      },
      /over 1000 origins/,
    ],
    [{ origins: [{ origin: "foo", localStorage: [] }] }, /origins\[0\]\.origin: .*foo/],
    [
      { origins: [{ origin: "https://x", localStorage: [{ name: 1 }] }] },
      /localStorage\[0\]\.name/,
    ],
    [
      {
        origins: [
          {
            origin: "https://x",
            localStorage: [{ name: "k", value: "v".repeat(LOCAL_STORAGE_QUOTA_UNITS) }],
          },
        ],
      },
      /over the .*quota/,
    ],
  ])("rejects %j", (input, message) => {
    expect(() => parseStorageState(input)).toThrow(message);
  });
});

describe("storageStateOps", () => {
  it("clears the origins the file leaves out and replaces the ones it lists", () => {
    const state = parseStorageState({
      origins: [{ origin: "https://a.example", localStorage: [{ name: "k", value: "v" }] }],
    });
    expect(storageStateOps(state, ["https://a.example", "https://b.example"])).toEqual(
      new Map([
        ["https://a.example", [{ op: "clear" }, { op: "set", key: "k", value: "v" }]],
        ["https://b.example", [{ op: "clear" }]],
      ]),
    );
  });

  it("leaves out an origin that has no keys and no area", () => {
    const state = parseStorageState({
      origins: [{ origin: "https://a.example", localStorage: [] }],
    });
    expect(storageStateOps(state, [])).toEqual(new Map());
    expect(storageStateOps(state, ["https://a.example"])).toEqual(
      new Map([["https://a.example", [{ op: "clear" }]]]),
    );
  });
});
