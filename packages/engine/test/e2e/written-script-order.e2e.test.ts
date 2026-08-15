// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A document.write'd <script src> is PARSER-INSERTED: the spec puts it at the
// parser insertion point, so it blocks the parser and runs before DCL.

// This is how every pre-ES6 loader works — tdl.js's require() writes a script
// tag per module — and getting it wrong is invisible rather than loud. The

// modules simply arrive after DOMContentLoaded, so a jQuery $(fn) ready
// handler runs with the whole library still undefined and throws somewhere
// unrelated. webglsamples.org/aquarium died on `tdl.sync.SyncManager`.

// Two generations, because a written script writes more of them: the drain has
// to re-check rather than await the snapshot it started with.

import { test } from "./harness";
import { expect } from "vitest";

test("document.write'd scripts run, in order, before DOMContentLoaded", async ({ browser }) => {
  const page = (await browser.pages())[0] ?? (await browser.newPage());

  // A real origin, not setContent: the written script is a SUBRESOURCE, and
  // a data: URL page has an opaque origin that never fetches it (fact 25).
  await page.goto("http://127.0.0.1:8787/__fixtures/written-script-order.html", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  const deadline = Date.now() + 30000;
  let state: { atDcl?: string; all?: string } = {};
  while (Date.now() < deadline) {
    state = await page.evaluate(() => {
      const atDcl: unknown = Reflect.get(globalThis, "__atDcl");
      const written: unknown = Reflect.get(globalThis, "__written");
      return {
        atDcl: typeof atDcl === "string" ? atDcl : undefined,
        all: Array.isArray(written) ? written.join(",") : "",
      };
    });
    if (typeof state.atDcl === "string") break;
    await new Promise((r) => setTimeout(r, 250));
  }

  // Both generations ran, in write order, and DCL saw them.
  expect(state.atDcl).toBe("a,b");
  expect(state.all).toBe("a,b");
});
