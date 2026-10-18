// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Synthetic keypair for Web Bot Auth e2e tests only; no live directory
// publishes its public half. Production signing keys remain Worker secrets.
export const WBA_TEST_PRIVATE_JWK = {
  kty: "OKP",
  crv: "Ed25519",
  x: "7pzqD9n5DowPqQg1YpyAUxtlBeilLiLt3HqAIrdcl3c",
  d: "IJvUpx56CeH9lJfzqbwqROWL9mu-i-TlEB3-_in1GjI",
} as const;

export const WBA_TEST_PUBLIC_JWK = {
  kty: "OKP",
  crv: "Ed25519",
  x: "7pzqD9n5DowPqQg1YpyAUxtlBeilLiLt3HqAIrdcl3c",
} as const;

export const WBA_TEST_KEYID = "wesWX_rBb5VNY3kXerFNhqMM7ohV-MQYiE5jGyUyg_o";

export const WBA_TEST_SIGNATURE_AGENT = "https://wba-test.kitesurf.invalid";
