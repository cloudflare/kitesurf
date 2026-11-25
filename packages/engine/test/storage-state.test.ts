// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// playwright's storageState file as Kitesurf.setStorageState reads it (state/storage-state.ts).
import { describe, expect, it } from "vitest";

import { createCookieJar, setCdpCookie } from "../src/cookies.ts";
import { LOCAL_STORAGE_QUOTA_UNITS } from "../src/state/local-storage.ts";
import { parseStorageState, storageStateOps } from "../src/state/storage-state.ts";

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
    expect(state.cookies).toEqual([{ name: "u", value: "1", url: "https://example.com/x" }]);
    // Repeated origins merge, and a repeated key keeps its last value.
    expect(state.origins).toEqual(new Map([["https://example.com", new Map([["a", "2"]])]]));
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
});
