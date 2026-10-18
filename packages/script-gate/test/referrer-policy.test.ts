// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// The gateway's Referer and a frame document's document.referrer both
// come from this table, so each policy row is pinned against the
// Referrer Policy spec.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { determineReferrer, parseReferrerPolicy } from "../src/referrer-policy.ts";

const PAGE = "https://a.test/dir/page.html?q=1#frag";
const FULL = "https://a.test/dir/page.html?q=1";
const ORIGIN = "https://a.test/";

describe("determineReferrer", () => {
  it("default policy: full URL same-origin, origin cross-origin", () => {
    assert.equal(determineReferrer(PAGE, "https://a.test/frame.html", ""), FULL);
    assert.equal(determineReferrer(PAGE, "https://b.test/frame.html", ""), ORIGIN);
  });

  it("treats about:blank as a cross-origin, trustworthy target", () => {
    assert.equal(determineReferrer(PAGE, "about:blank", ""), ORIGIN);
    assert.equal(determineReferrer(PAGE, "about:blank", "same-origin"), "");
    assert.equal(determineReferrer(PAGE, "about:blank", "unsafe-url"), FULL);
  });

  it("drops the referrer on an https to http downgrade where the policy says so", () => {
    const http = "http://a.test/frame.html";
    assert.equal(determineReferrer(PAGE, http, ""), "");
    assert.equal(determineReferrer(PAGE, http, "strict-origin"), "");
    assert.equal(determineReferrer(PAGE, http, "no-referrer-when-downgrade"), "");
    assert.equal(determineReferrer(PAGE, http, "origin"), ORIGIN);
    assert.equal(determineReferrer(PAGE, http, "unsafe-url"), FULL);
  });

  it("covers the remaining policies for a same-origin target", () => {
    const same = "https://a.test/frame.html";
    assert.equal(determineReferrer(PAGE, same, "no-referrer"), "");
    assert.equal(determineReferrer(PAGE, same, "origin"), ORIGIN);
    assert.equal(determineReferrer(PAGE, same, "strict-origin"), ORIGIN);
    assert.equal(determineReferrer(PAGE, same, "same-origin"), FULL);
    assert.equal(determineReferrer(PAGE, same, "origin-when-cross-origin"), FULL);
  });

  it("strips userinfo and sends nothing from a local-scheme source", () => {
    assert.equal(
      determineReferrer("https://u:p@a.test/x#y", "https://a.test/f", ""),
      "https://a.test/x",
    );
    assert.equal(determineReferrer("about:blank", "https://a.test/f", ""), "");
    assert.equal(determineReferrer("data:text/html,x", "https://a.test/f", ""), "");
  });
});

describe("parseReferrerPolicy", () => {
  it("takes the last recognised token and ignores unknown ones", () => {
    assert.equal(parseReferrerPolicy("no-referrer, bogus"), "no-referrer");
    assert.equal(parseReferrerPolicy("origin, Unsafe-URL"), "unsafe-url");
    assert.equal(parseReferrerPolicy("bogus"), "");
    assert.equal(parseReferrerPolicy(null), "");
  });
});
