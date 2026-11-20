// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { CDPSession, Page } from "@cloudflare/puppeteer";
import { expect, test } from "./harness";
import { decodePng } from "./png";
import { setContent } from "./set-content";

test("an iframe that gets srcdoc after insertion loads that content", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/iframe-host.html", {
    waitUntil: "load",
    timeout: 30000,
  });

  const text = await page.evaluate(
    () =>
      new Promise<string | null>((resolve) => {
        const frame = document.createElement("iframe");
        document.body.appendChild(frame);
        frame.srcdoc = '<p id="doc">from srcdoc</p>';
        frame.onload = () => {
          resolve(frame.contentDocument?.getElementById("doc")?.textContent ?? null);
        };
      }),
  );

  expect(text).toBe("from srcdoc");
});

test("an iframe with srcdoc set before insertion loads that content", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/iframe-host.html", {
    waitUntil: "load",
    timeout: 30000,
  });

  const text = await page.evaluate(
    () =>
      new Promise<string | null>((resolve) => {
        const frame = document.createElement("iframe");
        frame.srcdoc = '<p id="doc">before insertion</p>';
        frame.onload = () => {
          resolve(frame.contentDocument?.getElementById("doc")?.textContent ?? null);
        };
        document.body.appendChild(frame);
      }),
  );

  expect(text).toBe("before insertion");
});

test("srcdoc takes precedence over src", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/iframe-host.html", {
    waitUntil: "load",
    timeout: 30000,
  });

  const text = await page.evaluate(
    () =>
      new Promise<string | null>((resolve) => {
        const frame = document.createElement("iframe");
        frame.src = "/__fixtures/iframe-child.html";
        frame.srcdoc = '<p id="doc">srcdoc wins</p>';
        frame.onload = () => {
          resolve(frame.contentDocument?.getElementById("doc")?.textContent ?? null);
        };
        document.body.appendChild(frame);
      }),
  );

  expect(text).toBe("srcdoc wins");
});

const SANDBOX_CHILD = "/__fixtures/sandbox-child.html";
const SANDBOX_HOST = "https://ks.invalid/__fixtures/sandbox-host.html";
const IFRAME_HOST = "https://ks.invalid/__fixtures/iframe-host.html";

function sandboxHostUrl(sandbox: string | undefined, src: string): string {
  const query = new URLSearchParams({ src });
  if (sandbox !== undefined) query.set("sandbox", sandbox);
  return `${SANDBOX_HOST}?${query.toString()}`;
}

// A child isolate's execution context id and the origins it was reported with, keyed by frame.
interface ChildContext {
  id: number;
  origins: string[];
}

function trackChildContexts(session: CDPSession): Map<string, ChildContext> {
  const byFrame = new Map<string, ChildContext>();
  session.on("Runtime.executionContextCreated", (p) => {
    const c = p.context as { id: number; origin?: string; auxData?: { frameId?: string } };
    const frameId = c.auxData?.frameId;
    if (typeof frameId !== "string") return;
    const known = byFrame.get(frameId);
    if (known) known.origins.push(String(c.origin));
    else byFrame.set(frameId, { id: c.id, origins: [String(c.origin)] });
  });
  return byFrame;
}

async function childFrameIds(session: CDPSession): Promise<string[]> {
  const tree = (await session.send("Page.getFrameTree")) as {
    frameTree: { childFrames?: Array<{ frame: { id: string } }> };
  };
  return (tree.frameTree.childFrames ?? []).map((c) => c.frame.id);
}

async function firstChildFrameId(session: CDPSession): Promise<string> {
  return (await childFrameIds(session))[0] ?? "";
}

async function waitChildContext(
  contexts: Map<string, ChildContext>,
  session: CDPSession,
): Promise<ChildContext> {
  for (let i = 0; i < 120; i++) {
    for (const id of await childFrameIds(session)) {
      const ctx = contexts.get(id);
      if (ctx) return ctx;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("no child execution context");
}

async function evaluateChild(
  session: CDPSession,
  contextId: number,
  expression: string,
): Promise<unknown> {
  const r = (await session.send("Runtime.evaluate", {
    expression,
    contextId,
    returnByValue: true,
    awaitPromise: true,
  })) as { result: { value?: unknown } };
  return r.result.value;
}

interface SandboxMessage {
  data: { ran?: boolean; cookie?: string; storage?: string; unload?: number; href?: string };
  origin: string;
}

async function parentMessages<T = SandboxMessage>(page: Page): Promise<T[]> {
  const json = await page.evaluate(() =>
    JSON.stringify(Reflect.get(window as object, "__msgs") ?? []),
  );
  return JSON.parse(String(json)) as T[];
}

async function parentOrigins(page: Page): Promise<string[]> {
  const json = await page.evaluate(() =>
    JSON.stringify(Reflect.get(window as object, "__msgs") ?? []),
  );
  return JSON.parse(String(json)) as string[];
}

const SANDBOX_ROWS: Array<{
  name: string;
  sandbox: string | undefined;
  ran: boolean;
  origin?: string;
  cookie?: string;
  storage?: string;
}> = [
  {
    name: "no sandbox runs scripts with the real origin",
    sandbox: undefined,
    ran: true,
    origin: "https://ks.invalid",
    cookie: "ok",
    storage: "ok",
  },
  { name: 'sandbox="" blocks scripts but still renders', sandbox: "", ran: false },
  {
    name: "allow-scripts keeps the origin opaque",
    sandbox: "allow-scripts",
    ran: true,
    origin: "null",
    cookie: "SecurityError",
    storage: "SecurityError",
  },
  {
    name: "allow-scripts allow-same-origin keeps the real origin",
    sandbox: "ALLOW-SCRIPTS allow-same-origin",
    ran: true,
    origin: "https://ks.invalid",
    cookie: "ok",
    storage: "ok",
  },
];

for (const row of SANDBOX_ROWS) {
  test(
    row.name,
    async ({ page, cdpSession }) => {
      const contexts = trackChildContexts(cdpSession);
      await cdpSession.send("Page.enable");
      await cdpSession.send("Runtime.enable");
      await page.goto(sandboxHostUrl(row.sandbox, SANDBOX_CHILD), {
        waitUntil: "load",
        timeout: 30000,
      });
      await expect.poll(() => firstChildFrameId(cdpSession), { timeout: 20000 }).not.toBe("");
      const frameId = await firstChildFrameId(cdpSession);
      await expect.poll(() => contexts.get(frameId), { timeout: 20000 }).toBeTruthy();
      const contextId = contexts.get(frameId)?.id ?? 0;
      // The document renders either way; only its script policy differs.
      await expect
        .poll(
          () =>
            evaluateChild(cdpSession, contextId, "document.getElementById('markup')?.textContent"),
          { timeout: 20000 },
        )
        .toBe("sandbox child markup");
      if (!row.ran) {
        expect(await parentMessages(page)).toEqual([]);
        return;
      }
      await expect
        .poll(async () => (await parentMessages(page)).length, { timeout: 20000 })
        .toBe(1);
      const [message] = await parentMessages(page);
      expect(message?.origin).toBe(row.origin);
      expect(message?.data).toMatchObject({ ran: true, cookie: row.cookie, storage: row.storage });
      if (row.origin === "null") {
        // A Runtime.enable after load re-reports the context; it must keep the opaque origin.
        await cdpSession.send("Runtime.enable");
        await expect
          .poll(() => contexts.get(frameId)?.origins.length, { timeout: 20000 })
          .toBeGreaterThanOrEqual(2);
        expect(contexts.get(frameId)?.origins.at(-1)).toBe("://");
      }
    },
    60_000,
  );
}

test("localStorage and sessionStorage are distinct stores", async ({ page }) => {
  await page.goto(IFRAME_HOST, { waitUntil: "load", timeout: 30000 });
  const r = await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem("k", "local");
    return { same: localStorage === sessionStorage, leak: sessionStorage.getItem("k") };
  });
  expect(r).toEqual({ same: false, leak: null });
}, 60_000);

test("an opaque child's own identity is null", async ({ page, cdpSession }) => {
  const contexts = trackChildContexts(cdpSession);
  await cdpSession.send("Page.enable");
  await cdpSession.send("Runtime.enable");
  await page.goto(sandboxHostUrl("allow-scripts", SANDBOX_CHILD), {
    waitUntil: "load",
    timeout: 30000,
  });
  const { id } = await waitChildContext(contexts, cdpSession);
  const r = await evaluateChild(
    cdpSession,
    id,
    `(async () => {
      const selfOrigin = await new Promise((resolve) => {
        addEventListener("message", (e) => resolve(e.origin), { once: true });
        window.postMessage("self", "*");
      });
      const specific = await new Promise((resolve) => {
        addEventListener("message", () => resolve("delivered"), { once: true });
        window.postMessage("self", "https://ks.invalid");
        setTimeout(() => resolve("dropped"), 500);
      });
      return { locationOrigin: location.origin, windowOrigin: window.origin, selfOrigin, specific };
    })()`,
  );
  expect(r).toEqual({
    locationOrigin: "null",
    windowOrigin: "null",
    selfOrigin: "null",
    specific: "dropped",
  });
}, 60_000);

test("a sandbox attribute change applies to the next child navigation", async ({
  page,
  cdpSession,
}) => {
  await cdpSession.send("Runtime.enable");
  await page.goto(IFRAME_HOST, {
    waitUntil: "load",
    timeout: 30000,
  });
  await page.evaluate(() => {
    Reflect.set(window as object, "__msgs", []);
    addEventListener("message", (e) => {
      (Reflect.get(window as object, "__msgs") as string[]).push(e.origin);
    });
    const f = document.createElement("iframe");
    f.setAttribute("sandbox", "allow-scripts");
    f.src = "https://ks-other.invalid/__fixtures/sandbox-child.html?a=1";
    document.body.appendChild(f);
    Reflect.set(window as object, "__frame", f);
  });
  await expect.poll(() => parentOrigins(page), { timeout: 20000 }).toEqual(["null"]);

  await page.evaluate(() => {
    const frame = Reflect.get(window as object, "__frame") as HTMLIFrameElement;
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
    frame.src = "https://ks-other.invalid/__fixtures/sandbox-child.html?a=2";
  });
  await expect
    .poll(() => parentOrigins(page), { timeout: 20000 })
    .toEqual(["null", "https://ks-other.invalid"]);
}, 60_000);

test("an old opaque document's unload message keeps its opaque origin", async ({
  page,
  cdpSession,
}) => {
  const contexts = trackChildContexts(cdpSession);
  await cdpSession.send("Page.enable");
  await cdpSession.send("Runtime.enable");
  await page.goto(IFRAME_HOST, { waitUntil: "load", timeout: 30000 });
  await page.evaluate(() => {
    Reflect.set(window as object, "__msgs", []);
    addEventListener("message", (e) => {
      (Reflect.get(window as object, "__msgs") as SandboxMessage[]).push({
        data: e.data as SandboxMessage["data"],
        origin: e.origin,
      });
    });
    const f = document.createElement("iframe");
    f.id = "probe";
    f.setAttribute("sandbox", "allow-scripts");
    f.src = "/__fixtures/sandbox-unload-child.html?a=1";
    document.body.appendChild(f);
  });
  await waitChildContext(contexts, cdpSession);
  await expect.poll(async () => (await parentMessages(page)).length, { timeout: 20000 }).toBe(0);

  await page.evaluate(() => {
    const f = document.getElementById("probe") as HTMLIFrameElement;
    f.setAttribute("sandbox", "allow-scripts allow-same-origin");
    f.src = "/__fixtures/sandbox-unload-child.html?a=2";
  });
  const unload = async (): Promise<SandboxMessage[]> =>
    (await parentMessages(page)).filter(
      (m) => m.data?.unload === 1 && String(m.data?.href ?? "").includes("a=1"),
    );
  await expect.poll(async () => (await unload()).length, { timeout: 20000 }).toBe(1);
  expect((await unload())[0]?.origin).toBe("null");
}, 60_000);

test("a same-origin script-disabled child keeps its document", async ({ page }) => {
  await page.goto(sandboxHostUrl("allow-same-origin", "/__fixtures/iframe-child.html"), {
    waitUntil: "load",
    timeout: 30000,
  });
  const r = await page.evaluate(() => {
    const f = document.getElementById("f") as HTMLIFrameElement;
    return {
      doc: f.contentDocument === null ? null : "document",
      text: f.contentDocument?.getElementById("hdr")?.textContent ?? null,
    };
  });
  expect(r).toEqual({ doc: "document", text: "Child heading" });
}, 60_000);

test("a script-disabled opaque child paints without a document", async ({ page }) => {
  await page.goto(sandboxHostUrl("", SANDBOX_CHILD), { waitUntil: "load", timeout: 30000 });
  const png = await decodePng(
    new Uint8Array(
      await page.screenshot({ type: "png", clip: { x: 100, y: 100, width: 1, height: 1 } }),
    ),
  );
  // The opaque child is served by its isolate, so its bitmap is what paints.
  expect([...png.data.subarray(0, 3)]).toEqual([0, 0, 255]);
  const r = await page.evaluate(() => {
    const f = document.getElementById("f") as HTMLIFrameElement;
    return {
      doc: f.contentDocument === null ? "null" : "document",
      text: f.contentDocument?.getElementById("markup")?.textContent ?? null,
    };
  });
  expect(r).toEqual({ doc: "null", text: null });
  expect(await parentMessages(page)).toEqual([]);
}, 60_000);

test("a static srcdoc keeps its document and its embedder base URL", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/sandbox-facade-host.html", {
    waitUntil: "load",
    timeout: 30000,
  });
  const r = await page.evaluate(() => {
    const read = (id: string) => {
      const f = document.getElementById(id) as HTMLIFrameElement;
      const d = f.contentDocument;
      return {
        doc: d === null ? null : "document",
        base: d?.baseURI ?? null,
        href: d?.getElementById("a")?.getAttribute("href") ?? null,
      };
    };
    return { plain: read("plain"), same: read("same") };
  });
  const expected = {
    doc: "document",
    base: "https://ks.invalid/__fixtures/sandbox-facade-host.html",
    href: "sibling.html",
  };
  expect(r).toEqual({ plain: expected, same: expected });
}, 60_000);

test("a script-disabled srcdoc facade carries no inline handlers", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/sandbox-facade-host.html", {
    waitUntil: "load",
    timeout: 30000,
  });
  const r = await page.evaluate(() => {
    const f = document.getElementById("handler") as HTMLIFrameElement;
    const button = f.contentDocument?.getElementById("b") as HTMLElement | null;
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return {
      doc: f.contentDocument === null ? null : "document",
      onclick: button?.getAttribute("onclick") ?? null,
      ran: Reflect.get(window as object, "__ran") ?? null,
    };
  });
  expect(r).toEqual({ doc: "document", onclick: null, ran: null });
}, 60_000);

// An opaque child's workers must stay opaque: a same-origin worker script URL is unreachable, and
// a blob URL minted in the document carries its opaque origin.
async function opaqueChildMessages<T>(page: Page, mode: string): Promise<T[]> {
  await page.goto(IFRAME_HOST, { waitUntil: "load", timeout: 30000 });
  await page.evaluate((childMode) => {
    Reflect.set(window as object, "__msgs", []);
    addEventListener("message", (e) => {
      (Reflect.get(window as object, "__msgs") as unknown[]).push(e.data);
    });
    const f = document.createElement("iframe");
    f.setAttribute("sandbox", "allow-scripts");
    f.src = `/__fixtures/sandbox-worker-child.html?mode=${childMode}`;
    document.body.appendChild(f);
  }, mode);
  await expect.poll(async () => (await parentMessages(page)).length, { timeout: 30000 }).toBe(1);
  return parentMessages<T>(page);
}

test("an opaque child cannot construct a same-origin worker", async ({ page }) => {
  const [message] = await opaqueChildMessages<{ sameOriginWorker: string }>(page, "same-origin");
  expect(message).toMatchObject({ sameOriginWorker: "SecurityError" });
}, 60_000);

test("an opaque child mints opaque blob URLs", async ({ page }) => {
  const [message] = await opaqueChildMessages<{ blobUrl: string; blobOrigin: string }>(
    page,
    "blob",
  );
  expect(message).toMatchObject({ blobOrigin: "null" });
  expect(message?.blobUrl).toMatch(/^blob:null\//);
}, 60_000);

test("an opaque sandboxed srcdoc paints while contentDocument stays null", async ({ page }) => {
  await setContent(page, "<!doctype html><style>html,body{margin:0}</style>");
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const frame = document.createElement("iframe");
        frame.setAttribute("sandbox", "");
        frame.srcdoc = "<p style='margin:0;width:120px;height:120px;background:rgb(0,0,255)'>x</p>";
        frame.onload = () => resolve();
        document.body.appendChild(frame);
        Reflect.set(window as object, "__frame", frame);
      }),
  );
  const png = await decodePng(
    new Uint8Array(
      await page.screenshot({ type: "png", clip: { x: 60, y: 60, width: 1, height: 1 } }),
    ),
  );
  expect([...png.data.subarray(0, 3)]).toEqual([0, 0, 255]);
  expect(
    await page.evaluate(
      () =>
        (Reflect.get(window as object, "__frame") as HTMLIFrameElement).contentDocument === null,
    ),
  ).toBe(true);
}, 60_000);
