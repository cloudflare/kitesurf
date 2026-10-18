// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

var out = { events: [] };
function finish() {
  document.title = "XHRBOOT:" + JSON.stringify(out);
}
function step1(next) {
  var xhr = new XMLHttpRequest();
  xhr.open("GET", "/__fixtures/xhr-data.txt", true);
  xhr.onreadystatechange = function () { out.events.push("rsc" + xhr.readyState); };
  xhr.onloadstart = function () { out.events.push("loadstart"); };
  xhr.onload = function () {
    out.events.push("load");
    out.text = xhr.responseText;
    out.status = xhr.status;
    out.ctype = String(xhr.getResponseHeader("content-type") || "").indexOf("text/plain") === 0;
    out.responseUrlOk = xhr.responseURL.indexOf("/__fixtures/xhr-data.txt") !== -1;
    out.allHeadersOk = xhr.getAllResponseHeaders().indexOf("content-type") !== -1;
  };
  xhr.onerror = function () { out.events.push("error"); };
  xhr.onloadend = function () { out.events.push("loadend"); next(); };
  xhr.send(null);
  out.events.push("sent");
}
function step2(next) {
  // emscripten readAsync, shape verbatim (relative URL resolves
  // against the page, like the WAD preload does on doom).
  var xhr = new XMLHttpRequest();
  xhr.open("GET", "add.wasm", true);
  xhr.responseType = "arraybuffer";
  xhr.onload = function () {
    out.abStatus = xhr.status;
    out.abLen = xhr.response ? xhr.response.byteLength : -1;
    try { void xhr.responseText; out.rtGuard = "no-throw"; }
    catch (e) { out.rtGuard = e.name; }
    next();
  };
  xhr.onerror = function () { out.abLen = "error"; next(); };
  xhr.send(null);
}
function step3(next) {
  var xhr = new XMLHttpRequest();
  xhr.open("GET", "/__fixtures/definitely-not-here.bin", true);
  xhr.onload = function () {
    out.notFoundViaLoad = true;
    out.notFoundStatus = xhr.status;
    next();
  };
  xhr.onerror = function () { out.notFoundViaLoad = false; next(); };
  xhr.send(null);
}
step1(function () { step2(function () { step3(finish); }); });
