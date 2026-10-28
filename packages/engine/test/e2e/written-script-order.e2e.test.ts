// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// document.write'd scripts are parser-inserted: they run in write order, not
// fetch-completion order, and DOMContentLoaded waits for them. Pre-ES6
// loaders such as tdl.js write one script per module and depend on both.
import type { Page } from "@cloudflare/puppeteer";
import { expect, test } from "./harness";

const ORIGIN = "http://127.0.0.1:8787";

const written = (query: string) =>
  `<script src="/__fixtures/written-script.js?${query}"><\\/script>`;

// The page records the order at DCL. Reading it later would pass even if the
// scripts ran after DCL.
async function orderAtDcl(page: Page, writes: string): Promise<{ atDcl: string; all: string }> {
  const u = new URL(`${ORIGIN}/__fixtures/policy-doc.html`);
  u.searchParams.set(
    "body",
    `<script>
  globalThis.__written = [];
  document.addEventListener("DOMContentLoaded", function () {
    globalThis.__atDcl = globalThis.__written.join(",");
  });
  document.write('${writes}');
</script>`,
  );
  await page.goto(u.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
  const read = () =>
    page.evaluate(() => {
      const atDcl: unknown = Reflect.get(globalThis, "__atDcl");
      const all: unknown = Reflect.get(globalThis, "__written");
      return {
        atDcl: typeof atDcl === "string" ? atDcl : "",
        all: Array.isArray(all) ? all.join(",") : "",
      };
    });
  await expect.poll(async () => (await read()).atDcl, { timeout: 30_000 }).not.toBe("");
  return read();
}

test("a slow written script still runs before the one written after it", async ({ page }) => {
  const order = await orderAtDcl(page, written("tag=a&ms=800") + written("tag=b"));
  expect(order).toEqual({ atDcl: "a,b", all: "a,b" });
});

test("an inline written script waits for the external one written before it", async ({ page }) => {
  const inline = `<script>globalThis.__written.push("inline")<\\/script>`;
  const order = await orderAtDcl(page, written("tag=a&ms=500") + inline);
  expect(order).toEqual({ atDcl: "a,inline", all: "a,inline" });
});

test("an inline script that a written script writes runs inside its document.write", async ({
  page,
}) => {
  const order = await orderAtDcl(page, written("tag=a&inline=i"));
  expect(order).toEqual({ atDcl: "a,i,a-after", all: "a,i,a-after" });
});

test("an inline script waits for an external script its writer wrote first", async ({ page }) => {
  const order = await orderAtDcl(page, written("tag=a&next=b&inline=i"));
  expect(order).toEqual({ atDcl: "a,a-after,b,i", all: "a,a-after,b,i" });
});

test("scripts a written script writes run before DOMContentLoaded", async ({ page }) => {
  const order = await orderAtDcl(page, written("tag=a&next=b"));
  expect(order).toEqual({ atDcl: "a,b", all: "a,b" });
});
