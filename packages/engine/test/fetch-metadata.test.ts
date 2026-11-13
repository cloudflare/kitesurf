// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import { fetchSite, navigationFetchMetadata, takesFetchMetadata } from "../src/fetch-metadata.ts";

describe("fetchSite", () => {
  it("is same-origin only for the same scheme, host and port", () => {
    expect(fetchSite("https://shop.example", "https://shop.example/cart?x=1")).toBe("same-origin");
    expect(fetchSite("https://shop.example", "https://shop.example:8443/")).toBe("same-site");
  });

  it("is same-site across hosts that share a registrable domain and a scheme", () => {
    expect(fetchSite("https://www.shop.example", "https://img.shop.example/a")).toBe("same-site");
    expect(fetchSite("https://a.shop.co.uk", "https://b.shop.co.uk/")).toBe("same-site");
    expect(fetchSite("http://localhost:3000", "http://localhost:4000/")).toBe("same-site");
  });

  it("is cross-site across registrable domains, public suffixes and schemes", () => {
    expect(fetchSite("https://shop.example", "https://other.example/")).toBe("cross-site");
    expect(fetchSite("https://one.co.uk", "https://two.co.uk/")).toBe("cross-site");
    expect(fetchSite("http://shop.example", "https://shop.example/")).toBe("cross-site");
  });

  it("is cross-site when either end has no tuple origin", () => {
    expect(fetchSite(null, "https://shop.example/")).toBe("cross-site");
    expect(fetchSite("null", "https://shop.example/")).toBe("cross-site");
    expect(fetchSite("https://shop.example", "data:text/html,hi")).toBe("cross-site");
  });
});

describe("takesFetchMetadata", () => {
  it("takes a URL over TLS or on this machine", () => {
    for (const url of [
      "https://shop.example/",
      "wss://shop.example/socket",
      "http://localhost:8787/",
      "http://app.localhost/",
      "http://127.0.0.1:8787/",
      "http://[::1]/",
    ]) {
      expect(takesFetchMetadata(url), url).toBe(true);
    }
  });

  it("refuses plain http elsewhere and anything that is not a URL", () => {
    for (const url of ["http://shop.example/", "http://10.0.0.1/", "data:text/html,hi", "shop"]) {
      expect(takesFetchMetadata(url), url).toBe(false);
    }
  });
});

describe("navigationFetchMetadata", () => {
  const CART = "https://shop.example/cart";

  it("marks a navigation the client starts as nobody's, and a person's", () => {
    expect(navigationFetchMetadata(undefined, null, CART)).toEqual({
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "none",
      "sec-fetch-user": "?1",
      "upgrade-insecure-requests": "1",
    });
  });

  it("relates a click's navigation to the page clicked on, and keeps it a person's", () => {
    const sent = navigationFetchMetadata("input", "https://search.example", CART);
    expect(sent["sec-fetch-site"]).toBe("cross-site");
    expect(sent["sec-fetch-user"]).toBe("?1");
  });

  it("leaves the person out of a navigation a script starts", () => {
    const sent = navigationFetchMetadata("script", "https://shop.example", CART);
    expect(sent["sec-fetch-site"]).toBe("same-origin");
    expect("sec-fetch-user" in sent).toBe(false);
  });

  it("treats a page with no tuple origin as cross-site, not as nobody", () => {
    expect(navigationFetchMetadata("script", null, CART)["sec-fetch-site"]).toBe("cross-site");
  });
});
