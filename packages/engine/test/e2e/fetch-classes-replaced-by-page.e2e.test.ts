// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A page may replace fetch, Headers, Request and Response with a polyfill's classes; the
// browser's own XMLHttpRequest and fetch must still send the headers and body they were given.

import { expect, test } from "./harness";

const ORIGIN = "https://ks.invalid";
const ECHO = "/__fixtures/echo-request.json";

const PAGE_SCRIPT = `<script>
  var nativeFetch = fetch, NativeRequest = Request, NativeResponse = Response;
  function PolyHeaders(init) {
    this.map = {};
    for (var k in init || {}) this.map[k.toLowerCase()] = String(init[k]);
  }
  function PolyRequest(input, init) {
    init = init || {};
    this.url = String(input);
    this.method = init.method || "GET";
    this.headers = new PolyHeaders(init.headers);
    this._bodyInit = init.body;
  }
  function PolyResponse(body) { this._bodyInit = body; }
  window.Headers = PolyHeaders;
  window.Request = PolyRequest;
  window.Response = PolyResponse;
  window.fetch = function polyFetch() { return Promise.reject(new Error("page fetch")); };
  var failed = function (e) { return "failed: " + e; };
  var echoOf = function (r) { return r.json(); };
  var xhr = new Promise(function (resolve) {
    var x = new XMLHttpRequest();
    x.open("POST", "${ECHO}");
    x.setRequestHeader("Content-Type", "application/json");
    x.setRequestHeader("X-Probe", "xhr");
    x.onload = function () { resolve(JSON.parse(x.responseText)); };
    x.onerror = function () { resolve("failed: error event"); };
    try { x.send('{"q":"xhr"}'); } catch (e) { resolve(failed(e)); }
  });
  var withInit = nativeFetch("${ECHO}", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Probe": "init" },
    body: '{"q":"init"}',
  }).then(echoOf, failed);
  var withRequest = nativeFetch(new NativeRequest("${ECHO}", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Probe": "request" },
    body: '{"q":"request"}',
  })).then(echoOf, failed);
  var opaque = nativeFetch("https://ks-alt.invalid/__fixtures/echo-headers.json", {
    mode: "no-cors",
  }).then(function (r) { return [r.type, r instanceof NativeResponse]; }, failed);
  Promise.all([xhr, withInit, withRequest, opaque]).then(function (r) { window.__sent = r; });
</script>`;

interface Echo {
  method: string;
  headers: Record<string, string>;
  body: string;
}

function wire(echo: Echo | string): unknown {
  if (typeof echo === "string") return echo;
  const { method, headers, body } = echo;
  return { method, contentType: headers["content-type"], probe: headers["x-probe"], body };
}

test("replaced fetch classes do not change what XHR and fetch send", async ({ page }) => {
  const url = new URL(`${ORIGIN}/__fixtures/policy-doc.html`);
  url.searchParams.set("body", PAGE_SCRIPT);
  await page.goto(url.href, { waitUntil: "load" });
  await page.waitForFunction("window.__sent !== undefined", { timeout: 15_000 });
  const raw: unknown = await page.evaluate("window.__sent");
  const [xhr, withInit, withRequest, opaque] = raw as [Echo, Echo, Echo, unknown];

  const sent = (probe: string) => ({
    method: "POST",
    contentType: "application/json",
    probe,
    body: `{"q":"${probe}"}`,
  });
  expect({
    xhr: wire(xhr),
    withInit: wire(withInit),
    withRequest: wire(withRequest),
    opaque,
  }).toEqual({
    xhr: sent("xhr"),
    withInit: sent("init"),
    withRequest: sent("request"),
    opaque: ["opaque", true],
  });
});
