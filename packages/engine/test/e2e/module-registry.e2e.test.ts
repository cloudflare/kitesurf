// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

const ORIGIN = "https://ks.invalid";
const ALT_ORIGIN = "https://ks-alt.invalid";

test("module graph resolves through the new module registry", async ({ page }) => {
  await page.goto(`${ORIGIN}/__fixtures/module-registry.html`, {
    waitUntil: "load",
  });

  await expect
    .poll(() =>
      page.evaluate(
        () => (globalThis as { registryResult?: { done?: boolean } }).registryResult?.done,
      ),
    )
    .toBe(true);

  const result = await page.evaluate(
    () => (globalThis as { registryResult?: unknown }).registryResult,
  );
  expect(result).toEqual({
    lib: `lib:${ALT_ORIGIN}/__fixtures/module-registry-lib.js`,
    mutableExports: {
      incrementedCount: 1,
      firstInitializedValue: "first",
      secondInitializedValue: "second",
    },
    config: { greeting: "hello" },
    dynamicConfig: { greeting: "hello" },
    queryA: `${ORIGIN}/__fixtures/module-registry-meta.js?v=a`,
    queryB: `${ORIGIN}/__fixtures/module-registry-meta.js?v=b`,
    metaUrl: `${ORIGIN}/__fixtures/__kitesurf_inline_0.js`,
    css: {
      name: "TypeError",
      message: 'Unsupported import attribute type: "css"',
    },
    bareResolve: {
      name: "TypeError",
      message: "Bare module specifier requires an import map: react",
    },
    fallbackJson: { loader: "boa-fallback" },
    // A JSON-typed dynamic import of a JavaScript module is refused before it runs; the same
    // attribute on a baked JSON record still yields its value.
    jsonTypedJs: expect.stringMatching(
      /module refused for \S+\/module-registry-live-reader\.js.*JSON/s,
    ),
    typedConfig: { greeting: "hello" },
    fallbackMalformed: expect.stringMatching(
      /module refused for \S+\/module-registry-malformed\.json.*SyntaxError/s,
    ),
    attributedJson: { ownProto: true, plain: 1, tag: "[object Module]", same: true },
    boaLiveCount: [1, 2, 2],
    done: true,
  });

  const tla = await page.evaluate(() => (globalThis as { registryTla?: unknown }).registryTla);
  expect(tla, "TLA module resumed after the shim drain and finished before DCL").toEqual({
    greeting: "hello",
    dclBefore: false,
  });
});
