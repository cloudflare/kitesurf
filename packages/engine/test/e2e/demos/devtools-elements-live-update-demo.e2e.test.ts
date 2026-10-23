// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { env } from "cloudflare:test";

import { upgradedSocket } from "../connect";
import { expect, test } from "../harness";

async function connectPageMode() {
  const engine = env.ENGINE;
  const resp = await engine.fetch("https://ks.invalid/devtools/page/kitesurf", {
    headers: { Upgrade: "websocket" },
  });
  const ws = upgradedSocket(resp);
  if (!ws) throw new Error(`no webSocket on /devtools/page (status ${resp.status})`);
  ws.accept();
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  const replies = new Map<number, (v: { result?: never; error?: never }) => void>();
  ws.addEventListener("message", (ev: { data: string | ArrayBuffer }) => {
    const data = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data);
    const msg = JSON.parse(data);
    if (typeof msg.id === "number") {
      replies.get(msg.id)?.(msg);
      replies.delete(msg.id);
    } else if (typeof msg.method === "string") {
      events.push(msg);
    }
  });
  let nextId = 1;
  const send = (method: string, params: Record<string, unknown> = {}) => {
    const id = nextId++;
    // deno-lint-ignore no-explicit-any
    const p = new Promise<any>((resolve) => replies.set(id, resolve));
    ws.send(JSON.stringify({ id, method, params }));
    return p;
  };
  return { ws, send, events };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type PageModeConnection = Awaited<ReturnType<typeof connectPageMode>>;
type PageModeEvent = PageModeConnection["events"][number];
type DocumentResponse = {
  error?: unknown;
  result?: { root?: { nodeType?: number; nodeId?: number } };
};

function hasLoadEvent(events: PageModeEvent[], start: number): boolean {
  return events.slice(start).some((event) => event.method === "Page.loadEventFired");
}

function insertedNodeName(event: PageModeEvent): string | undefined {
  return (event.params?.node as { nodeName?: string } | undefined)?.nodeName;
}

function isInsertedNode(event: PageModeEvent, nodeName: string): boolean {
  return event.method === "DOM.childNodeInserted" && insertedNodeName(event) === nodeName;
}

function isAttributeModified(event: PageModeEvent, name: string): boolean {
  return (
    event.method === "DOM.attributeModified" && (event.params as { name?: string }).name === name
  );
}

function hasTimerMutationEvents(events: PageModeEvent[]): boolean {
  return (
    events.some((event) => isInsertedNode(event, "SPAN")) &&
    events.some((event) => isAttributeModified(event, "data-late")) &&
    events.some((event) => event.method === "Runtime.consoleAPICalled")
  );
}

function assertBlankDocumentResponse(response: DocumentResponse): void {
  expect(
    response.error,
    "pre-navigate DOM.getDocument must not error (DevTools caches the rejection): " +
      JSON.stringify(response.error ?? null),
  ).toBeUndefined();
  expect(response.result?.root?.nodeType).toBe(9);
}

function assertDocumentHasNodeId(response: DocumentResponse): void {
  expect(response.result?.root?.nodeId).toBeTypeOf("number");
}

async function prepareDevtoolsPage(client: PageModeConnection): Promise<void> {
  const { send, events } = client;
  await send("Page.enable");
  await send("Runtime.enable");
  await send("DOM.enable");
  const bootDoc = await send("DOM.getDocument");
  assertBlankDocumentResponse(bootDoc);

  const navigateEventStart = events.length;
  await send("Page.navigate", {
    url: "http://127.0.0.1:8787/__fixtures/events.html",
  });
  await expect
    .poll(() => hasLoadEvent(events, navigateEventStart), { timeout: 10_000 })
    .toBe(true)
    .catch(() => {});
  const doc = await send("DOM.getDocument");
  assertDocumentHasNodeId(doc);
}

async function verifyTimerMutationEvents(client: PageModeConnection): Promise<void> {
  const { send, events } = client;
  await send("Runtime.evaluate", {
    expression: `setTimeout(() => {
      const s = document.createElement("span");
      s.id = "late";
      s.textContent = "late-insert";
      document.body.appendChild(s);
      document.getElementById("hdr").setAttribute("data-late", "1");
      console.log("late-tick");
    }, 100)`,
  });
  await sleep(50);
  events.length = 0;
  await expect
    .poll(() => hasTimerMutationEvents(events), { timeout: 10_000 })
    .toBe(true)
    .catch(() => {});

  const methods = events.map((event) => event.method);
  const inserted = events.find((event) => event.method === "DOM.childNodeInserted");
  expect(
    inserted,
    `timer-driven childNodeInserted reached the root session; saw: ${JSON.stringify(methods)}`,
  ).toBeTruthy();
  const insertedNode = inserted?.params?.node as
    | { nodeName?: string; attributes?: string[] }
    | undefined;
  expect(insertedNode?.nodeName).toBe("SPAN");
  const lateAttr = events.find((event) => isAttributeModified(event, "data-late"));
  expect(
    lateAttr,
    `timer-driven attributeModified reached the root session; saw: ${JSON.stringify(methods)}`,
  ).toBeTruthy();
  const lateLog = events.find((event) => event.method === "Runtime.consoleAPICalled");
  expect(
    lateLog,
    `timer-driven consoleAPICalled reached the root session; saw: ${JSON.stringify(methods)}`,
  ).toBeTruthy();
}

async function verifyWebSocketMutationEvents(client: PageModeConnection): Promise<void> {
  const { send, events } = client;
  events.length = 0;
  await send("Runtime.evaluate", {
    expression: `(() => {
      const ws = new WebSocket("ws://" + location.host + "/__fixtures/ws-echo");
      ws.onopen = () => setTimeout(() => ws.send("invite-link-payload"), 300);
      ws.onmessage = (e) => {
        const a = document.createElement("a");
        a.id = "invite";
        a.href = "https://example.com/room/42";
        a.textContent = String(e.data);
        document.body.appendChild(a);
        ws.close();
      };
      return true;
    })()`,
  });
  await expect
    .poll(() => events.some((event) => isInsertedNode(event, "A")), { timeout: 10_000 })
    .toBe(true)
    .catch(() => {});
  const wsInsert = events.find((event) => isInsertedNode(event, "A"));
  expect(
    wsInsert,
    `ws.onmessage-driven childNodeInserted reached the root session; saw: ${JSON.stringify(events.map((event) => event.method))}`,
  ).toBeTruthy();
}

async function verifySynchronousMutationEvent(client: PageModeConnection): Promise<void> {
  const { send, events } = client;
  events.length = 0;
  await send("Runtime.evaluate", {
    expression: `document.getElementById("hdr").setAttribute("data-sync", "1")`,
  });
  await expect
    .poll(() => events.some((event) => isAttributeModified(event, "data-sync")), {
      timeout: 100,
      interval: 10,
    })
    .toBe(true)
    .catch(() => {});
  const syncAttr = events.find((event) => isAttributeModified(event, "data-sync"));
  expect(syncAttr, "evaluate-driven attributeModified still arrives").toBeTruthy();
}

test("devtools-elements-live-update-demo", async () => {
  const client = await connectPageMode();
  await prepareDevtoolsPage(client);
  await verifyTimerMutationEvents(client);
  await verifyWebSocketMutationEvents(client);
  await verifySynchronousMutationEvent(client);
  client.ws.close();
});

test("devtools page mode matches author rules after navigate", async () => {
  const { ws, send } = await connectPageMode();
  try {
    await send("Page.enable");
    await send("DOM.enable");
    await send("CSS.enable");
    await send("Page.navigate", {
      url: `data:text/html,${encodeURIComponent("<style>p.x{color:red}</style><p class=x>hi</p>")}`,
    });
    const doc = await send("DOM.getDocument");
    const { result: q } = await send("DOM.querySelector", {
      nodeId: doc.result.root.nodeId,
      selector: "p.x",
    });
    const r = await send("CSS.getMatchedStylesForNode", { nodeId: q.nodeId });
    const selectors = (
      r.result.matchedCSSRules as Array<{
        rule: { origin: string; selectorList: { text: string } };
      }>
    )
      .filter((m) => m.rule.origin === "regular")
      .map((m) => m.rule.selectorList.text);
    expect(selectors).toEqual(["p.x"]);
  } finally {
    ws.close();
  }
});
