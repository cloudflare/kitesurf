// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// getMemoryStats carries boa's code counters, which decide what a swap could move out of
// wasm memory, so a page's own `new Function` has to show up in them by form.
import { expect } from "vitest";

import { test } from "./harness";
import { setContent } from "./set-content";
import type { Page } from "@cloudflare/puppeteer";

const FUNCTIONS = 200;

async function boaCode(page: Page) {
  const session = await page.createCDPSession();
  const targetId: unknown = Reflect.get(page.target(), "_targetId");
  if (typeof targetId !== "string") throw new Error("puppeteer target has no _targetId");
  const stats = await session.send("Kitesurf.getMemoryStats", { targetId });
  await session.detach().catch(() => {});
  if (!stats.bridge) throw new Error("no bridge gauges in getMemoryStats");
  return stats.bridge.boaCode;
}

test("a page's new Function shows in boa's code counters, by form", async ({ page }) => {
  await setContent(
    page,
    `<script>
      let body = "";
      for (let i = 0; i < ${FUNCTIONS}; i++) body += "function f" + i + "(x) { return x + " + i + "; }\\n";
      window.bodyLength = body.length + "return f7;".length;
      window.compile = () => { window.made = new Function(body + "return f7;"); };
      window.runOne = () => window.made()(1);
    </script>`,
  );
  const bodyLength = await page.evaluate(() => Number(Reflect.get(globalThis, "bodyLength")));
  const before = await boaCode(page);
  await page.evaluate(() => {
    const compile: unknown = Reflect.get(globalThis, "compile");
    if (typeof compile !== "function") throw new Error("missing compile");
    compile();
  });
  const compiled = await boaCode(page);
  // The function and its 200 declarations, plus the few blocks the evaluate itself
  // compiles, which is why the bounds are loose.
  expect(compiled.blocks - before.blocks).toBeGreaterThanOrEqual(FUNCTIONS + 1);
  expect(compiled.blocks - before.blocks).toBeLessThan(FUNCTIONS + 50);
  expect(compiled.sourceBytes - before.sourceBytes).toBeGreaterThanOrEqual(bodyLength);
  expect(compiled.packedBytes - before.packedBytes).toBeGreaterThan(0);
  expect(compiled.sourceMapBytes - before.sourceMapBytes).toBeGreaterThan(0);
  expect(compiled.otherBytes - before.otherBytes).toBeGreaterThan(0);

  const got = await page.evaluate(() => {
    const runOne: unknown = Reflect.get(globalThis, "runOne");
    if (typeof runOne !== "function") throw new Error("missing runOne");
    return runOne();
  });
  expect(got).toBe(8);
  const ran = await boaCode(page);
  // The anonymous function and f7 ran; the other 199 stay packed, so most of the
  // body's bytecode is still in its compact form.
  expect(ran.blocksRun - compiled.blocksRun).toBeGreaterThanOrEqual(2);
  expect(ran.blocksRun - compiled.blocksRun).toBeLessThan(50);
  expect(ran.expandedBytes - compiled.expandedBytes).toBeGreaterThan(0);
});
