// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// An infinite CSS animation makes every resolve re-cascade the animated
// element, so the engine's own pollers must not resolve just because the
// clock moved. Counted through Kitesurf.getMemoryStats' layout block.
import type { Page } from "@cloudflare/puppeteer";
import { expect, test } from "./harness";
import { setContent } from "./set-content";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function resolveCounts(page: Page): Promise<{ mutation: number; animation: number }> {
  const session = await page.createCDPSession();
  const targetId: unknown = Reflect.get(page.target(), "_targetId");
  if (typeof targetId !== "string") throw new Error("puppeteer target has no _targetId");
  const stats = await session.send("Kitesurf.getMemoryStats", { targetId });
  await session.detach().catch(() => {});
  const layout = stats.layout;
  if (!layout) throw new Error(`no layout block in ${JSON.stringify(stats).slice(0, 200)}`);
  return { mutation: layout.mutationResolves, animation: layout.animationResolves };
}

async function resolvesOver(page: Page, ms: number): Promise<number> {
  const before = await resolveCounts(page);
  await sleep(ms);
  const after = await resolveCounts(page);
  return after.mutation - before.mutation + after.animation - before.animation;
}

const SPIN = `@keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
  #spin { width: 20px; height: 20px; animation: spin 400ms linear infinite }`;

test("a page that mutates nonstop does not pull the animation drain to frame rate", async ({
  page,
}) => {
  await setContent(
    page,
    `<style>${SPIN}</style><div id="spin"></div><div id="out"></div><script>
      globalThis.__iterations = 0;
      document.addEventListener("animationiteration", () => { globalThis.__iterations++; });
      let n = 0;
      setInterval(() => { document.getElementById("out").setAttribute("data-n", String(n++)); }, 8);
    </script>`,
  );
  await sleep(300);
  const iterationsBefore = await page.evaluate(
    () => Reflect.get(globalThis, "__iterations") as number,
  );
  // The old drain ran ~90 resolves in this window. One that discovers the
  // mutations within a few frames and keeps its keyframe backoff runs ~25.
  const resolves = await resolvesOver(page, 1500);
  expect(resolves).toBeLessThan(45);
  // The drain still samples the animation: a 400 ms loop iterates in 1.5 s.
  const iterations = await page.evaluate(() => Reflect.get(globalThis, "__iterations") as number);
  expect(iterations - iterationsBefore).toBeGreaterThanOrEqual(2);
});
