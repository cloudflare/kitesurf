// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A page whose scripts run renders no <noscript>, however the element got into the DOM; a
// full-viewport fallback must neither cover the page nor take its hit tests.
import type { CDPSession, Page } from "@cloudflare/puppeteer";

import { expect, test } from "./harness";
import { bbox, decodePng } from "./png";
import { setContent } from "./set-content";

const ORIGIN = "https://ks.invalid";
const STYLE = `<style>
  * { margin: 0; padding: 0; }
  #go { position: absolute; left: 40px; top: 60px; width: 120px; height: 40px;
        background: rgb(0, 0, 255); border: 0; appearance: none; }
  .cover { display: block; position: fixed; inset: 0; width: 100%; height: 100%;
           background: #fff; z-index: 999999; }
</style>`;
const FALLBACK = '<noscript class="cover"><p id="fallback">JS required</p></noscript>';
const BUTTON_RECT = { x: 40, y: 60, w: 120, h: 40 };
const TEXT_NODE = 3;

const isBlue = (r: number, g: number, b: number) => r < 40 && g < 40 && b > 200;

const docUrl = (body: string): string => {
  const u = new URL(`${ORIGIN}/__fixtures/policy-doc.html`);
  u.searchParams.set("body", body);
  return u.toString();
};

async function expectButtonOnTop(page: Page, session: CDPSession): Promise<void> {
  const png = await decodePng(new Uint8Array((await page.screenshot()) as Uint8Array));
  expect(bbox(png, 0, 300, isBlue)).toEqual(BUTTON_RECT);
  expect(await page.evaluate(() => document.elementFromPoint(100, 80)?.id)).toBe("go");
  const { backendNodeId } = await session.send("DOM.getNodeForLocation", { x: 100, y: 80 });
  const { node } = await session.send("DOM.describeNode", { backendNodeId });
  expect(node.nodeName).toBe("BUTTON");
}

test("a parsed noscript keeps its markup as text and renders nothing", async ({
  page,
  cdpSession: session,
}) => {
  await page.setViewport({ width: 300, height: 300 });
  const { frameTree } = await session.send("Page.getFrameTree");
  await session.send("Page.setDocumentContent", {
    frameId: frameTree.frame.id,
    html: `<!doctype html>${STYLE}<button id="go"></button>${FALLBACK}`,
  });

  await expectButtonOnTop(page, session);
  const noscript = await page.evaluate(() => {
    const ns = document.querySelector("noscript")!;
    return {
      display: getComputedStyle(ns).display,
      fallback: document.getElementById("fallback") !== null,
      children: Array.from(ns.childNodes, (n) => n.nodeType),
      innerHTML: ns.innerHTML,
      innerText: document.body.innerText.includes("JS required"),
    };
  });
  expect(noscript).toEqual({
    display: "none",
    fallback: false,
    children: [TEXT_NODE],
    innerHTML: '<p id="fallback">JS required</p>',
    innerText: false,
  });
});

test("navigation keeps the served noscript where it was", async ({ page, cdpSession: session }) => {
  await page.setViewport({ width: 300, height: 300 });
  await setContent(
    page,
    `<!doctype html><head><noscript><img src="x.png"></noscript><meta name="marker">${STYLE}</head>
<body><div id="root">${FALLBACK}<input id="q"></div><button id="go"></button>
<script>
  const first = document.getElementById("root").firstElementChild;
  document.title = first && first.localName === "noscript" ? "kept" : "stripped";
  window.__literal = "<noscript>x</noscript>";
</script></body>`,
  );

  expect(await page.title()).toBe("kept");
  const state = await page.evaluate(() => ({
    marker: document.head.querySelector('meta[name="marker"]') !== null,
    literal: (globalThis as { __literal?: string }).__literal,
  }));
  expect(state).toEqual({ marker: true, literal: "<noscript>x</noscript>" });
  await expectButtonOnTop(page, session);
});

test("a noscript created at runtime renders nothing", async ({ page, cdpSession: session }) => {
  await page.setViewport({ width: 300, height: 300 });
  await page.goto(docUrl(`${STYLE}<button id="go"></button><div id="host"></div>`), {
    waitUntil: "load",
  });

  await page.evaluate(() => {
    const ns = document.createElement("noscript");
    ns.className = "cover";
    ns.append(document.createElement("p"));
    document.body.append(ns);
  });
  await expectButtonOnTop(page, session);
  expect(await page.evaluate(() => document.querySelector("body > noscript")!.outerHTML)).toBe(
    '<noscript class="cover"><p></p></noscript>',
  );

  const parsed = await page.evaluate(() => {
    document.querySelector("body > noscript")!.remove();
    document.getElementById("host")!.innerHTML =
      '<noscript class="cover"><img id="dyn" src="/__fixtures/dyn.png"></noscript>';
    const ns = document.querySelector("#host > noscript")!;
    return {
      dyn: document.getElementById("dyn") !== null,
      children: Array.from(ns.childNodes, (n) => n.nodeType),
      display: getComputedStyle(ns).display,
    };
  });
  expect(parsed).toEqual({ dyn: false, children: [TEXT_NODE], display: "none" });
  await expectButtonOnTop(page, session);
});

test("DOMParser documents keep noscript fallback markup", async ({ page }) => {
  await page.goto(docUrl("<p>host</p>"), { waitUntil: "load" });
  const found = await page.evaluate(() => {
    const doc = new DOMParser().parseFromString(
      "<body><noscript><p id=a>x</p></noscript>",
      "text/html",
    );
    return doc.querySelector("noscript > #a") !== null;
  });
  expect(found).toBe(true);
});

// A createHTMLDocument document shares the page's DOM handle but has no browsing context, so
// its markup parses with scripting off while the page's own nodes keep their noscript inert.
test("createHTMLDocument documents keep noscript fallback markup", async ({ page }) => {
  await page.goto(docUrl("<p>host</p>"), { waitUntil: "load" });
  const seen = await page.evaluate(() => {
    const doc = document.implementation.createHTMLDocument("");
    doc.body.innerHTML = "<noscript><p id=a></p>&lt;b&gt;</noscript><i id=i></i><u id=u></u>";
    const noscript = doc.querySelector("noscript")!;
    doc.querySelector("#i")!.insertAdjacentHTML("afterend", "<noscript><p id=b></p></noscript>");
    doc.querySelector("#u")!.outerHTML = "<noscript><p id=c></p></noscript>";
    const loose = doc.createElement("div");
    loose.innerHTML = "<noscript><p id=d></p></noscript>";
    const own = document.createElement("div");
    own.innerHTML = "<noscript><p id=e></p></noscript>";
    return {
      innerHTML: doc.querySelector("noscript > #a") !== null,
      insertAdjacentHTML: doc.querySelector("noscript > #b") !== null,
      outerHTML: doc.querySelector("noscript > #c") !== null,
      unattached: loose.querySelector("noscript > #d") !== null,
      pageOwn: own.querySelector("#e") !== null,
      serialized: [noscript.outerHTML, noscript.innerHTML],
    };
  });
  expect(seen).toEqual({
    innerHTML: true,
    insertAdjacentHTML: true,
    outerHTML: true,
    unattached: true,
    pageOwn: false,
    serialized: ['<noscript><p id="a"></p>&lt;b&gt;</noscript>', '<p id="a"></p>&lt;b&gt;'],
  });
});

test("a noscript outside the HTML namespace is not hidden", async ({ page }) => {
  await page.goto(docUrl("<p>host</p>"), { waitUntil: "load" });
  const display = await page.evaluate(() => {
    const el = document.createElementNS("http://www.w3.org/2000/svg", "noscript");
    document.body.append(el);
    return getComputedStyle(el).display;
  });
  expect(display).not.toBe("none");
});
