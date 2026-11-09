// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { CDPSession } from "@cloudflare/puppeteer";
import type { Protocol } from "devtools-protocol";

import { expect, test } from "./harness";
import { setContent } from "./set-content";

type AXNode = Protocol.Accessibility.AXNode;

const PAGE = `<!doctype html><title>Clickable</title>
<body>
  <div id="listener">Listener</div>
  <div id="pointer">Pointer down</div>
  <div id="mouseup">Mouse up</div>
  <div id="property">Property</div>
  <div id="attribute" onclick="void 0">Attribute</div>
  <div id="removed">Removed</div>
  <div id="cleared">Cleared</div>
  <div id="once">Once</div>
  <div id="keyboard">Keyboard only</div>
  <div id="parent"><span id="child">Child</span></div>
  <button id="button">Button</button>
  <div id="plain">Plain</div>
  <script>
    const noop = function () {};
    window.noop = noop;
    const byId = (id) => document.getElementById(id);
    byId("listener").addEventListener("click", noop);
    byId("pointer").addEventListener("pointerdown", noop);
    byId("mouseup").addEventListener("mouseup", noop, { capture: true });
    byId("property").onclick = function () {};
    byId("removed").addEventListener("click", noop);
    byId("cleared").onclick = function () {};
    byId("once").addEventListener("click", noop, { once: true });
    byId("keyboard").addEventListener("keydown", noop);
    byId("parent").addEventListener("click", noop);
    byId("button").addEventListener("click", noop);
    document.body.addEventListener("click", noop);
    document.body.onclick = function () {};
    document.documentElement.addEventListener("mousedown", noop);
    document.addEventListener("click", noop);
  </script>
</body>`;

async function domNames(cdp: CDPSession): Promise<Map<number, string>> {
  const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
  const names = new Map<number, string>();
  const walk = (node: Protocol.DOM.Node) => {
    const attrs = node.attributes ?? [];
    let name = node.localName || node.nodeName.toLowerCase();
    for (let i = 0; i + 1 < attrs.length; i += 2) {
      if (attrs[i] === "id") name = attrs[i + 1] ?? name;
    }
    names.set(node.backendNodeId, name);
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return names;
}

function clickableProperty(node: AXNode): Protocol.Accessibility.AXProperty | undefined {
  return node.properties?.find((p) => String(p.name) === "clickable");
}

async function flagged(cdp: CDPSession, names: Map<number, string>): Promise<string[]> {
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  const out: string[] = [];
  for (const node of nodes) {
    const prop = clickableProperty(node);
    if (!prop) continue;
    expect(prop).toEqual({ name: "clickable", value: { type: "boolean", value: true } });
    out.push(names.get(node.backendDOMNodeId ?? -1) ?? `?${node.backendDOMNodeId}`);
  }
  return out.sort();
}

test("an AX node is clickable when its own element has a click listener or handler", async ({
  page,
}) => {
  await setContent(page, PAGE);
  const cdp = await page.createCDPSession();
  const names = await domNames(cdp);
  expect(await flagged(cdp, names)).toEqual([
    "attribute",
    "button",
    "cleared",
    "listener",
    "mouseup",
    "once",
    "parent",
    "pointer",
    "property",
    "removed",
  ]);

  const attribute = [...names].find(([, name]) => name === "attribute")?.[0];
  const { nodes } = await cdp.send("Accessibility.getPartialAXTree", {
    backendNodeId: attribute,
    fetchRelatives: false,
  });
  const node = nodes.find((n) => n.backendDOMNodeId === attribute);
  expect(node && clickableProperty(node)?.value.value).toBe(true);
  await cdp.detach().catch(() => {});
}, 60_000);

test("an AX node stops being clickable when its last click listener goes", async ({ page }) => {
  await setContent(page, PAGE);
  const cdp = await page.createCDPSession();
  const names = await domNames(cdp);
  await page.evaluate(`
    document.getElementById("removed").removeEventListener("click", window.noop);
    document.getElementById("cleared").onclick = null;
    document.getElementById("once").click();
  `);
  expect(await flagged(cdp, names)).toEqual([
    "attribute",
    "button",
    "listener",
    "mouseup",
    "parent",
    "pointer",
    "property",
  ]);
  await cdp.detach().catch(() => {});
}, 60_000);

test("a handler attribute the page's policy refuses makes no node clickable", async ({ page }) => {
  const body = '<div id="attribute" onclick="void 0">Attribute</div>';
  await page.goto(
    "https://ks.invalid/__fixtures/policy-doc.html?csp=" +
      encodeURIComponent("script-src 'self'") +
      "&body=" +
      encodeURIComponent(body),
    { waitUntil: "load" },
  );
  const cdp = await page.createCDPSession();
  expect(await flagged(cdp, await domNames(cdp))).toEqual([]);
  await cdp.detach().catch(() => {});
}, 60_000);
