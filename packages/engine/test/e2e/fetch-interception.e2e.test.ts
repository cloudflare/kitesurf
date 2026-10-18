// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { readEngineMemory } from "./cdp-read";
import { expect, test } from "./harness";

interface PptrRequest {
  url(): string;
  respond(r: { status: number; contentType?: string; body: string }): Promise<void>;
  abort(): Promise<void>;
  continue(overrides?: { url?: string }): Promise<void>;
}

test("setRequestInterception: respond fulfills a navigation without egress", async ({ page }) => {
  await page.setRequestInterception(true);
  page.on("request", (req: PptrRequest) => {
    if (req.url().endsWith("/routed.html")) {
      void req.respond({
        status: 200,
        contentType: "text/html",
        body: "<title>routed-fulfilled</title><h1>from route</h1>",
      });
    } else {
      void req.continue();
    }
  });
  await page.goto("https://ks.invalid/routed.html", {
    waitUntil: "domcontentloaded",
  });
  expect(await page.title()).toBe("routed-fulfilled");
}, 120_000);

test("setRequestInterception: abort surfaces a network error to the page", async ({ page }) => {
  await page.setRequestInterception(true);
  page.on("request", (req: PptrRequest) => {
    if (req.url().endsWith("/aborted.json")) void req.abort();
    else void req.continue();
  });
  await page.goto("https://ks.invalid/__fixtures/lifecycle.html", {
    waitUntil: "domcontentloaded",
  });
  const outcome = await page.evaluate(`
    fetch("/aborted.json").then(() => "resolved", () => "rejected")
  `);
  expect(outcome).toBe("rejected");
}, 120_000);

test("setRequestInterception: continue with URL override reroutes the fetch", async ({ page }) => {
  await page.setRequestInterception(true);
  page.on("request", (req: PptrRequest) => {
    if (req.url().endsWith("/reroute-me.json")) {
      void req.continue({
        url: "https://ks-other.invalid/__fixtures/echo-headers.json",
      });
    } else {
      void req.continue();
    }
  });
  await page.goto("https://ks.invalid/__fixtures/lifecycle.html", {
    waitUntil: "domcontentloaded",
  });
  const body = await page.evaluate(`
    fetch("/reroute-me.json").then((r) => r.text())
  `);
  expect(String(body)).toContain("user-agent");
}, 120_000);

test("setRequestInterception: cross-host URL override drops the original host's cookies", async ({
  page,
}) => {
  await page.setRequestInterception(true);
  page.on("request", (req: PptrRequest) => {
    if (req.url().endsWith("/reroute-me.json")) {
      void req.continue({
        url: "https://ks-other.invalid/__fixtures/echo-headers.json",
      });
    } else {
      void req.continue();
    }
  });
  await page.goto("https://ks.invalid/__fixtures/lifecycle.html", {
    waitUntil: "domcontentloaded",
  });
  await page.evaluate(`document.cookie = "sess=ks-secret; path=/"`);
  const body = await page.evaluate(`
    fetch("/reroute-me.json").then((r) => r.json())
  `);
  expect((body as { cookie?: string }).cookie ?? "").not.toContain("ks-secret");
}, 120_000);

test("setRequestInterception: include-mode cross-host override is CORS-rejected", async ({
  page,
}) => {
  await page.setRequestInterception(true);
  page.on("request", (req: PptrRequest) => {
    if (req.url().endsWith("/reroute-me.json")) {
      void req.continue({
        url: "https://ks-other.invalid/__fixtures/no-acao-secret.json",
      });
    } else {
      void req.continue();
    }
  });
  await page.goto("https://ks.invalid/__fixtures/lifecycle.html", {
    waitUntil: "domcontentloaded",
  });
  await page.evaluate(`document.cookie = "sess=ks-secret; path=/"`);
  const outcome = await page.evaluate(`
    fetch("/reroute-me.json", { credentials: "include" })
      .then(() => "reached-page")
      .catch((e) => "blocked:" + e.name)
  `);
  expect(String(outcome)).toBe("blocked:TypeError");
}, 120_000);

test("setRequestInterception: cross-host URL override still demands a preflight", async ({
  page,
}) => {
  await page.setRequestInterception(true);
  page.on("request", (req: PptrRequest) => {
    if (req.url().endsWith("/reroute-me.json")) {
      void req.continue({
        url: "https://ks-other.invalid/__fixtures/echo-headers.json",
      });
    } else {
      void req.continue();
    }
  });
  await page.goto("https://ks.invalid/__fixtures/lifecycle.html", {
    waitUntil: "domcontentloaded",
  });
  const outcome = await page.evaluate(`
    fetch("/reroute-me.json", { method: "PUT", headers: { "x-probe": "1" } })
      .then(() => "reached-origin")
      .catch((e) => "blocked:" + e.name)
  `);
  expect(String(outcome)).toBe("blocked:TypeError");
}, 120_000);

test("setRequestInterception: cross-host override still withholds image bytes", async ({
  page,
}) => {
  await page.setRequestInterception(true);
  page.on("request", (req: PptrRequest) => {
    if (req.url() === "https://ks.invalid/__fixtures/solid-red.png") {
      void req.continue({
        url: "https://ks-other.invalid/__fixtures/solid-red.png?ovr=1",
      });
    } else {
      void req.continue();
    }
  });
  const session = await page.createCDPSession();
  const before = await readEngineMemory(session);
  await page.goto("https://ks.invalid/__fixtures/image-paint.html", {
    waitUntil: "load",
  });
  await page
    .waitForFunction(
      () => ((document.getElementById("a") as HTMLImageElement | null)?.naturalWidth ?? 0) > 0,
      { timeout: 10_000 },
    )
    .catch(() => {});
  const w = await page.evaluate(`document.getElementById("a").naturalWidth`);
  const natural = typeof w === "number" ? w : 0;
  const out = (await page.evaluate(`
    (async () => {
      const a = document.getElementById("a");
      // Nothing but the pixels can say whether the isolate got bytes:
      // an <img> exposes no headers, so composite it and read back.
      const cv = document.createElement("canvas");
      cv.width = 8;
      cv.height = 8;
      document.body.appendChild(cv);
      const cx = cv.getContext("2d");
      let read = "";
      try {
        cx.drawImage(a, 0, 0);
        await new Promise((r) => setTimeout(r, 300));
        const d = cx.getImageData(4, 4, 1, 1).data;
        read = d[0] + "," + d[1] + "," + d[2] + "," + d[3];
      } catch (e) {
        read = "THREW:" + ((e && e.name) ? e.name : String(e));
      }
      return { read };
    })()
  `)) as { read: string };
  const after = await readEngineMemory(session);
  expect(after.retainedImageCount - before.retainedImageCount).toBe(2);
  expect(natural).toBe(8);
  expect(out.read).not.toContain("255,0,0");
}, 120_000);

test("setRequestInterception: non-matching requests pass through untouched", async ({ page }) => {
  await page.setRequestInterception(true);
  page.on("request", (req: PptrRequest) => void req.continue());
  const resp = await page.goto("https://ks.invalid/__fixtures/lifecycle.html", {
    waitUntil: "domcontentloaded",
  });
  expect(resp!.status()).toBe(200);
  expect(page.url()).toContain("lifecycle.html");
}, 120_000);
