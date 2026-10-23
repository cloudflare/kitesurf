// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Protocol } from "devtools-protocol";

import { expect, test } from "./harness";

function cookieValue(
  cookies: Array<{ name: string; value: string }>,
  name: string,
): string | undefined {
  return cookies.find((cookie) => cookie.name === name)?.value;
}

test("browser contexts isolate cookies (CDP + subresource fetch)", async ({ browser }) => {
  const c1 = await browser.createBrowserContext();
  const c2 = await browser.createBrowserContext();
  expect(c1.id).not.toBe(c2.id);

  const p1 = await c1.newPage();
  await p1.goto("https://ks.invalid/__fixtures/lifecycle.html", {
    waitUntil: "domcontentloaded",
  });
  const cdp1 = await p1.createCDPSession();
  await cdp1.send("Storage.setCookies", {
    browserContextId: c1.id,
    cookies: [{ name: "who", value: "ctx1", domain: "ks.invalid", path: "/" }],
  });

  const p2 = await c2.newPage();
  await p2.goto("https://ks.invalid/__fixtures/lifecycle.html", {
    waitUntil: "domcontentloaded",
  });
  const cdp2 = await p2.createCDPSession();
  await cdp2.send("Storage.setCookies", {
    browserContextId: c2.id,
    cookies: [{ name: "who", value: "ctx2", domain: "ks.invalid", path: "/" }],
  });

  const got1 = (await cdp1.send("Storage.getCookies", {
    browserContextId: c1.id,
  })) as { cookies: Array<{ name: string; value: string }> };
  const got2 = (await cdp2.send("Storage.getCookies", {
    browserContextId: c2.id,
  })) as { cookies: Array<{ name: string; value: string }> };
  expect(cookieValue(got1.cookies, "who")).toBe("ctx1");
  expect(cookieValue(got2.cookies, "who")).toBe("ctx2");

  const echo1 = await p1.evaluate(`
    fetch("/__fixtures/echo-headers.json").then((r) => r.json())
  `);
  const echo2 = await p2.evaluate(`
    fetch("/__fixtures/echo-headers.json").then((r) => r.json())
  `);
  expect((echo1 as { cookie?: string }).cookie).toContain("who=ctx1");
  expect((echo2 as { cookie?: string }).cookie).toContain("who=ctx2");

  await cdp1.send("Network.setCookie", {
    name: "network",
    value: "ctx1",
    url: "https://ks.invalid/",
  });
  await cdp2.send("Network.setCookie", {
    name: "network",
    value: "ctx2",
    url: "https://ks.invalid/",
  });
  const network1 = (await cdp1.send("Network.getCookies")) as {
    cookies: Array<{ name: string; value: string }>;
  };
  const network2 = (await cdp2.send("Network.getCookies")) as {
    cookies: Array<{ name: string; value: string }>;
  };
  expect(cookieValue(network1.cookies, "network")).toBe("ctx1");
  expect(cookieValue(network2.cookies, "network")).toBe("ctx2");

  await cdp1.send("Network.clearBrowserCookies");
  const afterClear1 = (await cdp1.send("Storage.getCookies", {
    browserContextId: c1.id,
  })) as { cookies: Array<{ name: string }> };
  const afterClear2 = (await cdp2.send("Storage.getCookies", {
    browserContextId: c2.id,
  })) as { cookies: Array<{ name: string; value: string }> };
  expect(afterClear1.cookies.find((c) => c.name === "network")).toBeUndefined();
  expect(cookieValue(afterClear2.cookies, "network")).toBe("ctx2");
}, 120_000);

test("Network events retain their target attribution while a sibling navigates", async ({
  browser,
}) => {
  const c1 = await browser.createBrowserContext();
  const c2 = await browser.createBrowserContext();
  const p1 = await c1.newPage();
  const p2 = await c2.newPage();
  const cdp1 = await p1.createCDPSession();
  const cdp2 = await p2.createCDPSession();
  const requests1: Protocol.Network.RequestWillBeSentEvent[] = [];
  const responses1: Protocol.Network.ResponseReceivedEvent[] = [];
  const responses2: Protocol.Network.ResponseReceivedEvent[] = [];
  cdp1.on("Network.requestWillBeSent", (event) => requests1.push(event));
  cdp1.on("Network.responseReceived", (event) => responses1.push(event));
  cdp2.on("Network.responseReceived", (event) => responses2.push(event));
  await Promise.all([cdp1.send("Network.enable"), cdp2.send("Network.enable")]);
  await Promise.all([
    p1.goto("https://ks.invalid/__fixtures/lifecycle.html", {
      waitUntil: "domcontentloaded",
    }),
    p2.goto("https://ks.invalid/__fixtures/lifecycle.html", {
      waitUntil: "domcontentloaded",
    }),
  ]);

  const marker = crypto.randomUUID();
  const slowUrl = `https://ks.invalid/__fixtures/slow-headers-red.png?ms=300&scope=${marker}`;
  const fetchOnFirst = p1.evaluate(
    `fetch(${JSON.stringify(slowUrl)}).then((response) => response.arrayBuffer()).then((body) => body.byteLength)`,
  );
  await expect
    .poll(() => requests1.find((event) => event.request.url === slowUrl), { timeout: 10_000 })
    .toBeDefined();
  const request = requests1.find((event) => event.request.url === slowUrl)!;

  await p2.goto(`https://ks.invalid/__fixtures/lifecycle.html?scope=${marker}`, {
    waitUntil: "domcontentloaded",
  });
  await fetchOnFirst;
  await expect
    .poll(() => responses1.find((event) => event.response.url === slowUrl), { timeout: 10_000 })
    .toBeDefined();

  const response = responses1.find((event) => event.response.url === slowUrl)!;
  expect(response.frameId).toBe(request.frameId);
  expect(response.loaderId).toBe(request.loaderId);
  expect(responses2.find((event) => event.response.url === slowUrl)).toBeUndefined();
}, 120_000);

test("pre-navigate fetches route to the owning context's jar", async ({ browser }) => {
  const c1 = await browser.createBrowserContext();
  const c2 = await browser.createBrowserContext();
  const p1 = await c1.newPage();
  const cdp1 = await p1.createCDPSession();
  await cdp1.send("Storage.setCookies", {
    browserContextId: c1.id,
    cookies: [
      {
        name: "who",
        value: "ctx1",
        domain: "ks.invalid",
        path: "/",
        secure: true,
        sameSite: "None" as const,
      },
    ],
  });
  const p2 = await c2.newPage();
  const cdp2 = await p2.createCDPSession();
  await cdp2.send("Storage.setCookies", {
    browserContextId: c2.id,
    cookies: [
      {
        name: "who",
        value: "ctx2",
        domain: "ks.invalid",
        path: "/",
        secure: true,
        sameSite: "None" as const,
      },
    ],
  });
  const echo = (await p1.evaluate(`
    fetch("https://ks.invalid/__fixtures/echo-headers.json", { credentials: "include" }).then((r) => r.json())
  `)) as { cookie?: string };
  expect(echo.cookie ?? "").toContain("who=ctx1");
  expect(echo.cookie ?? "").not.toContain("ctx2");
}, 120_000);

test("disposeBrowserContext closes its pages and drops the jar", async ({ browser }) => {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.goto("https://ks.invalid/__fixtures/lifecycle.html", {
    waitUntil: "domcontentloaded",
  });
  expect(page.isClosed()).toBe(false);
  await ctx.close();
  expect(page.isClosed()).toBe(true);
}, 120_000);

test("Storage cookies on an unknown browserContextId rejects, not the default jar", async ({
  cdpSession,
}) => {
  await expect(
    cdpSession.send("Storage.getCookies", { browserContextId: "ctx-nonexistent" }),
  ).rejects.toThrow(/browser context/i);
  await expect(
    cdpSession.send("Storage.setCookies", {
      browserContextId: "ctx-nonexistent",
      cookies: [{ name: "x", value: "y", domain: "ks.invalid", path: "/" }],
    }),
  ).rejects.toThrow(/browser context/i);
}, 120_000);
