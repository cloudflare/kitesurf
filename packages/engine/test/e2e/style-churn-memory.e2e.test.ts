// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test, type BrowserFactory } from "./harness";
import { setContent } from "./set-content";

const BASE_RULES = Array.from(
  { length: 500 },
  (_, i) =>
    `.sc-${i.toString(36)}{display:flex;padding:${i % 16}px;margin:0 auto;` +
    `color:rgb(${i % 255},0,0);font-family:Montserrat,sans-serif}`,
);
const ROUNDS = 150;

async function heapMiB(cdp: { send(m: string, p?: object): Promise<unknown> }) {
  const h = (await cdp.send("Runtime.getHeapUsage")) as { usedSize: number };
  return h.usedSize / 1048576;
}

test("speedy insertRule churn keeps wasm memory flat", async ({ page, cdpSession: cdp }) => {
  await setContent(page, `<style id=s>${BASE_RULES.join("\n")}</style><p class="sc-1">x</p>`);
  await page.evaluate(`document.getElementById("s").sheet.cssRules.length`);
  const before = await heapMiB(cdp);
  const r = await page.evaluate(
    `(() => {
      const sheet = document.getElementById("s").sheet;
      const n0 = sheet.cssRules.length;
      for (let i = 0; i < ${ROUNDS}; i++) {
        sheet.insertRule(".churn" + i + "{color:blue;margin:" + i + "px}", sheet.cssRules.length);
      }
      const st = document.getElementById("s");
      return JSON.stringify({
        rules: sheet.cssRules.length - n0,
        // The mirror owns ONE text node and rewrites it in place.
        textChildren: st.childNodes.length,
        applied: getComputedStyle(document.querySelector(".sc-1")).display,
      });
    })()`,
  );
  const after = await heapMiB(cdp);
  expect(JSON.parse(String(r))).toEqual({
    rules: ROUNDS,
    textChildren: 1,
    applied: "flex",
  });
  expect(after - before).toBeLessThan(16);
}, 120_000);

async function textContentChurn(browserFactory: BrowserFactory, observe: "style" | "elsewhere") {
  const browser = await browserFactory();
  const page = await browser.newPage();
  const cdp = await page.createCDPSession();
  await setContent(page, `<style id=s></style><p class="sc-1">x</p>`);
  const before = await heapMiB(cdp);
  await page.evaluate(
    `(() => {
      const base = ${JSON.stringify(BASE_RULES.join("\n"))};
      const st = document.getElementById("s");
      const watched = ${JSON.stringify(observe)} === "style" ? st : document.querySelector("p");
      new MutationObserver(() => {}).observe(watched, { childList: true, subtree: true });
      for (let i = 0; i < ${ROUNDS}; i++) st.textContent = base + "\\n.x" + i + "{color:red}";
    })()`,
  );
  return { browser, page, delta: (await heapMiB(cdp)) - before };
}

test("textContent rewrites of a <style> free the replaced text node", async ({
  browserFactory,
}) => {
  const observed = await textContentChurn(browserFactory, "style");
  await observed.browser.disconnect();
  const freed = await textContentChurn(browserFactory, "elsewhere");
  expect(freed.delta).toBeLessThan(observed.delta - 3);
  expect(freed.delta).toBeLessThan(10);
  const held = await freed.page.evaluate(
    `(() => {
      const st = document.getElementById("s");
      const t = st.firstChild;
      st.textContent = "p{color:red}";
      return { data: t.data.length, detached: t.parentNode === null, fresh: st.firstChild.data };
    })()`,
  );
  expect(held).toEqual({
    data: BASE_RULES.join("\n").length + "\n.x149{color:red}".length,
    detached: true,
    fresh: "p{color:red}",
  });
}, 180_000);

test("a removed <style> releases its cached parse", async ({ page, cdpSession: cdp }) => {
  await setContent(page, `<p class="sc-1">x</p>`);
  const before = await heapMiB(cdp);
  await page.evaluate(
    `(() => {
      const base = ${JSON.stringify(BASE_RULES.join("\n"))};
      for (let i = 0; i < ${ROUNDS}; i++) {
        const st = document.createElement("style");
        st.textContent = base + "\\n.m" + i + "{color:red}";
        document.head.appendChild(st);
        st.remove();
      }
    })()`,
  );
  const after = await heapMiB(cdp);
  expect(after - before).toBeLessThan(16);
}, 120_000);
