// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Kitesurf.setStorageState: load playwright's storageState file into a browser context
// (state/storage-state.ts).
import type { CDPSession, Page } from "@cloudflare/puppeteer";
import { expect, test } from "./harness";

const A = "https://ks.invalid/__fixtures/lifecycle.html";
const OTHER = "https://ks-other.invalid/__fixtures/lifecycle.html";

const STATE = {
  cookies: [
    {
      name: "sid",
      value: "abc",
      domain: "ks.invalid",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: "Lax" as const,
    },
    {
      name: "pref",
      value: "dark",
      domain: "ks.invalid",
      path: "/",
      expires: 4102444800,
      httpOnly: false,
      secure: false,
      sameSite: "Strict" as const,
    },
  ],
  origins: [{ origin: "https://ks.invalid", localStorage: [{ name: "token", value: "t1" }] }],
};

const read = (p: Page) =>
  p.evaluate(() => {
    const out: Record<string, string | null> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k !== null) out[k] = localStorage.getItem(k);
    }
    return out;
  });

const cookies = async (cdp: CDPSession, browserContextId?: string) =>
  (await cdp.send("Storage.getCookies", { browserContextId })).cookies
    .map((c) => `${c.name}=${c.value}`)
    .sort();

test("setStorageState replaces the context's cookies and localStorage", async ({
  page,
  cdpSession,
}) => {
  await page.goto(OTHER, { waitUntil: "load" });
  await page.evaluate(() => localStorage.setItem("stale", "other"));
  await page.goto(A, { waitUntil: "load" });
  await page.evaluate(() => {
    localStorage.setItem("old", "1");
    document.cookie = "old=1; path=/";
  });
  // Let the page's batched localStorage write reach the engine.
  await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));

  await cdpSession.send("Kitesurf.setStorageState", { storageState: STATE });
  expect(await cookies(cdpSession)).toEqual(["pref=dark", "sid=abc"]);
  // The file's expires is Unix seconds, and -1 is a session cookie.
  const jar = (await cdpSession.send("Storage.getCookies", {})).cookies;
  expect(jar.map(({ name, expires, session }) => ({ name, expires, session }))).toEqual(
    expect.arrayContaining([
      { name: "sid", expires: -1, session: true },
      { name: "pref", expires: 4102444800, session: false },
    ]),
  );
  await page.reload({ waitUntil: "load" });
  // sid is HttpOnly, so only pref shows.
  expect(await page.evaluate(() => document.cookie)).toBe("pref=dark");
  expect(await read(page)).toEqual({ token: "t1" });
  await page.goto(OTHER, { waitUntil: "load" });
  expect(await read(page)).toEqual({});
}, 120_000);

test("an open document gets the new localStorage without a storage event", async ({
  page,
  cdpSession,
}) => {
  await page.goto(A, { waitUntil: "load" });
  await page.evaluate(() => {
    localStorage.setItem("old", "1");
    const events: unknown[] = [];
    Reflect.set(window, "__events", events);
    addEventListener("storage", (e) => events.push(e.key));
  });
  await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
  await cdpSession.send("Kitesurf.setStorageState", { storageState: STATE });
  expect(await read(page)).toEqual({ token: "t1" });
  expect(await page.evaluate(() => Reflect.get(window, "__events"))).toEqual([]);
}, 120_000);

test("an open document gets an area too large for one message", async ({ page, cdpSession }) => {
  await page.goto(A, { waitUntil: "load" });
  const count = 200_000;
  const localStorage = Array.from({ length: count }, (_, i) => ({ name: `k${i}`, value: "v" }));
  await cdpSession.send("Kitesurf.setStorageState", {
    storageState: { origins: [{ origin: "https://ks.invalid", localStorage }] },
  });
  expect(
    await page.evaluate(() => [window.localStorage.length, window.localStorage.getItem("k199999")]),
  ).toEqual([count, "v"]);
}, 120_000);

test("setStorageState is per browser context", async ({ browser, page, cdpSession }) => {
  // The default context holds its own state first, so a command that wrote to every context
  // would wipe it.
  await page.goto(A, { waitUntil: "load" });
  await page.evaluate(() => {
    localStorage.setItem("mine", "default");
    document.cookie = "own=1; path=/";
  });
  await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
  await page.reload({ waitUntil: "load" });
  expect(await read(page)).toEqual({ mine: "default" });
  const context = await browser.createBrowserContext();
  try {
    const browserContextId = context.id;
    await cdpSession.send("Kitesurf.setStorageState", { storageState: STATE, browserContextId });
    expect(await cookies(cdpSession, browserContextId)).toEqual(["pref=dark", "sid=abc"]);
    expect(await cookies(cdpSession)).toEqual(["own=1"]);
    const other = await context.newPage();
    await other.goto(A, { waitUntil: "load" });
    await page.reload({ waitUntil: "load" });
    expect(await read(other)).toEqual({ token: "t1" });
    expect(await read(page)).toEqual({ mine: "default" });
  } finally {
    await context.close();
  }
}, 120_000);

test("a bad storageState or context id is refused and changes nothing", async ({
  page,
  cdpSession,
}) => {
  await cdpSession.send("Kitesurf.setStorageState", { storageState: STATE });
  await expect(
    cdpSession.send("Kitesurf.setStorageState", {
      storageState: { cookies: [{ name: "a", value: "b" }] },
    }),
  ).rejects.toThrow(/storageState\.cookies\[0\]: needs a url, or a domain and a path/);
  await expect(
    cdpSession.send("Kitesurf.setStorageState", {
      storageState: { cookies: [] },
      browserContextId: "ctx-nope",
    }),
  ).rejects.toThrow(/Failed to find browser context with id ctx-nope/);
  expect(await cookies(cdpSession)).toEqual(["pref=dark", "sid=abc"]);
  await page.goto(A, { waitUntil: "load" });
  expect(await read(page)).toEqual({ token: "t1" });
}, 120_000);
