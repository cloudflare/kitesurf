// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { decodePng, type DecodedPng } from "./png";

const BASE = "https://ks.invalid/__fixtures";

const RED_40x20 =
  "iVBORw0KGgoAAAANSUhEUgAAACgAAAAUCAIAAABwJOjsAAAAI0lEQVR42u3NsQ0AAAjAoP7/tJ7hIAk7TZ1ILBaLxWKx+E+8ffodDqIehz0AAAAASUVORK5CYII=";
const BLUE_800x200 =
  "iVBORw0KGgoAAAANSUhEUgAAAyAAAADICAIAAACf7RJNAAAC/0lEQVR42u3WMQ0AAAjAsPk3DSb4aFIFu1YNAACnJAAAMFgAAAYLAMBgAQBgsAAADBYAgMECAMBgAQAYLAAAgwUAgMECADBYAAAGCwDAYAEAYLAAAAwWAIDBAgDAYAEAGCwAAIMFAIDBAgAwWAAABgsAAIMFAGCwAAAMFgCAwQIAwGABABgsAACDBQCAwQIAMFgAAAYLAACDBQBgsAAADBYAAAYLAMBgAQAYLAAAgwUAgMECADBYAAAGCwAAgwUAYLAAAAwWAAAGCwDAYAEAGCwAACQAADBYAAAGCwDAYAEAYLAAAAwWAIDBAgDAYAEAGCwAAIMFAIDBAgAwWAAABgsAwGABAGCwAAAMFgCAwQIAwGABABgsAACDBQCAwQIAMFgAAAYLAACDBQBgsAAADBYAgMECAMBgAQAYLAAAgwUAgMECADBYAAAGCwAAgwUAYLAAAAwWAAAGCwDAYAEAGCwAAIMFAIDBAgAwWAAABgsAAIMFAGCwAAAMFgAABgsAwGABABgsAAAMFgCAwQIAMFgAAAYLAACDBQBgsAAADBYAAAYLAMBgAQAYLAAADBYAgMECADBYAAAGCwAAgwUAYLAAAAwWAAAGCwDAYAEAGCwAAAwWAIDBAgAwWAAAGCwAAIMFAGCwAAAMFgAABgsAwGABABgsAAAMFgCAwQIAMFgAABgsAACDBQBgsAAAMFgAAAYLAMBgAQAYLAAADBYAgMECADBYAAAYLAAAgwUAYLAAADBYAAAGCwDAYAEAYLAAAAwWAIDBAgAwWAAAGCwAAIMFAGCwAAAwWAAABgsAwGABAGCwAAAMFgCAwQIAMFgAABgsAACDBQBgsAAAMFgAAAYLAMBgAQBgsAAADBYAgMECAMBgAQAYLAAAgwUAYLAAADBYAAAGCwDAYAEAYLAAAAwWAIDBAgDAYAEAGCwAAIMFAIDBAgAwWAAABgsAwGABAGCwAAAMFgCAwQIAwGABABgsAACDBQCAwQIAMFgAAAYLAACDBQBgsAAADBYAwDMLO9Wzc2k+TA8AAAAASUVORK5CYII=";

function rgbAt(png: DecodedPng, x: number, y: number): number[] {
  const i = (y * png.width + x) * 4;
  return [...png.data.subarray(i, i + 3)];
}

test("an image navigates to a centred image document", async ({ page, cdpSession: cdp }) => {
  await page.setViewport({ width: 400, height: 300 });
  await cdp.send("Network.enable");
  let docRequestId = "";
  cdp.on("Network.responseReceived", (e) => {
    if (e.type === "Document") docRequestId = e.requestId;
  });
  const resp = await page.goto(`data:image/png;base64,${RED_40x20}`, { waitUntil: "load" });
  expect(resp?.status()).toBe(200);
  expect(await page.title()).toBe("40\u00d720");
  const img = await page.evaluate(() => {
    const el = document.querySelector("img");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: el.naturalWidth, h: el.naturalHeight, x: r.x, y: r.y, rw: r.width, rh: r.height };
  });
  expect(img).toEqual({ w: 40, h: 20, x: 180, y: 140, rw: 40, rh: 20 });

  const body = await cdp.send("Network.getResponseBody", { requestId: docRequestId });
  expect(body).toEqual({ body: RED_40x20, base64Encoded: true });

  const shot = await decodePng(new Uint8Array(await page.screenshot({ type: "png" })));
  expect(rgbAt(shot, 200, 150)).toEqual([255, 0, 0]);
  expect(rgbAt(shot, 5, 5)).toEqual([14, 14, 14]);
}, 120_000);

test("an image larger than the viewport shrinks to fit", async ({ page }) => {
  await page.setViewport({ width: 400, height: 300 });
  await page.goto(`data:image/png;base64,${BLUE_800x200}`, { waitUntil: "load" });
  const rect = await page.evaluate(() => {
    const r = document.querySelector("img")?.getBoundingClientRect();
    if (!r) return null;
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  expect(rect).toEqual({ x: 0, y: 100, w: 400, h: 100 });
}, 120_000);

test("text, XML and JSON still render", async ({ page }) => {
  await page.goto("data:text/plain,hello%20<b>", { waitUntil: "load" });
  expect(await page.evaluate(() => document.querySelector("pre")?.textContent)).toBe("hello <b>");
  await page.goto(`data:application/rss+xml,${encodeURIComponent("<rss/>")}`, {
    waitUntil: "load",
  });
  expect(await page.evaluate(() => document.querySelector("pre")?.textContent)).toBe("<rss/>");
  await page.goto(`data:application/json,${encodeURIComponent('{"a":1}')}`, { waitUntil: "load" });
  expect(await page.evaluate(() => document.getElementById("json-raw")?.textContent)).toBe(
    '{"a":1}',
  );
}, 120_000);

test("unsupported types and attachments abort the navigation", async ({ cdpSession: cdp }) => {
  await cdp.send("Network.enable");
  const failed: string[] = [];
  cdp.on("Network.loadingFailed", (e) => failed.push(e.errorText));
  for (const url of [
    "data:application/pdf;base64,JVBERi0xLjQ=",
    "data:application/octet-stream;base64,AAECAw==",
    "data:image/avif;base64,AAAAHGZ0eXBhdmlm",
    `${BASE}/attachment.html`,
  ]) {
    const nav = await cdp.send("Page.navigate", { url });
    expect(nav.errorText, url).toBe("net::ERR_ABORTED");
  }
  expect(failed).toEqual(Array(4).fill("net::ERR_ABORTED"));
}, 120_000);
