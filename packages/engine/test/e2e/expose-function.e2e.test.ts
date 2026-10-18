// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

const FIXTURE = "https://ks.invalid/__fixtures/lifecycle.html";

interface BindingCalledEvent {
  name: string;
  payload: string;
  executionContextId: number;
}

function onceEvent(
  emitter: { once(event: string, cb: (e: unknown) => void): unknown },
  event: string,
  timeoutMs = 15_000,
): Promise<BindingCalledEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    emitter.once(event, (e) => {
      clearTimeout(timer);
      resolve(e as BindingCalledEvent);
    });
  });
}

test("raw CDP: addBinding before navigate emits bindingCalled", async ({
  page,
  cdpSession: cdp,
}) => {
  let liveContextId = 0;
  cdp.on("Runtime.executionContextCreated", (e) => {
    const c = (e as { context: { id: number; auxData?: { isDefault?: boolean } } }).context;
    if (c.auxData?.isDefault) liveContextId = c.id;
  });
  await cdp.send("Runtime.addBinding", { name: "ksProbe" });
  const eventP = onceEvent(cdp, "Runtime.bindingCalled");
  await page.goto(FIXTURE, { waitUntil: "domcontentloaded" });
  await page.evaluate("window.ksProbe('hello-from-page'); null");
  const event = await eventP;
  expect(event.name).toBe("ksProbe");
  expect(event.payload).toBe("hello-from-page");
  expect(liveContextId).toBeGreaterThan(0);
  expect(event.executionContextId).toBe(liveContextId);
}, 120_000);

test("raw CDP: addBinding after load live-installs; removeBinding stops events", async ({
  page,
}) => {
  await page.goto(FIXTURE, { waitUntil: "domcontentloaded" });
  const cdp = await page.createCDPSession();
  const events: BindingCalledEvent[] = [];
  cdp.on("Runtime.bindingCalled", (e) => events.push(e as BindingCalledEvent));

  await cdp.send("Runtime.addBinding", { name: "ksLive" });
  const liveEventP = new Promise<BindingCalledEvent>((resolve) => {
    const handler = (e: unknown) => {
      cdp.off("Runtime.bindingCalled", handler);
      resolve(e as BindingCalledEvent);
    };
    cdp.on("Runtime.bindingCalled", handler);
  });
  await page.evaluate("window.ksLive('live-install'); null");
  await liveEventP;
  await page.evaluate("window.ksLive(42); null");

  await cdp.send("Runtime.removeBinding", { name: "ksLive" });
  const stillFn = await page.evaluate("window.ksLive('after-remove'); typeof window.ksLive");
  expect(stillFn).toBe("function");

  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(events.map((e) => e.payload)).toEqual(["live-install"]);
}, 120_000);

test("puppeteer exposeFunction before goto round-trips", async ({ page, cdpSession: cdp }) => {
  const events: BindingCalledEvent[] = [];
  cdp.on("Runtime.bindingCalled", (e) => events.push(e as BindingCalledEvent));
  await page.exposeFunction("ksCompute", (a: number, b: number) => a * b);
  await page.goto(FIXTURE, { waitUntil: "domcontentloaded" });
  const kicked = await page.evaluate(`(() => {
    window.__done = "pending";
    window.ksCompute(9, 4).then(
      (v) => { window.__done = "resolved:" + v; },
      (e) => { window.__done = "rejected:" + String(e); },
    );
    return "kicked";
  })()`);
  expect(kicked).toBe("kicked");
  await page.waitForFunction('window.__done !== "pending"', { timeout: 10_000 });
  expect(events.some((e) => e.name === "puppeteer_ksCompute")).toBe(true);
  expect(await page.evaluate("window.__done")).toBe("resolved:36");
}, 120_000);

test("puppeteer exposeFunction added after load round-trips", async ({ page }) => {
  await page.goto(FIXTURE, { waitUntil: "domcontentloaded" });
  await page.exposeFunction("ksLate", (s: string) => s.toUpperCase());
  const result = await page.evaluate("window.ksLate('kitesurf')");
  expect(result).toBe("KITESURF");
}, 120_000);
