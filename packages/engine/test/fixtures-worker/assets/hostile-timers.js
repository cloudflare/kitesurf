// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

(function () {
  globalThis.__ks_hostileDropped = 0;
  globalThis.setTimeout = function () {
    globalThis.__ks_hostileDropped++;
    return 0;
  };
  globalThis.setInterval = function () { return 0; };
  globalThis.clearTimeout = function () {};
  globalThis.clearInterval = function () {};
  document.title = "HOSTILE_TIMERS_INSTALLED";
})();
