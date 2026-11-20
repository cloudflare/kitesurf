// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// frame-ancestors and X-Frame-Options decide whether a response may commit in a child frame.
// Rows were checked against Chrome where CSP3 and browser behavior differ.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  committedOriginOfUrl,
  embeddingPolicyVerdict,
  type EmbeddingPolicyInput,
} from "../src/frame-policy.ts";
import type { CommittedOrigin } from "@kitesurf/jsrpc-types/frame-origin";

const A: CommittedOrigin = { kind: "tuple", origin: "https://a.example" };
const B: CommittedOrigin = { kind: "tuple", origin: "https://b.example" };
const IP: CommittedOrigin = { kind: "tuple", origin: "http://127.0.0.1:8787" };
const OPAQUE: CommittedOrigin = { kind: "opaque", id: "opaque-1" };

function verdict(
  csp: string | null,
  xfo: string | null,
  ancestors: CommittedOrigin[],
  destination: CommittedOrigin = A,
): boolean {
  const input: EmbeddingPolicyInput = {
    cspHeaders: [csp],
    xFrameOptions: [xfo],
    destinationOrigin: destination,
    ancestorOrigins: ancestors,
  };
  return embeddingPolicyVerdict(input).allowed;
}

const CSP_CASES: Array<[string, string | null, CommittedOrigin[], boolean]> = [
  ["no policy", null, [A], true],
  ["none", "frame-ancestors 'none'", [A], false],
  ["none uppercase", "FRAME-ANCESTORS 'NONE'", [A], false],
  ["self same origin", "frame-ancestors 'self'", [A], true],
  ["self other origin", "frame-ancestors 'self'", [B], false],
  ["star other origin", "frame-ancestors *", [B], true],
  ["star opaque ancestor", "frame-ancestors *", [OPAQUE], false],
  ["scheme source", "frame-ancestors https:", [B], true],
  [
    "scheme mismatch",
    "frame-ancestors https:",
    [{ kind: "tuple", origin: "http://b.example" }],
    false,
  ],
  ["host source", "frame-ancestors https://b.example", [B], true],
  ["host mismatch", "frame-ancestors https://c.example", [B], false],
  ["subdomain wildcard", "frame-ancestors https://*.b.example", [B], false],
  [
    "subdomain wildcard child",
    "frame-ancestors https://*.example",
    [{ kind: "tuple", origin: "https://sub.example" }],
    true,
  ],
  ["ip default port", "frame-ancestors http://127.0.0.1", [IP], false],
  ["ip explicit port", "frame-ancestors http://127.0.0.1:8787", [IP], true],
  ["ip wildcard host", "frame-ancestors http://*:8787", [IP], true],
  [
    "ipv6 literal is invalid",
    "frame-ancestors http://[::1]:8080",
    [{ kind: "tuple", origin: "http://[::1]:8080" }],
    false,
  ],
  [
    "ipv6 wildcard",
    "frame-ancestors http://*:8080",
    [{ kind: "tuple", origin: "http://[::1]:8080" }],
    true,
  ],
  ["scheme-relative is invalid", "frame-ancestors //b.example", [B], false],
  ["none mixed with a source", "frame-ancestors 'none' https://a.example", [A], true],
  ["none mixed with an invalid source", "frame-ancestors 'none' 'unsafe-inline'", [A], false],
  ["empty directive", "frame-ancestors", [A], false],
  ["invalid keyword only", "frame-ancestors 'unsafe-inline'", [A], false],
  ["default-src has no fallback", "default-src 'none'", [A], true],
  [
    "every policy must allow",
    "frame-ancestors 'none', frame-ancestors https://a.example",
    [A],
    false,
  ],
  [
    "both policies allow",
    "frame-ancestors https://a.example, frame-ancestors https://a.example",
    [A],
    true,
  ],
  ["full chain checked", "frame-ancestors https://b.example", [B, A], false],
  ["full chain allowed", "frame-ancestors https://a.example https://b.example", [B, A], true],
  ["path root", "frame-ancestors https://a.example/", [A], true],
  ["path mismatch", "frame-ancestors https://a.example/nope", [A], false],
  ["opaque destination self", "frame-ancestors 'self'", [A], false],
];

test("frame-ancestors rows", () => {
  for (const [name, csp, ancestors, allowed] of CSP_CASES) {
    const destination: CommittedOrigin = name === "opaque destination self" ? OPAQUE : A;
    assert.equal(verdict(csp, null, ancestors, destination), allowed, name);
  }
});

const XFO_CASES: Array<[string, string, boolean]> = [
  ["deny", "DENY", false],
  ["deny lowercase", "deny", false],
  ["sameorigin", "SAMEORIGIN", true],
  ["sameorigin trailing comma", "SAMEORIGIN,", false],
  ["duplicate deny", "DENY, DENY", false],
  ["conflict", "SAMEORIGIN, DENY", false],
  ["allowall", "ALLOWALL", true],
  ["allow-from", "ALLOW-FROM https://example.com", true],
  ["empty elements", ",", true],
  ["unknown", "BOGUS", true],
];

test("X-Frame-Options rows", () => {
  for (const [name, xfo, allowed] of XFO_CASES) {
    assert.equal(verdict(null, xfo, [A]), allowed, name);
  }
  assert.equal(verdict(null, "SAMEORIGIN", [B]), false, "sameorigin foreign ancestor");
  assert.equal(verdict(null, "SAMEORIGIN", [OPAQUE]), false, "sameorigin opaque ancestor");
  assert.equal(verdict(null, "SAMEORIGIN", []), true, "top-level ignores XFO");
});

test("an enforced frame-ancestors directive replaces X-Frame-Options", () => {
  assert.equal(verdict("frame-ancestors https://a.example", "DENY", [A]), true);
  assert.equal(verdict("frame-ancestors 'none'", "SAMEORIGIN", [A]), false);
});

test("'self' allows an insecure document to name a secure ancestor on default ports", () => {
  const insecure: CommittedOrigin = { kind: "tuple", origin: "http://a.example" };
  const secure: CommittedOrigin = { kind: "tuple", origin: "https://a.example" };
  assert.equal(verdict("frame-ancestors 'self'", null, [secure], insecure), true);
  const securePort: CommittedOrigin = { kind: "tuple", origin: "https://a.example:8443" };
  assert.equal(verdict("frame-ancestors 'self'", null, [securePort], insecure), false);
});

test("committedOriginOfUrl keeps opaque identities distinct", () => {
  assert.deepEqual(committedOriginOfUrl("https://a.example/x", "id"), {
    kind: "tuple",
    origin: "https://a.example",
  });
  assert.deepEqual(committedOriginOfUrl("data:text/html,x", "id-1"), {
    kind: "opaque",
    id: "id-1",
  });
  assert.deepEqual(committedOriginOfUrl("about:blank", "id-2"), {
    kind: "opaque",
    id: "id-2",
  });
});
