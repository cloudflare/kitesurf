// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, it } from "vitest";
import {
  drainInterception,
  ensureInterception,
  resolveParked,
  unregisterInterception,
} from "../src/cdp/fetch-interception.ts";
import { NetworkEventTracker } from "../src/cdp/network-events.ts";
import { registerTracker, unregisterTracker } from "../src/cdp/network-events-registry.ts";
import {
  SandboxOutbound,
  type CallerOutboundProps,
  type SandboxOutboundEnv,
} from "../src/eval/outbound.ts";

// Every case drives the real gateway; only the host transport is faked.
const gateway = (
  props: Omit<CallerOutboundProps, "pageOrigin">,
  request: Request,
  fetch: (request: Request) => Promise<Response>,
): Promise<Response> =>
  SandboxOutbound.handle(
    {} as SandboxOutboundEnv,
    { pageOrigin: "https://page.test", externalOutbound: { fetch }, ...props },
    request,
  );

const WRITE_LABELS: [string, Record<string, string>][] = [
  ["Image", {}],
  ["Stylesheet", {}],
  ["Script", { "x-kitesurf-script-cors": "no-cors" }],
];

it.each(WRITE_LABELS)("preflights a %s-labelled cross-origin write", async (type, labels) => {
  const seen: string[] = [];
  await gateway(
    {},
    new Request("https://other.test/asset", {
      method: "PUT",
      body: "{}",
      headers: {
        "x-kitesurf-resource-type": type,
        "x-kitesurf-allow-cross-origin": "1",
        "content-type": "application/json",
        ...labels,
      },
    }),
    async (req) => {
      seen.push(req.method);
      return new Response(null, { status: 204 });
    },
  );
  expect(seen).toEqual(["OPTIONS"]);
});

// A page can label any cross-origin read as a parser image, so the shell must not carry the
// origin's status: every unusable body is one failure.
const CAPTURE_CONNECTION = "withheld-image";

it.each([false, true])("withholds an unusable image's status (captured=%s)", async (capture) => {
  const tracker = new NetworkEventTracker(() => {}, CAPTURE_CONNECTION);
  if (capture) {
    tracker.setEnabled(undefined, true);
    registerTracker(CAPTURE_CONNECTION, tracker);
  }
  const response = await gateway(
    { connectionId: capture ? CAPTURE_CONNECTION : undefined },
    new Request("https://other.test/asset", {
      headers: { "x-kitesurf-resource-type": "Image", "x-kitesurf-allow-cross-origin": "1" },
    }),
    async () =>
      new Response("<html>not an image</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
  );
  tracker.dispose();
  expect(response.status).toBe(404);
  expect(await response.text()).toBe("");
  expect([...response.headers]).toEqual([]);
});

it("hides forbidden response headers from a page-realm response", async () => {
  const response = await gateway(
    { pageRealm: true },
    new Request("https://page.test/asset"),
    async () =>
      new Response("body", {
        headers: {
          "set-cookie": "secret=1; HttpOnly",
          "set-cookie2": "legacy=1",
          "x-allowed": "yes",
        },
      }),
  );
  expect(response.headers.getSetCookie()).toEqual([]);
  expect(response.headers.get("set-cookie2")).toBeNull();
  expect(response.headers.get("x-allowed")).toBe("yes");
  expect(await response.text()).toBe("body");
});

it("hides forbidden headers on a page-realm upgrade and keeps the socket", async () => {
  const response = await gateway(
    { pageRealm: true },
    new Request("https://page.test/socket", { headers: { Upgrade: "websocket" } }),
    async () =>
      new Response(null, {
        status: 101,
        webSocket: new WebSocketPair()[1],
        headers: { "set-cookie": "secret=1" },
      }),
  );
  expect(response.status).toBe(101);
  expect(response.webSocket).toBeTruthy();
  expect(response.headers.get("set-cookie")).toBeNull();
});

it.each(["same-origin", "same-site"])("enforces %s CORP on a tainted script", async (policy) => {
  const response = await SandboxOutbound.handle(
    {} as SandboxOutboundEnv,
    {
      pageOrigin: "https://attacker.test",
      externalOutbound: {
        fetch: async () =>
          new Response("private()", {
            headers: { "cross-origin-resource-policy": policy },
          }),
      },
    },
    new Request("https://victim.test/script.js", {
      headers: {
        "x-kitesurf-page-origin": "null",
        "x-kitesurf-resource-type": "Script",
        "x-kitesurf-script-cors": "no-cors",
        "x-kitesurf-allow-cross-origin": "1",
      },
    }),
  );
  expect(response.status).toBe(403);
  expect(response.headers.get("x-kitesurf-blocked")).toBe("cors");
});

// A page names its requests with x-kitesurf-network-id; interception must pair requestPaused
// with the Network request the engine started, while a document walk keeps its loader id.
const INTERCEPTION_CONNECTION = "interception-id";

async function interceptedRequest(
  props: Omit<CallerOutboundProps, "pageOrigin">,
  headers: Record<string, string>,
) {
  const st = ensureInterception(INTERCEPTION_CONNECTION);
  st.patterns = [{ re: /.*/ }];
  const paused: string[] = [];
  st.emit = (ev) => {
    paused.push(ev.networkId ?? "");
    resolveParked(st, ev.requestId, { kind: "fail", errorReason: "Aborted" });
  };
  const tracked: string[] = [];
  const tracker = new NetworkEventTracker((ev) => {
    if (ev.method === "Network.requestWillBeSent") tracked.push(ev.params.requestId);
  }, INTERCEPTION_CONNECTION);
  tracker.setEnabled(undefined, true);
  registerTracker(INTERCEPTION_CONNECTION, tracker);
  // A reached transport resolves instead of rejecting, so `rejected` also proves no egress.
  const settled = gateway(
    props,
    new Request("https://page.test/routed", {
      headers: { "x-kitesurf-resource-type": "Fetch", ...headers },
    }),
    async () => new Response("reached"),
  ).then(
    () => false,
    () => true,
  );
  while (st.parked.size === 0) await new Promise((r) => setTimeout(r, 0));
  drainInterception(INTERCEPTION_CONNECTION);
  const rejected = await settled;
  tracker.drain();
  tracker.dispose();
  unregisterTracker(INTERCEPTION_CONNECTION);
  unregisterInterception(INTERCEPTION_CONNECTION);
  return { networkId: paused[0] ?? "", tracked: tracked[0], rejected };
}

it("pairs a page request with its tracked network id, not a forged header", async () => {
  const page = await interceptedRequest(
    { pageRealm: true, connectionId: INTERCEPTION_CONNECTION },
    { "x-kitesurf-network-id": "forged" },
  );
  expect(page.networkId).toBe(page.tracked);
  expect(page.rejected).toBe(true);
  // The engine's own document walk still pairs through its loader id header.
  const doc = await interceptedRequest(
    { interceptConnectionId: INTERCEPTION_CONNECTION },
    { "x-kitesurf-network-id": "loader-1" },
  );
  expect(doc.networkId).toBe("loader-1");
});
