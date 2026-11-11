// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// The iframe sandbox attribute is the only input to a child's active restrictions. A missing
// attribute grants every modeled capability, an empty one grants nothing, and unknown tokens
// grant nothing.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SANDBOX_ALLOW_ALL,
  intersectSandbox,
  parseSandboxAttribute,
  type SandboxRestrictions,
} from "../src/sandbox.ts";

const NONE: SandboxRestrictions = {
  scripts: false,
  sameOrigin: false,
  forms: false,
  topNavigation: false,
};

const PARSE_CASES: Array<[string | null | undefined, SandboxRestrictions]> = [
  [null, SANDBOX_ALLOW_ALL],
  [undefined, SANDBOX_ALLOW_ALL],
  ["", NONE],
  ["   ", NONE],
  ["allow-scripts", { ...NONE, scripts: true }],
  ["ALLOW-SCRIPTS", { ...NONE, scripts: true }],
  ["\tallow-same-origin\n allow-forms\f", { ...NONE, sameOrigin: true, forms: true }],
  ["allow-scripts allow-same-origin", { ...NONE, scripts: true, sameOrigin: true }],
  ["allow-unknown allow-scripts", { ...NONE, scripts: true }],
  ["allow-top-navigation", { ...NONE, topNavigation: true }],
  // Not modeled, so they stay ungranted (fail closed).
  ["allow-popups", NONE],
  ["allow-top-navigation-by-user-activation", NONE],
];

test("parses the modeled sandbox tokens", () => {
  for (const [raw, expected] of PARSE_CASES) {
    assert.deepEqual(parseSandboxAttribute(raw), expected, JSON.stringify(raw));
  }
});

test("intersects ancestor capabilities", () => {
  const parent = parseSandboxAttribute("allow-scripts allow-same-origin");
  const child = parseSandboxAttribute("allow-scripts allow-forms");
  assert.deepEqual(intersectSandbox(parent, child), { ...NONE, scripts: true });
  assert.deepEqual(intersectSandbox(SANDBOX_ALLOW_ALL, child), child);
});

test("bounds the work a page-controlled attribute can cost", () => {
  // A token longer than any modeled one cannot grant anything, so it is skipped without copying.
  const huge = `allow-scripts ${"x".repeat(1 << 20)} allow-forms`;
  const started = performance.now();
  assert.deepEqual(parseSandboxAttribute(huge), { ...NONE, scripts: true, forms: true });
  assert.ok(performance.now() - started < 250, "parsing 1 MiB must stay linear");

  // Only the first tokens are read; a capability past the cap stays ungranted.
  const capped = `${Array.from({ length: 64 }, () => "allow-unknown").join(" ")} allow-scripts`;
  assert.deepEqual(parseSandboxAttribute(capped), NONE);
});
