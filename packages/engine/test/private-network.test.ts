// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";

import { addressSpaceOf, privateNetworkRefusal } from "../src/eval/private-network.ts";

const space = (url: string) => addressSpaceOf(new URL(url));

describe("addressSpaceOf", () => {
  it("classifies loopback names and literals, in every form the URL parser accepts", () => {
    for (const url of [
      "http://localhost/",
      "http://app.localhost:3000/",
      "http://127.0.0.1/",
      "http://127.1/",
      "http://0x7f000001/",
      "http://0.0.0.0/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      // A trailing dot still resolves to loopback; url.hostname keeps it.
      "http://localhost./",
      "http://app.localhost.:3000/",
      "http://127.0.0.1./",
    ]) {
      expect(space(url), url).toBe("loopback");
    }
  });

  it("classifies private, link-local and multicast addresses", () => {
    for (const url of [
      "http://10.0.0.1/",
      "http://172.16.0.1/",
      "http://172.31.255.255/",
      "http://192.168.1.1/",
      "http://169.254.169.254/",
      "http://100.64.0.1/",
      "http://224.0.0.1/",
      "http://[fd00::1]/",
      "http://[fe80::1]/",
      "http://[::ffff:10.0.0.1]/",
    ]) {
      expect(space(url), url).toBe("private");
    }
  });

  it("treats other literals and names as public", () => {
    for (const url of [
      "https://example.com/",
      "http://172.32.0.1/",
      "http://8.8.8.8/",
      "http://[2606:4700::1111]/",
    ]) {
      expect(space(url), url).toBe("public");
    }
  });
});

describe("privateNetworkRefusal", () => {
  const refused = (target: string, initiator: string) =>
    privateNetworkRefusal(new URL(target), initiator) !== null;

  it("refuses a request into a more private space", () => {
    expect(refused("http://127.0.0.1:9222/json", "https://example.com")).toBe(true);
    expect(refused("http://192.168.1.1/", "https://example.com")).toBe(true);
    expect(refused("http://localhost/", "http://192.168.1.5")).toBe(true);
    // An opaque initiator counts as public.
    expect(refused("http://10.0.0.1/", "")).toBe(true);
  });

  it("allows requests within the same space or towards a more public one", () => {
    expect(refused("http://localhost:3000/api", "http://localhost:3000")).toBe(false);
    expect(refused("http://10.0.0.2/", "http://10.0.0.1")).toBe(false);
    expect(refused("https://cdn.example/", "http://localhost:3000")).toBe(false);
    expect(refused("https://example.com/", "")).toBe(false);
  });
});
