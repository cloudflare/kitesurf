// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

const TOP = "https://ks.invalid/__fixtures/lifecycle.html";
const FRAME_ORIGIN = "https://ks-other.invalid";

test("a cross-site iframe's document request sends only SameSite=None cookies", async ({
  page,
  cdpSession,
}) => {
  for (const [name, sameSite] of [
    ["strict", "Strict"],
    ["lax", "Lax"],
    ["none", "None"],
  ] as const) {
    await cdpSession.send("Network.setCookie", {
      name,
      value: "1",
      domain: "ks-other.invalid",
      path: "/",
      secure: true,
      sameSite,
    });
  }
  const contexts: number[] = [];
  cdpSession.on("Runtime.executionContextCreated", (e) => {
    if (e.context.origin === FRAME_ORIGIN) contexts.push(e.context.id);
  });
  await cdpSession.send("Runtime.enable");
  await page.goto(TOP, { waitUntil: "load" });
  await page.evaluate((src) => {
    const f = document.createElement("iframe");
    f.src = src;
    document.body.appendChild(f);
  }, `${FRAME_ORIGIN}/__fixtures/echo-headers.json`);
  await expect.poll(() => contexts.length, { timeout: 15_000 }).toBeGreaterThan(0);
  const readCookies = async () => {
    const r = await cdpSession.send("Runtime.evaluate", {
      contextId: contexts[0],
      expression: "document.body ? document.body.textContent : ''",
      returnByValue: true,
    });
    const text = String(r.result.value ?? "");
    return text ? ((JSON.parse(text) as { cookie?: string }).cookie ?? "") : null;
  };
  await expect.poll(readCookies, { timeout: 15_000 }).not.toBeNull();
  expect(await readCookies()).toBe("none=1");
}, 60_000);
