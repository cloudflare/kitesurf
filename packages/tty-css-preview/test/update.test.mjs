// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { loadCssWithFallback, updateCss } from "../extension/update.js";

function options(overrides = {}) {
  return {
    level: 1,
    appliedCss: null,
    appliedLevel: 0,
    loadCss: async () => "new css",
    removeCss: async () => {},
    insertCss: async () => {},
    ...overrides,
  };
}

test("prefers CSS from the hot-reload server", async () => {
  let fallbackCalls = 0;
  const css = await loadCssWithFallback(
    1,
    async () => "live css",
    async () => {
      fallbackCalls += 1;
      return "bundled css";
    },
  );

  assert.equal(css, "live css");
  assert.equal(fallbackCalls, 0);
});

test("loads bundled CSS when the hot-reload server is offline", async () => {
  const css = await loadCssWithFallback(
    2,
    async () => {
      throw new Error("server offline");
    },
    async (level) => `bundled level ${level}`,
  );

  assert.equal(css, "bundled level 2");
});

test("replaces CSS retained by a document after a service worker restart", async () => {
  const calls = [];
  const result = await updateCss(
    options({
      appliedCss: "old css",
      appliedLevel: 1,
      removeCss: async (css) => calls.push(["remove", css]),
      insertCss: async (css) => calls.push(["insert", css]),
    }),
  );

  assert.deepEqual(calls, [
    ["remove", "old css"],
    ["insert", "new css"],
  ]);
  assert.deepEqual(result, {
    status: "updated",
    appliedCss: "new css",
    appliedLevel: 1,
  });
});

test("preserves applied state when CSS removal fails", async () => {
  const result = await updateCss(
    options({
      appliedCss: "old css",
      appliedLevel: 1,
      removeCss: async () => {
        throw new Error("document unavailable");
      },
    }),
  );

  assert.equal(result.status, "error");
  assert.equal(result.appliedCss, "old css");
  assert.equal(result.appliedLevel, 1);
  assert.match(result.message, /document unavailable/);
});

test("clears content-script state when insertion fails after removal", async () => {
  const result = await updateCss(
    options({
      appliedCss: "old css",
      appliedLevel: 1,
      insertCss: async () => {
        throw new Error("insertion failed");
      },
    }),
  );

  assert.equal(result.status, "error");
  assert.equal(result.appliedCss, null);
  assert.equal(result.appliedLevel, 0);
});

test("off removes the exact CSS retained by the document", async () => {
  let removed;
  const result = await updateCss(
    options({
      level: 0,
      appliedCss: "old css",
      appliedLevel: 2,
      removeCss: async (css) => {
        removed = css;
      },
    }),
  );

  assert.equal(removed, "old css");
  assert.deepEqual(result, {
    status: "off",
    appliedCss: null,
    appliedLevel: 0,
  });
});
