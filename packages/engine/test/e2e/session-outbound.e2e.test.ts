// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

const PAGE = "http://127.0.0.1:8787/__fixtures/xhr-boot.html";

test("a page fetch with a live signal still completes", async ({ page }) => {
  await page.goto(PAGE, { waitUntil: "domcontentloaded", timeout: 30000 });
  const got = await page.evaluate(`(async () => {
    const ctrl = new AbortController();
    const res = await fetch("/__fixtures/slow-red.png?ms=0", { signal: ctrl.signal });
    return { status: res.status, bytes: (await res.arrayBuffer()).byteLength };
  })()`);
  expect(got).toMatchObject({ status: 200 });
  expect((got as { bytes: number }).bytes).toBeGreaterThan(0);
});

test("aborting a page fetch mid-flight rejects with AbortError", async ({ page }) => {
  await page.goto(PAGE, { waitUntil: "domcontentloaded", timeout: 30000 });
  const got = await page.evaluate(`(async () => {
    const ctrl = new AbortController();
    const p = fetch("/__fixtures/slow-headers-red.png?ms=5000", { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 50);
    try {
      await p;
      return "resolved";
    } catch (e) {
      return e && e.name;
    }
  })()`);
  expect(got).toBe("AbortError");
});

test.for(["synchronously", "next microtask"] as const)(
  "aborting a page fetch %s rejects with AbortError",
  async (timing, { page }) => {
    await page.goto(PAGE, { waitUntil: "domcontentloaded" });
    const got = await page.evaluate((when) => {
      const controller = new AbortController();
      const request = fetch("/__fixtures/echo-headers.json", { signal: controller.signal });
      if (when === "next microtask") queueMicrotask(() => controller.abort());
      else controller.abort();
      return request.then(
        () => "resolved",
        (error: unknown) => {
          if (typeof error !== "object" || error === null) return String(error);
          return "name" in error ? String(error.name) : String(error);
        },
      );
    }, timing);
    expect(got).toBe("AbortError");
  },
);

test.for([
  { code: undefined, reason: undefined, expectedCode: 1000, expectedReason: "" },
  { code: 1000, reason: "finished", expectedCode: 1000, expectedReason: "finished" },
  {
    code: 4001,
    reason: "application shutdown",
    expectedCode: 4001,
    expectedReason: "application shutdown",
  },
])(
  "a page WebSocket closes with code $expectedCode and reason '$expectedReason'",
  async ({ code, reason, expectedCode, expectedReason }, { page }) => {
    await page.goto(PAGE, { waitUntil: "domcontentloaded" });
    const got = await page.evaluate(
      async (options) => {
        const socket = new WebSocket("ws://" + location.host + "/__fixtures/ws-echo");
        try {
          return await new Promise<{ code: number; reason: string }>((resolve, reject) => {
            socket.onopen = () => socket.close(options.code, options.reason);
            socket.onclose = (event) => resolve({ code: event.code, reason: event.reason });
            socket.onerror = () => reject(new Error("WebSocket fixture failed to open"));
          });
        } finally {
          socket.close();
        }
      },
      { code, reason },
    );
    expect(got).toEqual({ code: expectedCode, reason: expectedReason });
  },
);

test("a page fetch keeps Response.url", async ({ page }) => {
  await page.goto(PAGE, { waitUntil: "domcontentloaded", timeout: 30000 });
  const got = await page.evaluate(`(async () => {
    const res = await fetch("/__fixtures/slow-red.png?ms=0");
    await res.arrayBuffer();
    return { url: res.url, redirected: res.redirected };
  })()`);
  expect(got).toEqual({
    url: "http://127.0.0.1:8787/__fixtures/slow-red.png?ms=0",
    redirected: false,
  });
});

test("a data: fetch resolves without the gateway", async ({ page }) => {
  await page.goto(PAGE, { waitUntil: "domcontentloaded", timeout: 30000 });
  const got = await page.evaluate(`(async () => {
    const res = await fetch("data:text/plain,hello");
    return await res.text();
  })()`);
  expect(got).toBe("hello");
});

test("a page POST keeps its Content-Length", async ({ page }) => {
  await page.goto(PAGE, { waitUntil: "domcontentloaded", timeout: 30000 });
  const got = await page.evaluate(`(async () => {
    const res = await fetch("/__fixtures/echo-headers.json", {
      method: "POST",
      body: "Request's body",
    });
    return (await res.json())["content-length"] ?? null;
  })()`);
  expect(got).toBe("14");
});

test("the cache mode reaches the origin as headers", async ({ page }) => {
  await page.goto(PAGE, { waitUntil: "domcontentloaded", timeout: 30000 });
  const got = await page.evaluate(`(async () => {
    const echo = async (cache) => {
      const res = await fetch("/__fixtures/echo-headers.json", { cache });
      const h = await res.json();
      return [h["cache-control"] ?? null, h["pragma"] ?? null];
    };
    return { noStore: await echo("no-store"), noCache: await echo("no-cache") };
  })()`);
  expect(got).toEqual({
    noStore: ["no-cache", "no-cache"],
    noCache: ["max-age=0", null],
  });
});

test("a fetched Response has immutable headers and no url fragment", async ({ page }) => {
  await page.goto(PAGE, { waitUntil: "domcontentloaded", timeout: 30000 });
  const got = await page.evaluate(`(async () => {
    const res = await fetch("/__fixtures/slow-red.png?ms=0#frag");
    await res.arrayBuffer();
    let append;
    try {
      res.headers.append("x-page", "1");
      append = "allowed";
    } catch (e) {
      append = e && e.name;
    }
    return { url: res.url, append };
  })()`);
  expect(got).toEqual({
    url: "http://127.0.0.1:8787/__fixtures/slow-red.png?ms=0",
    append: "TypeError",
  });
});
