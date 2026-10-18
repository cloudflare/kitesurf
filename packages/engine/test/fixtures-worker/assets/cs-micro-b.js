// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

(function () {
  var out = (globalThis.__csOut = globalThis.__csOut || {});
  out.bSyncRead = document.currentScript
    ? document.currentScript.getAttribute("src")
    : null;
  if (globalThis.__csOpenGate) globalThis.__csOpenGate();
})();
