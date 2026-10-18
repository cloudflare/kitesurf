// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

(function () {
  var out = (globalThis.__csOut = globalThis.__csOut || {});
  function describe(el) {
    if (!el) return null;
    return {
      src: el.getAttribute ? el.getAttribute("src") : null,
      isScriptEl: typeof HTMLScriptElement === "function" &&
        el instanceof HTMLScriptElement,
    };
  }
  out.syncRead = describe(document.currentScript);
  Promise.resolve().then(function () {
    out.microtaskRead = describe(document.currentScript);
  });
  var resolveGate;
  globalThis.__csGate = new Promise(function (r) { resolveGate = r; });
  globalThis.__csOpenGate = resolveGate;
  // Five thenable links: one await only drains the microtasks queued
  // before it, so this is what a shallow drain would miss.
  globalThis.__csGate
    .then(function () {})
    .then(function () {})
    .then(function () {})
    .then(function () {})
    .then(function () {
      out.deepRead = describe(document.currentScript);
    });
  setTimeout(function () {
    out.macrotaskRead = describe(document.currentScript);
    document.title = "CSMICRO:" + JSON.stringify(out);
  }, 0);
})();
