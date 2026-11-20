// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { after, before, test } from "node:test";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

const KITESURF_WS = process.env.KITESURF_WS ?? "ws://127.0.0.1:8787/devtools/browser";
// The engine runs in a container, so the app's address is the one that the container can reach.
const APP_URL = process.env.APP_URL ?? "http://host.docker.internal:3000/";
const OUTPUT_DIR = "output";

let browser: Browser | undefined;

before(async () => {
  browser = await puppeteer.connect({ browserWSEndpoint: KITESURF_WS });
});

after(async () => {
  await browser?.disconnect();
});

// Opens the app in a new page and waits for the API's items, then closes the page after `run`.
const withApp = async (run: (page: Page) => Promise<void>): Promise<void> => {
  if (!browser) throw new Error("not connected to the engine");
  const page = await browser.newPage();
  try {
    await page.goto(APP_URL);
    await page.waitForFunction(() => document.querySelectorAll("#todos li").length === 2);
    await run(page);
  } finally {
    await page.close();
  }
};

const todoTitles = (page: Page): Promise<(string | null)[]> =>
  page.$$eval("#todos li", (items) => items.map((item) => item.textContent));

test("lists the todos from the API", () =>
  withApp(async (page) => {
    assert.equal(await page.title(), "Todos");
    assert.deepEqual(await todoTitles(page), ["Buy milk", "Walk the dog"]);
    assert.equal(await page.$eval("#count", (count) => count.textContent), "2 todos");
  }));

test("adds a todo", () =>
  withApp(async (page) => {
    await page.type("#title", "Write tests");
    await page.click("button[type=submit]");
    await page.waitForFunction(() => document.querySelectorAll("#todos li").length === 3);
    assert.deepEqual(await todoTitles(page), ["Buy milk", "Walk the dog", "Write tests"]);
    assert.equal(await page.$eval("input#title", (input) => input.value), "");
  }));

test("saves a screenshot and a PDF", () =>
  withApp(async (page) => {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    const image = await page.screenshot({ path: `${OUTPUT_DIR}/todos.png` });
    assert.equal(Buffer.from(image).subarray(1, 4).toString(), "PNG");
    // page.pdf() reads the PDF through CDP's IO streams, which Kitesurf does not have yet. Ask for
    // it inline instead.
    const session = await page.createCDPSession();
    const { data } = await session.send("Page.printToPDF", { paperWidth: 8.27, paperHeight: 11.7 });
    const pdf = Buffer.from(data, "base64");
    writeFileSync(`${OUTPUT_DIR}/todos.pdf`, pdf);
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  }));
