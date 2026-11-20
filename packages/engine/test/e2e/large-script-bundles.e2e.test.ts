// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

const ORIGIN = "https://ks.invalid";
const BUNDLE_BYTES = 7 * 1024 * 1024;

const bundle = (tag: string): string =>
  `${ORIGIN}/__fixtures/policy-script.js?tag=${tag}&pad=${BUNDLE_BYTES}`;

// Four 7 MiB bundles are prefetched at once, more than one connection's share of the
// read budget; every one of them must still run.
for (const type of ["classic", "module"] as const) {
  test(`${type} parser scripts whose bodies together pass the read budget all run`, async ({
    page,
  }) => {
    const tags = ["a", "b", "c", "d"];
    const attr = type === "module" ? ` type="module"` : "";
    const body = tags.map((tag) => `<script${attr} src="${bundle(tag)}"></script>`).join("");
    const url = new URL(`${ORIGIN}/__fixtures/policy-doc.html`);
    url.searchParams.set("body", body);
    await page.goto(url.toString(), { waitUntil: "load", timeout: 60000 });
    const ran = (await page.evaluate(
      () => (globalThis as { __ksRan?: string[] }).__ksRan ?? [],
    )) as string[];
    expect([...ran].sort()).toEqual(tags);
  });
}
