// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";

import { createCookieJar } from "../src/cookies.ts";
import {
  cookieKeyFor,
  registerCookieJar,
  unregisterConnectionCookieJars,
  __cookieJarRegistrySize,
  __hasCookieJar,
} from "../src/cdp/cookie-jar-registry.ts";

describe("cookie-jar registry connection teardown", () => {
  it("drops the default jar and every browser-context jar on close", () => {
    const conn = "conn-teardown-1";
    const before = __cookieJarRegistrySize();

    registerCookieJar(conn, createCookieJar());
    registerCookieJar(cookieKeyFor(conn, "ctx-1"), createCookieJar());
    registerCookieJar(cookieKeyFor(conn, "ctx-2"), createCookieJar());
    expect(__cookieJarRegistrySize()).toBe(before + 3);
    expect(__hasCookieJar(conn)).toBe(true);
    expect(__hasCookieJar(cookieKeyFor(conn, "ctx-2"))).toBe(true);

    unregisterConnectionCookieJars(conn, ["ctx-1", "ctx-2"]);

    expect(__hasCookieJar(conn)).toBe(false);
    expect(__hasCookieJar(cookieKeyFor(conn, "ctx-1"))).toBe(false);
    expect(__hasCookieJar(cookieKeyFor(conn, "ctx-2"))).toBe(false);
    expect(__cookieJarRegistrySize()).toBe(before);
  });

  it("leaves other connections' jars untouched", () => {
    const a = "conn-a";
    const b = "conn-b";
    registerCookieJar(a, createCookieJar());
    registerCookieJar(cookieKeyFor(a, "ctx-9"), createCookieJar());
    registerCookieJar(b, createCookieJar());

    unregisterConnectionCookieJars(a, ["ctx-9"]);

    expect(__hasCookieJar(a)).toBe(false);
    expect(__hasCookieJar(cookieKeyFor(a, "ctx-9"))).toBe(false);
    expect(__hasCookieJar(b)).toBe(true);
    unregisterConnectionCookieJars(b, []);
  });
});
