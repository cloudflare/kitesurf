// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Stateful sessions (src/stateful.ts): POST /devtools/browser creates a browser in its own
// Durable Object, and CDP clients connect to /devtools/browser/<sessionId>, at once or one after
// another. The browser outlives a disconnect, its data lives in the object's SQLite, and each
// page runs in a facet.

import { env } from "cloudflare:test";
import type { Browser, Page } from "@cloudflare/puppeteer";
import { expect, test } from "vitest";

import {
  connectEngine,
  connectPath,
  connectStatefulSession,
  createStatefulSession,
  targetIdForSession,
  upgradedSocket,
} from "./connect";
import { setContent } from "./set-content";

const engine = env.ENGINE;

interface RawMessage {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string };
}

// A raw CDP socket, as the DevTools frontend is on a page endpoint. Puppeteer finds no pages
// in page mode.
async function rawCdp(path: string) {
  const resp = await engine.fetch(`https://ks.invalid${path}`, {
    headers: { Upgrade: "websocket" },
  });
  const ws = upgradedSocket(resp);
  if (!ws) throw new Error(`no webSocket on ${path} (status ${resp.status})`);
  ws.accept();
  const events: RawMessage[] = [];
  const waiting = new Map<number, (m: RawMessage) => void>();
  let closed = false;
  ws.addEventListener("message", (ev: { data: string | ArrayBuffer }) => {
    const m = JSON.parse(String(ev.data)) as RawMessage;
    const resolve = typeof m.id === "number" ? waiting.get(m.id) : undefined;
    if (resolve && typeof m.id === "number") {
      waiting.delete(m.id);
      resolve(m);
    } else {
      events.push(m);
    }
  });
  ws.addEventListener("close", () => {
    closed = true;
  });
  let next = 1;
  return {
    events,
    isClosed: () => closed,
    send(method: string, params: Record<string, unknown> = {}): Promise<RawMessage> {
      const id = next++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve) => waiting.set(id, resolve));
    },
    close: () => ws.close(),
  };
}

async function onlyPage(browser: Browser): Promise<Page> {
  const pages = await browser.pages();
  expect(pages).toHaveLength(1);
  const page = pages[0];
  if (!page) throw new Error("no page");
  return page;
}

async function status(path: string): Promise<number> {
  const resp = await engine.fetch(`https://ks.invalid${path}`);
  await resp.body?.cancel();
  return resp.status;
}

test("POST /devtools/browser returns a session id, its endpoint and its page", async () => {
  const created = await createStatefulSession(engine);
  expect(created.sessionId).toMatch(/^[0-9a-f]{64}$/);
  expect(created.webSocketDebuggerUrl).toBe(
    `wss://ks.invalid/devtools/browser/${created.sessionId}`,
  );
  const browser = await connectStatefulSession(engine, created.sessionId);
  try {
    const page = await onlyPage(browser);
    expect(await targetIdForSession(await page.createCDPSession())).toBe(created.pageTargetId);
  } finally {
    await browser.close();
  }
});

test("the browser keeps its document and page JS state across a disconnect", async () => {
  const { sessionId } = await createStatefulSession(engine);
  const first = await connectStatefulSession(engine, sessionId);
  const page = await onlyPage(first);
  await setContent(page, "<title>kept</title><p id=p>hello</p>");
  await page.evaluate(() => {
    Object.assign(globalThis, { counter: 41 });
  });
  await first.disconnect();

  const second = await connectStatefulSession(engine, sessionId);
  try {
    const again = await onlyPage(second);
    expect(await again.title()).toBe("kept");
    expect(await again.$eval("#p", (el) => el.textContent)).toBe("hello");
    expect(await again.evaluate(() => Reflect.get(globalThis, "counter"))).toBe(41);
  } finally {
    await second.close();
  }
});

test("two clients drive one page, and each hears its own events once", async () => {
  const { sessionId } = await createStatefulSession(engine);
  const a = await connectStatefulSession(engine, sessionId);
  const b = await connectStatefulSession(engine, sessionId);
  try {
    const pageA = await onlyPage(a);
    const pageB = await onlyPage(b);
    const heardA: string[] = [];
    const heardB: string[] = [];
    pageA.on("console", (m) => heardA.push(m.text()));
    pageB.on("console", (m) => heardB.push(m.text()));

    await setContent(pageA, "<title>shared</title>");
    expect(await pageB.evaluate(() => document.title)).toBe("shared");
    await pageA.evaluate(() => console.log("from-page"));
    await expect
      .poll(() => heardA.includes("from-page") && heardB.includes("from-page"))
      .toBe(true);
    expect(heardA.filter((t) => t === "from-page")).toHaveLength(1);
    expect(heardB.filter((t) => t === "from-page")).toHaveLength(1);

    // A leaving client takes neither the browser nor the other client's sessions with it.
    await a.disconnect();
    expect(await pageB.evaluate(() => document.title)).toBe("shared");
  } finally {
    await b.close();
  }
});

test("response bodies live in the object's SQLite, past the in-memory limit", async () => {
  // 512 KiB of JSON is charged 1 MiB: past what a session on the heap keeps per body, and well
  // under what the SQLite store keeps.
  const url = "https://ks.invalid/__fixtures/chatty-json?bytes=524288&seed=7";
  const bodyLength = async (browser: Browser): Promise<number> => {
    const page = await onlyPage(browser);
    await page.goto("https://ks.invalid/__fixtures/lifecycle.html", {
      waitUntil: "domcontentloaded",
    });
    const cdp = await page.createCDPSession();
    await cdp.send("Network.enable");
    const finished = new Promise<string>((resolve) =>
      cdp.on("Network.loadingFinished", (ev) => resolve(ev.requestId)),
    );
    await page.evaluate((u) => fetch(u).then((r) => r.text()), url);
    const requestId = await finished;
    return cdp
      .send("Network.getResponseBody", { requestId })
      .then((r) => r.body.length)
      .catch(() => 0);
  };

  const stateless = await connectEngine(engine);
  try {
    expect(await bodyLength(stateless)).toBe(0);
  } finally {
    await stateless.close();
  }
  const { sessionId } = await createStatefulSession(engine);
  const stateful = await connectStatefulSession(engine, sessionId);
  try {
    expect(await bodyLength(stateful)).toBe(524288);
  } finally {
    await stateful.close();
  }
});

test("cookies and localStorage outlive the client that wrote them", async () => {
  const { sessionId } = await createStatefulSession(engine);
  const first = await connectStatefulSession(engine, sessionId);
  const page = await onlyPage(first);
  await page.goto("https://ks.invalid/__fixtures/lifecycle.html", { waitUntil: "load" });
  await page.evaluate(() => {
    document.cookie = "kept=1; path=/";
    localStorage.setItem("kept", "yes");
  });
  await first.disconnect();

  const second = await connectStatefulSession(engine, sessionId);
  try {
    const again = await onlyPage(second);
    await again.reload({ waitUntil: "load" });
    expect(await again.evaluate(() => document.cookie)).toContain("kept=1");
    expect(await again.evaluate(() => localStorage.getItem("kept"))).toBe("yes");
  } finally {
    await second.close();
  }
});

test("sessionStorage outlives navigates and reconnects, per page and origin", async () => {
  const { sessionId } = await createStatefulSession(engine);
  const first = await connectStatefulSession(engine, sessionId);
  const page = await onlyPage(first);
  await page.goto("https://ks.invalid/__fixtures/lifecycle.html", { waitUntil: "load" });
  await page.evaluate(() => sessionStorage.setItem("tab", "kept"));
  await page.goto("https://ks.invalid/__fixtures/image-paint.html", { waitUntil: "load" });
  expect(await page.evaluate(() => sessionStorage.getItem("tab"))).toBe("kept");
  await first.disconnect();

  const second = await connectStatefulSession(engine, sessionId);
  try {
    const again = await onlyPage(second);
    await again.reload({ waitUntil: "load" });
    expect(await again.evaluate(() => sessionStorage.getItem("tab"))).toBe("kept");
    // A new page starts empty, as a new tab does.
    const other = await second.newPage();
    await other.goto("https://ks.invalid/__fixtures/lifecycle.html", { waitUntil: "load" });
    expect(await other.evaluate(() => sessionStorage.getItem("tab"))).toBeNull();
  } finally {
    await second.close();
  }
});

test("a page WebSocket reaches the session through its object", async () => {
  const { sessionId } = await createStatefulSession(engine);
  const browser = await connectStatefulSession(engine, sessionId);
  try {
    const page = await onlyPage(browser);
    await page.goto("https://ks.invalid/__fixtures/lifecycle.html", { waitUntil: "load" });
    const echoed = await page.evaluate(
      () =>
        new Promise<string>((resolve, reject) => {
          const ws = new WebSocket("wss://" + location.host + "/__fixtures/ws-echo");
          ws.onopen = () => ws.send("ping-through-object");
          ws.onmessage = (e) => {
            resolve(String(e.data));
            ws.close();
          };
          ws.onerror = () => reject(new Error("ws error"));
        }),
    );
    expect(echoed).toContain("ping-through-object");
  } finally {
    await browser.close();
  }
});

test("GET /json lists the session's pages with their page endpoints", async () => {
  const { sessionId, pageTargetId } = await createStatefulSession(engine);
  const resp = await engine.fetch(`https://ks.invalid/devtools/browser/${sessionId}/json`);
  const list: unknown = await resp.json();
  const endpoint = `ks.invalid/devtools/browser/${sessionId}/page/${pageTargetId}`;
  expect(list).toEqual([
    expect.objectContaining({
      id: pageTargetId,
      type: "page",
      webSocketDebuggerUrl: `wss://${endpoint}`,
      devtoolsFrontendUrl: expect.stringContaining(encodeURIComponent(endpoint)),
    }),
  ]);
  const browser = await connectStatefulSession(engine, sessionId);
  await browser.close();
});

test("a page endpoint drives its own page, and a reconnect does not reload it", async () => {
  const { sessionId, pageTargetId } = await createStatefulSession(engine);
  const browser = await connectStatefulSession(engine, sessionId);
  try {
    const first = await onlyPage(browser);
    await setContent(first, "<title>first</title>");
    const second = await browser.newPage();
    await setContent(second, "<title>second</title>");

    const path = `/devtools/browser/${sessionId}/page/${pageTargetId}`;
    const raw = await rawCdp(`${path}?initialUrl=https://ks.invalid/__fixtures/lifecycle.html`);
    const title = await raw.send("Runtime.evaluate", { expression: "document.title" });
    expect(title.sessionId).toBeUndefined();
    expect(title.result).toMatchObject({ result: { value: "first" } });
    raw.close();
  } finally {
    await browser.close();
  }
});

test("a page endpoint for an unknown target is a 404", async () => {
  const { sessionId } = await createStatefulSession(engine);
  const resp = await engine.fetch(
    `https://ks.invalid/devtools/browser/${sessionId}/page/${"0".repeat(32)}`,
    { headers: { Upgrade: "websocket" } },
  );
  expect(resp.status).toBe(404);
  const browser = await connectStatefulSession(engine, sessionId);
  await browser.close();
});

test("Browser.close ends the session", async () => {
  const { sessionId } = await createStatefulSession(engine);
  const browser = await connectStatefulSession(engine, sessionId);
  await browser.close();
  expect(await status(`/devtools/browser/${sessionId}/json`)).toBe(404);
});

test("the session ends when keep_alive runs out with no client", async () => {
  const { sessionId } = await createStatefulSession(engine, "?keep_alive=10000");
  const browser = await connectStatefulSession(engine, sessionId);
  await browser.disconnect();
  expect(await status(`/devtools/browser/${sessionId}/json`)).toBe(200);
  await expect
    .poll(() => status(`/devtools/browser/${sessionId}/json`), { timeout: 60_000, interval: 1_000 })
    .toBe(404);
});

test("an id that the namespace did not mint stays a stateless connection", async () => {
  const browser = await connectPath(engine, `/devtools/browser/${"a".repeat(64)}`);
  try {
    expect(await browser.pages()).toHaveLength(1);
  } finally {
    await browser.close();
  }
});
